package session

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func taskOrderingRow(id, status string, clock any) map[string]any {
	return map[string]any{"task_id": id, "status": status, "updated_at": clock, "name": status}
}

func taskOrderingSnapshot(rows ...map[string]any) map[string]any {
	if rows == nil {
		rows = []map[string]any{}
	}
	return map[string]any{"tasks": rows}
}

func taskOrderingRows(t *testing.T, raw json.RawMessage) []map[string]any {
	t.Helper()
	var doc struct {
		Tasks []map[string]any `json:"tasks"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("decode tasks: %v (%s)", err, raw)
	}
	return doc.Tasks
}

func assertTaskOrdering(t *testing.T, summary Summary, want ...map[string]any) {
	t.Helper()
	got := taskOrderingRows(t, summary.ActivityPair.Task)
	normalized, _ := json.Marshal(want)
	var expected []map[string]any
	if err := json.Unmarshal(normalized, &expected); err != nil {
		t.Fatal(err)
	}
	byID := func(rows []map[string]any) map[string]map[string]any {
		out := make(map[string]map[string]any)
		for _, row := range rows {
			id, ok := row["task_id"].(string)
			if !ok {
				t.Fatalf("invalid projected task row: %v", row)
			}
			out[id] = row
		}
		return out
	}
	if !reflect.DeepEqual(byID(got), byID(expected)) {
		t.Errorf("task authority: got=%s want=%s", summary.ActivityPair.Task, normalized)
	}
	if summary.TaskDigest == nil {
		t.Fatal("missing task digest")
	}
	if len(summary.TaskDigest.Tasks) != len(want) {
		t.Fatalf("digest membership: %+v want %d", summary.TaskDigest, len(want))
	}
	data, err := json.Marshal(summary.TaskDigest)
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range taskOrderingRows(t, data) {
		expected := byID(want)[row["task_id"].(string)]
		if expected == nil {
			t.Errorf("unexpected digest row: %v", row)
			continue
		}
		for _, key := range []string{"status", "raw_status"} {
			if row[key] != expected[key] {
				t.Errorf("digest %s: %v want %v", key, row[key], expected[key])
			}
		}
		if clock, ok := expected["updated_at"].(string); ok && clock != "" && row["updated_at"] != clock {
			t.Errorf("digest clock: %v want %v", row, clock)
		}
	}
}

func TestTaskStateOrdering(t *testing.T) {
	for _, mode := range []string{"bound", "unbound", "transfer"} {
		t.Run(mode, func(t *testing.T) {
			for _, tc := range []struct {
				name          string
				current, next any
				accept        bool
			}{
				{"older", dagCurrent, dagOlder, false}, {"equal", dagCurrent, dagCurrent, false},
				{"offset", dagCurrent, "2026-09-07T12:02:00+02:00", false},
				{"millisecond", dagCurrent, "2026-09-07T10:02:00.000999Z", false},
				{"null", dagCurrent, nil, false}, {"number", dagCurrent, 123, false},
				{"array", dagCurrent, []any{}, false}, {"object", dagCurrent, map[string]any{}, false},
				{"bool", dagCurrent, true, false}, {"empty", dagCurrent, "", false},
				{"calendar", dagCurrent, "2026-02-30T10:03:00Z", false},
				{"bad_offset", dagCurrent, "2026-09-07T10:03:00+24:00", false},
				{"missing_zone", dagCurrent, "2026-09-07T10:03:00", false},
				{"PIN_newer_revival", dagCurrent, dagNewer, true},
				{"PIN_unknown_to_known", "", dagCurrent, true},
				{"PIN_both_unknown", "", "invalid", true},
			} {
				t.Run(tc.name, func(t *testing.T) {
					h := newDAGOrderingHarness(t, mode)
					current, next := taskOrderingRow("t", "completed", tc.current), taskOrderingRow("t", "running", tc.next)
					h.emit(t, activitySnapshotOrder[0], taskOrderingSnapshot(current))
					if mode == "transfer" {
						h.bind()
					}
					h.emit(t, activitySnapshotOrder[0], taskOrderingSnapshot(next))
					if tc.accept {
						current = next
					}
					assertTaskOrdering(t, h.summary(), current)
				})
			}
			t.Run("missing_clock_membership", func(t *testing.T) {
				h := newDAGOrderingHarness(t, mode)
				row := taskOrderingRow("t", "running", dagCurrent)
				h.emit(t, activitySnapshotOrder[0], taskOrderingSnapshot(row))
				if mode == "transfer" {
					h.bind()
				}
				next := taskOrderingRow("t", "failed", nil)
				delete(next, "updated_at")
				h.emit(t, activitySnapshotOrder[0], taskOrderingSnapshot(next))
				assertTaskOrdering(t, h.summary(), row)
			})
			t.Run("correction_replay_revival_and_new_evidence", func(t *testing.T) {
				h := newDAGOrderingHarness(t, mode)
				row := taskOrderingRow("task-r", "running", dagOlder)
				h.emit(t, activitySnapshotOrder[0], taskOrderingSnapshot(row))
				dag := dagOrderingSnapshot(dagOrderingRun("r", "completed", dagCurrent))
				h.emit(t, activitySnapshotOrder[1], dag)
				if mode == "transfer" {
					h.bind()
				}
				corrected := taskOrderingRow("task-r", "running", dagOlder)
				corrected["status"], corrected["raw_status"] = "completed", "running"
				assertTaskOrdering(t, h.summary(), corrected)
				h.emit(t, activitySnapshotOrder[0], taskOrderingSnapshot(row))
				assertTaskOrdering(t, h.summary(), corrected)
				revived := taskOrderingRow("task-r", "running", dagNewer)
				h.emit(t, activitySnapshotOrder[0], taskOrderingSnapshot(revived))
				h.emit(t, activitySnapshotOrder[1], dag)
				// Accepting an unrelated run must not turn the replayed r row into evidence.
				h.emit(t, activitySnapshotOrder[1], dagOrderingSnapshot(dagOrderingRun("r", "completed", dagCurrent), dagOrderingRun("other", "running", dagNewer)))
				if !h.unbound {
					injectEvent(t, h.s, map[string]any{"type": "agent_start"})
					injectEvent(t, h.s, map[string]any{"type": "agent_settled", "reason": "end_turn"})
				}
				assertTaskOrdering(t, h.summary(), revived)
				h.emit(t, activitySnapshotOrder[1], dagOrderingSnapshot(dagOrderingRun("r", "failed", dagNewer)))
				revived["status"], revived["raw_status"] = "failed", "running"
				assertTaskOrdering(t, h.summary(), revived)
				h.emit(t, activitySnapshotOrder[1], dagOrderingSnapshot(dagOrderingRun("r", "completed", "2026-09-07T10:04:00Z")))
				assertTaskOrdering(t, h.summary(), revived)
			})
			t.Run("PIN_same_raw_correction_frozen", func(t *testing.T) {
				h := newDAGOrderingHarness(t, mode)
				raw := taskOrderingRow("task-r", "running", dagOlder)
				h.emit(t, activitySnapshotOrder[0], taskOrderingSnapshot(raw))
				fallback := dagOrderingRun("r", "completed", dagCurrent)
				fallback["nodes"] = []any{map[string]any{"task_id": "task-r", "state": "running"}}
				h.emit(t, activitySnapshotOrder[1], dagOrderingSnapshot(fallback))
				if mode == "transfer" {
					h.bind()
				}
				// Even a newer explicit node outcome cannot replace an already
				// bound fallback at the same raw revision: the wire has no
				// derived-outcome revision with which clients could order it.
				conflict := dagOrderingRun("r", "failed", dagNewer)
				h.emit(t, activitySnapshotOrder[1], dagOrderingSnapshot(conflict))
				h.emit(t, activitySnapshotOrder[0], taskOrderingSnapshot(raw))
				if !h.unbound {
					injectEvent(t, h.s, map[string]any{"type": "agent_start"})
					injectEvent(t, h.s, map[string]any{"type": "agent_settled", "reason": "end_turn"})
				}
				corrected := taskOrderingRow("task-r", "running", dagOlder)
				corrected["status"], corrected["raw_status"] = "completed", "running"
				assertTaskOrdering(t, h.summary(), corrected)

				revived := taskOrderingRow("task-r", "running", "2026-09-07T10:04:00Z")
				h.emit(t, activitySnapshotOrder[0], taskOrderingSnapshot(revived))
				h.emit(t, activitySnapshotOrder[1], dagOrderingSnapshot(conflict))
				assertTaskOrdering(t, h.summary(), revived)
				h.emit(t, activitySnapshotOrder[1], dagOrderingSnapshot(dagOrderingRun("r", "failed", "2026-09-07T10:04:00Z")))
				revived["status"], revived["raw_status"] = "failed", "running"
				assertTaskOrdering(t, h.summary(), revived)
			})
			t.Run("uncorrected_revival_invalidates_observed_evidence", func(t *testing.T) {
				h := newDAGOrderingHarness(t, mode)
				h.emit(t, activitySnapshotOrder[1], dagOrderingSnapshot(dagOrderingRun("r", "completed", dagCurrent)))
				h.emit(t, activitySnapshotOrder[0], taskOrderingSnapshot(taskOrderingRow("task-r", "running", dagOlder)))
				if mode == "transfer" {
					h.bind()
				}
				row := taskOrderingRow("task-r", "running", dagNewer)
				h.emit(t, activitySnapshotOrder[0], taskOrderingSnapshot(row))
				h.emit(t, activitySnapshotOrder[1], dagOrderingSnapshot(dagOrderingRun("r", "completed", dagCurrent)))
				if !h.unbound {
					injectEvent(t, h.s, map[string]any{"type": "agent_start"})
					injectEvent(t, h.s, map[string]any{"type": "agent_settled", "reason": "end_turn"})
				}
				assertTaskOrdering(t, h.summary(), row)
			})
			for _, partial := range []bool{false, true} {
				t.Run(fmt.Sprintf("omission_partial_%v", partial), func(t *testing.T) {
					h := newDAGOrderingHarness(t, mode)
					row := taskOrderingRow("t", "running", dagCurrent)
					terminal := taskOrderingRow("done", "completed", dagCurrent)
					h.emit(t, activitySnapshotOrder[0], taskOrderingSnapshot(row, terminal))
					empty := taskOrderingSnapshot()
					empty["truncated_tasks"] = partial
					h.emit(t, activitySnapshotOrder[0], empty)
					if mode == "transfer" {
						h.bind()
					}
					for _, stamp := range []string{dagOlder, dagCurrent} {
						h.emit(t, activitySnapshotOrder[0], taskOrderingSnapshot(taskOrderingRow("t", "failed", stamp)))
						if partial {
							assertTaskOrdering(t, h.summary(), row, terminal)
						} else {
							assertTaskOrdering(t, h.summary(), terminal)
						}
					}
					newer := taskOrderingRow("t", "running", dagNewer)
					h.emit(t, activitySnapshotOrder[0], taskOrderingSnapshot(newer))
					assertTaskOrdering(t, h.summary(), newer, terminal)
				})
			}
			t.Run("malformed_row_is_partial_not_clear", func(t *testing.T) {
				h := newDAGOrderingHarness(t, mode)
				row := taskOrderingRow("t", "running", dagCurrent)
				h.emit(t, activitySnapshotOrder[0], taskOrderingSnapshot(row))
				if mode == "transfer" {
					h.bind()
				}
				other := taskOrderingRow("other", "running", dagNewer)
				h.emit(t, activitySnapshotOrder[0], taskOrderingSnapshot(map[string]any{}, other))
				assertTaskOrdering(t, h.summary(), row, other)
				if !h.summary().TaskDigest.Truncated {
					t.Error("structural row loss must disclose partial membership")
				}
			})
			t.Run("duplicates_choose_whole_winner", func(t *testing.T) {
				h := newDAGOrderingHarness(t, mode)
				row := taskOrderingRow("t", "completed", dagCurrent)
				h.emit(t, activitySnapshotOrder[0], taskOrderingSnapshot(row, taskOrderingRow("t", "running", dagOlder), taskOrderingRow("t", "failed", dagCurrent)))
				if mode == "transfer" {
					h.bind()
				}
				assertTaskOrdering(t, h.summary(), row)
			})
			t.Run("untrusted_provenance", func(t *testing.T) {
				h := newDAGOrderingHarness(t, mode)
				row := taskOrderingRow("t", "running", dagCurrent)
				row["raw_status"] = "pending"
				h.emit(t, activitySnapshotOrder[0], taskOrderingSnapshot(row))
				if mode == "transfer" {
					h.bind()
				}
				delete(row, "raw_status")
				assertTaskOrdering(t, h.summary(), row)
			})
			t.Run("oversized_authority_and_equal_rich_enrichment", func(t *testing.T) {
				h := newDAGOrderingHarness(t, mode)
				h.emit(t, activitySnapshotOrder[0], taskOrderingSnapshot(taskOrderingRow("task-r", "running", dagOlder)))
				large := taskOrderingRow("task-r", "running", dagCurrent)
				large["padding"] = strings.Repeat("x", maxActivitySnapshotBytes)
				h.emit(t, activitySnapshotOrder[0], taskOrderingSnapshot(large))
				h.emit(t, activitySnapshotOrder[1], dagOrderingSnapshot(dagOrderingRun("r", "completed", dagCurrent)))
				if mode == "transfer" {
					h.bind()
				}
				h.emit(t, activitySnapshotOrder[0], taskOrderingSnapshot(taskOrderingRow("task-r", "running", dagOlder)))
				summary := h.summary()
				if len(summary.ActivityPair.Task) != 0 || !summary.TaskOversized {
					t.Errorf("obsolete rich task replay: %s oversized=%v", summary.ActivityPair.Task, summary.TaskOversized)
				}
				if summary.TaskDigest == nil || len(summary.TaskDigest.Tasks) != 1 || summary.TaskDigest.Tasks[0].Status != "completed" || summary.TaskDigest.Tasks[0].UpdatedAt != dagCurrent {
					t.Fatalf("compact authority lost: %+v", summary.TaskDigest)
				}
				rich := taskOrderingRow("task-r", "running", dagCurrent)
				h.emit(t, activitySnapshotOrder[0], taskOrderingSnapshot(rich))
				rich["status"], rich["raw_status"] = "completed", "running"
				assertTaskOrdering(t, h.summary(), rich)
				if !h.summary().TaskDigest.Truncated {
					t.Error("equal envelope cleared partial disclosure")
				}
			})
			t.Run("bounds", func(t *testing.T) {
				h := newDAGOrderingHarness(t, mode)
				rows := make([]map[string]any, maxActivityDigestEntries+10)
				for i := range rows {
					rows[i] = taskOrderingRow(fmt.Sprintf("t-%d", i), "running", dagCurrent)
				}
				h.emit(t, activitySnapshotOrder[0], taskOrderingSnapshot(rows...))
				if mode == "transfer" {
					h.bind()
				}
				summary := h.summary()
				if len(summary.TaskDigest.Tasks) > maxActivityDigestEntries || !summary.TaskDigest.Truncated {
					t.Fatalf("unbounded digest: %d truncated=%v", len(summary.TaskDigest.Tasks), summary.TaskDigest.Truncated)
				}
				if len(summary.ActivityPair.Task) > maxActivitySnapshotBytes {
					t.Error("unbounded replay")
				}
			})
		})
	}
	t.Run("PIN_dag_before_task_settlement", TestAgentSettleReconcilesTaskSnapshotArrivingAfterTerminalDag)
	t.Run("PIN_terminal_node_and_raw_terminal", func(t *testing.T) {
		h := newDAGOrderingHarness(t, "bound")
		running, done := taskOrderingRow("task-r", "running", dagOlder), taskOrderingRow("done", "cancelled", dagOlder)
		h.emit(t, activitySnapshotOrder[0], taskOrderingSnapshot(running, done))
		run := dagOrderingRun("r", "failed", dagCurrent)
		run["nodes"] = []any{map[string]any{"task_id": "task-r", "state": "completed"}, map[string]any{"task_id": "done", "state": "completed"}}
		h.emit(t, activitySnapshotOrder[1], dagOrderingSnapshot(run))
		if activityTaskStatus(t, h.summary().ActivityPair.Task, "task-r") != "completed" || activityTaskStatus(t, h.summary().ActivityPair.Task, "done") != "cancelled" {
			t.Fatal("terminal precedence changed")
		}
	})
	t.Run("heartbeat_does_not_raise_raw_revision", func(t *testing.T) {
		h := newDAGOrderingHarness(t, "bound")
		h.emit(t, activitySnapshotOrder[0], taskOrderingSnapshot(taskOrderingRow("t", "running", dagOlder)))
		h.emit(t, "omo.dag.activity", map[string]any{"task_id": "t", "at": "2026-09-07T10:04:00Z", "current_tool": "read"})
		row := taskOrderingRow("t", "completed", dagNewer)
		h.emit(t, activitySnapshotOrder[0], taskOrderingSnapshot(row))
		assertTaskOrdering(t, h.summary(), row)
	})
	t.Run("attached_correction_and_settlement_publication", func(t *testing.T) {
		for _, early := range []bool{false, true} {
			t.Run(fmt.Sprint(early), func(t *testing.T) {
				h := newDAGOrderingHarness(t, "bound")
				r := newRecorder(32)
				detach := h.s.Attach(r)
				defer detach()
				injectEvent(t, h.s, map[string]any{"type": "agent_start"})
				if early {
					h.emit(t, activitySnapshotOrder[1], dagOrderingSnapshot(dagOrderingRun("r", "completed", dagCurrent)))
				}
				h.emit(t, activitySnapshotOrder[0], taskOrderingSnapshot(taskOrderingRow("task-r", "running", dagOlder)))
				if !early {
					h.emit(t, activitySnapshotOrder[1], dagOrderingSnapshot(dagOrderingRun("r", "completed", dagCurrent)))
				}
				injectEvent(t, h.s, map[string]any{"type": "agent_settled", "reason": "end_turn"})
				before, _ := r.await(t, FrameRunDone)
				var latest json.RawMessage
				for _, f := range before {
					if f.Kind != FrameExtensionEvent {
						continue
					}
					doc := f.Data.(map[string]any)
					if doc["name"] == activitySnapshotOrder[0] {
						latest, _ = json.Marshal(doc["data"])
					}
				}
				rows := taskOrderingRows(t, latest)
				if len(rows) != 1 || rows[0]["status"] != "completed" || rows[0]["raw_status"] != "running" || rows[0]["updated_at"] != dagOlder {
					t.Fatalf("no corrected attached projection: %s", latest)
				}
			})
		}
	})
	t.Run("PIN_epoch_transfer_rejects_other_epoch", func(t *testing.T) {
		h := newDAGOrderingHarness(t, "unbound")
		h.emit(t, activitySnapshotOrder[0], taskOrderingSnapshot(taskOrderingRow("t", "completed", dagCurrent)))
		client := dial(t, newDaemon(t))
		h.s.epoch, _ = client.CurrentEpoch()
		h.bind()
		if h.summary().TaskDigest != nil {
			t.Fatal("cross-epoch task transfer")
		}
	})
	t.Run("history_digest_before_rich_packing", func(t *testing.T) {
		cwd := t.TempDir()
		for i := 0; i < 120; i++ {
			row := taskOrderingRow(fmt.Sprintf("t-%03d", i), "completed", dagCurrent)
			row["parent_session_id"], row["task_summary"], row["created_at"] = "parent", strings.Repeat("x", 512), fmt.Sprintf("2026-09-07T10:%02d:%02dZ", i/60, i%60)
			row["raw_status"] = "running"
			writeActivityStoreJSON(t, filepath.Join(cwd, ".omo", "senpi-task", "tasks", fmt.Sprintf("%03d.json", i)), row)
		}
		result, err := ReadHistoricalActivity(t.Context(), cwd, "parent")
		if err != nil {
			t.Fatal(err)
		}
		if len(result.TaskDigest.Tasks) != 120 {
			t.Fatalf("rich packing discarded compact rows: %d", len(result.TaskDigest.Tasks))
		}
		if !result.TaskOversized || len(result.ActivityPair.Task) > maxActivitySnapshotBytes || len(taskOrderingRows(t, result.ActivityPair.Task)) >= 120 {
			t.Fatal("rich bound not exercised")
		}
		for _, row := range taskOrderingRows(t, result.ActivityPair.Task) {
			if _, exists := row["raw_status"]; exists {
				t.Fatal("store provenance trusted")
			}
		}
	})
}

func TestTaskStateOrderingEvidence(t *testing.T) {
	t.Run("newer_nonterminal_dag_retires_unbound_outcome", func(t *testing.T) {
		h := newDAGOrderingHarness(t, "unbound")
		h.emit(t, activitySnapshotOrder[1], dagOrderingSnapshot(dagOrderingRun("r", "completed", dagOlder)))
		h.emit(t, activitySnapshotOrder[1], dagOrderingSnapshot(dagOrderingRun("r", "running", dagCurrent)))
		h.emit(t, activitySnapshotOrder[0], taskOrderingSnapshot(taskOrderingRow("task-r", "running", dagOlder)))
		h.bind()
		injectEvent(t, h.s, map[string]any{"type": "agent_start"})
		injectEvent(t, h.s, map[string]any{"type": "agent_settled", "reason": "end_turn"})
		assertTaskOrdering(t, h.summary(), taskOrderingRow("task-r", "running", dagOlder))
	})
	t.Run("explicit_node_beats_later_run_fallback", func(t *testing.T) {
		h := newDAGOrderingHarness(t, "bound")
		explicit := dagOrderingRun("r", "failed", dagOlder)
		explicit["nodes"] = []any{map[string]any{"task_id": "task-r", "state": "completed"}}
		h.emit(t, activitySnapshotOrder[1], dagOrderingSnapshot(explicit))
		fallback := dagOrderingRun("other", "failed", dagCurrent)
		fallback["nodes"] = []any{map[string]any{"task_id": "task-r", "state": "running"}}
		h.emit(t, activitySnapshotOrder[1], dagOrderingSnapshot(explicit, fallback))
		h.emit(t, activitySnapshotOrder[0], taskOrderingSnapshot(taskOrderingRow("task-r", "running", dagOlder)))
		injectEvent(t, h.s, map[string]any{"type": "agent_start"})
		injectEvent(t, h.s, map[string]any{"type": "agent_settled", "reason": "end_turn"})
		row := taskOrderingRow("task-r", "running", dagOlder)
		row["status"], row["raw_status"] = "completed", "running"
		assertTaskOrdering(t, h.summary(), row)
	})
	t.Run("oversized_input_cannot_omit_running_tasks", func(t *testing.T) {
		h := newDAGOrderingHarness(t, "bound")
		row := taskOrderingRow("t", "running", dagCurrent)
		h.emit(t, activitySnapshotOrder[0], taskOrderingSnapshot(row))
		huge := taskOrderingSnapshot()
		huge["padding"] = strings.Repeat("x", maxActivitySnapshotBytes)
		h.emit(t, activitySnapshotOrder[0], huge)
		if h.summary().TaskDigest == nil || len(h.summary().TaskDigest.Tasks) != 1 {
			t.Fatalf("oversized omission removed task: %+v", h.summary().TaskDigest)
		}
	})
	t.Run("unrepresentable_digest_row_does_not_hide_other_ids", func(t *testing.T) {
		h := newDAGOrderingHarness(t, "bound")
		huge := taskOrderingRow(strings.Repeat("x", maxActivitySnapshotBytes), "running", dagCurrent)
		h.emit(t, activitySnapshotOrder[0], taskOrderingSnapshot(huge, taskOrderingRow("kept", "running", dagCurrent)))
		summary := h.summary()
		if summary.TaskDigest == nil || len(summary.TaskDigest.Tasks) != 1 || summary.TaskDigest.Tasks[0].TaskID != "kept" || !summary.TaskDigest.Truncated {
			t.Fatalf("digest fit rows lost: %+v", summary.TaskDigest)
		}
	})
	t.Run("history_preserves_exact_long_identity_and_clock", func(t *testing.T) {
		cwd := t.TempDir()
		id, clock := strings.Repeat("id", 300), strings.Repeat("0", 600)
		row := taskOrderingRow(id, "running", clock)
		row["parent_session_id"] = "parent"
		writeActivityStoreJSON(t, filepath.Join(cwd, ".omo", "senpi-task", "tasks", "t.json"), row)
		result, err := ReadHistoricalActivity(t.Context(), cwd, "parent")
		if err != nil {
			t.Fatal(err)
		}
		if len(result.TaskDigest.Tasks) != 1 || result.TaskDigest.Tasks[0].TaskID != id || result.TaskDigest.Tasks[0].UpdatedAt != clock {
			t.Fatalf("authority scalars shortened: %+v", result.TaskDigest)
		}
	})
	t.Run("overview_and_attached_publish_same_correction", func(t *testing.T) {
		h := newDAGOrderingHarness(t, "bound")
		h.m.mu.Lock()
		h.m.byRoute[h.s.routingID] = h.s
		h.m.mu.Unlock()
		updates := make(chan Summary, 8)
		_, unsubscribe := h.m.SubscribeActivity(true, nil, func(s Summary, _ bool) { updates <- s })
		defer unsubscribe()
		r := newRecorder(16)
		detach := h.s.Attach(r)
		defer detach()
		h.emit(t, activitySnapshotOrder[0], taskOrderingSnapshot(taskOrderingRow("task-r", "running", dagOlder)))
		h.emit(t, activitySnapshotOrder[1], dagOrderingSnapshot(dagOrderingRun("r", "completed", dagCurrent)))
		injectEvent(t, h.s, map[string]any{"type": "state_changed"})
		frames, _ := r.await(t, FrameState)
		var attached json.RawMessage
		for _, frame := range frames {
			if frame.Kind != FrameExtensionEvent {
				continue
			}
			data := frame.Data.(map[string]any)
			if data["name"] == activitySnapshotOrder[0] {
				attached, _ = json.Marshal(data["data"])
			}
		}
		deadline := time.NewTimer(testTimeout)
		defer deadline.Stop()
		for {
			select {
			case summary := <-updates:
				if summary.TaskDigest != nil && len(summary.TaskDigest.Tasks) == 1 && summary.TaskDigest.Tasks[0].Status == "completed" {
					row := taskOrderingRow("task-r", "running", dagOlder)
					row["status"], row["raw_status"] = "completed", "running"
					assertTaskOrdering(t, summary, row)
					if !reflect.DeepEqual(taskOrderingRows(t, attached), taskOrderingRows(t, summary.ActivityPair.Task)) {
						t.Fatalf("attached and overview diverged: attached=%s overview=%s", attached, summary.ActivityPair.Task)
					}
					return
				}
			case <-deadline.C:
				t.Fatal("no corrected overview publication")
			}
		}
	})
}

func TestTaskStateOrderingBoundary(t *testing.T) {
	t.Run("malformed_initial_snapshot_cannot_supply_provenance", func(t *testing.T) {
		h := newDAGOrderingHarness(t, "bound")
		row := taskOrderingRow("t", "completed", dagCurrent)
		row["raw_status"] = "running"
		data := taskOrderingSnapshot(row)
		data["truncated_tasks"] = nil
		h.emit(t, activitySnapshotOrder[0], data)
		if h.summary().TaskDigest != nil || len(h.summary().ActivityPair.Task) != 0 {
			t.Fatalf("malformed initial task side became authority: %s", h.summary().ActivityPair.Task)
		}
	})
	t.Run("history_malformed_record_discloses_partial", func(t *testing.T) {
		cwd := t.TempDir()
		writeActivityStoreJSON(t, filepath.Join(cwd, ".omo", "senpi-task", "tasks", "bad.json"), map[string]any{"parent_session_id": "parent", "task_id": "t"})
		result, err := ReadHistoricalActivity(t.Context(), cwd, "parent")
		if err != nil {
			t.Fatal(err)
		}
		if !result.TaskDigest.Truncated {
			t.Fatal("invalid task row became a complete empty history")
		}
	})
	t.Run("history_authority_precedes_retention", func(t *testing.T) {
		cwd := t.TempDir()
		for i := 0; i < maxActivityDigestEntries+1; i++ {
			row := taskOrderingRow(fmt.Sprintf("t-%03d", i), "running", dagOlder)
			row["created_at"], row["parent_session_id"] = "2026-09-07T10:00:00Z", "parent"
			writeActivityStoreJSON(t, filepath.Join(cwd, ".omo", "senpi-task", "tasks", fmt.Sprintf("%03d.json", i)), row)
		}
		row := taskOrderingRow("t-512", "completed", dagCurrent)
		row["created_at"], row["parent_session_id"] = "2026-09-06T10:00:00Z", "parent"
		writeActivityStoreJSON(t, filepath.Join(cwd, ".omo", "senpi-task", "tasks", "new-revision.json"), row)
		result, err := ReadHistoricalActivity(t.Context(), cwd, "parent")
		if err != nil {
			t.Fatal(err)
		}
		if len(result.TaskDigest.Tasks) != maxActivityDigestEntries || !result.TaskDigest.Truncated {
			t.Fatalf("retention bound: rows=%d truncated=%v", len(result.TaskDigest.Tasks), result.TaskDigest.Truncated)
		}
		for _, row := range result.TaskDigest.Tasks {
			if row.TaskID == "t-512" {
				if row.Status != "completed" || row.UpdatedAt != dagCurrent {
					t.Fatalf("retention discarded authoritative raw revision: %+v", row)
				}
				return
			}
		}
		// The accepted row's old creation position may legitimately be evicted; an
		// older raw revision must never stand in for that omitted compact winner.
	})
}
