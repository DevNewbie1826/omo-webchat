package session

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

const (
	dagOlder   = "2026-09-07T10:01:00.000Z"
	dagCurrent = "2026-09-07T10:02:00.000Z"
	dagNewer   = "2026-09-07T10:03:00.000Z"
)

type dagOrderingHarness struct {
	s       *Session
	m       *Manager
	unbound bool
}

func newDAGOrderingHarness(t *testing.T, mode string) *dagOrderingHarness {
	t.Helper()
	s := newActivityTestSession(t)
	m := NewManager(Config{})
	s.manager = m
	s.queueSize = 64
	s.chatID, s.routingID = "ordering-chat", "ordering-route"
	return &dagOrderingHarness{s: s, m: m, unbound: mode != "bound"}
}

func (h *dagOrderingHarness) emit(t *testing.T, name string, data map[string]any) {
	t.Helper()
	if !h.unbound {
		injectEvent(t, h.s, map[string]any{"type": "extension_event", "name": name, "data": data})
		return
	}
	raw, err := json.Marshal(map[string]any{"type": "extension_event", "sessionId": h.s.durableID, "name": name, "data": data})
	if err != nil {
		t.Fatal(err)
	}
	h.m.mu.Lock()
	defer h.m.mu.Unlock()
	h.m.ingestUnboundOverviewLocked(h.s.epoch, &omorpc.Event{Type: "extension_event", SessionID: h.s.durableID, Raw: raw})
}

func (h *dagOrderingHarness) bind() {
	h.s.lifecycleMu.Lock()
	defer h.s.lifecycleMu.Unlock()
	h.m.mu.Lock()
	defer h.m.mu.Unlock()
	h.m.mergeOverviewIntoSessionLocked(h.s)
	h.unbound = false
}

func (h *dagOrderingHarness) summary() Summary {
	if !h.unbound {
		summary, _ := h.s.summary()
		return summary
	}
	h.m.mu.Lock()
	defer h.m.mu.Unlock()
	return h.m.overviewCache[h.s.durableID].summary(h.s.chatID, h.s.durableID)
}

func dagOrderingRun(id, status, updated string) map[string]any {
	attempt, completed, running := 1, 1, 0
	if status == "running" {
		attempt, completed, running = 2, 0, 1
	}
	return map[string]any{
		"run_id": id, "status": status, "updated_at": updated,
		"counts": map[string]any{"total": 1, "completed": completed, "running": running},
		"nodes":  []any{map[string]any{"id": "node", "task_id": "task-" + id, "state": status, "attempt": attempt}},
		"edges":  []any{map[string]any{"from": "root", "to": "node"}},
		"waves":  []any{map[string]any{"index": attempt, "node_ids": []string{"node"}}},
	}
}

func dagOrderingSnapshot(runs ...map[string]any) map[string]any {
	if runs == nil {
		runs = []map[string]any{}
	}
	return map[string]any{"runs": runs}
}

func assertDAGOrderingRows(t *testing.T, raw json.RawMessage, want ...map[string]any) {
	t.Helper()
	var doc struct {
		Runs []map[string]any `json:"runs"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("decode DAG: %v, raw=%s", err, raw)
	}
	gotByID := make(map[string]map[string]any)
	for _, row := range doc.Runs {
		gotByID[row["run_id"].(string)] = row
	}
	wantByID := make(map[string]map[string]any)
	for _, row := range want {
		encoded, err := json.Marshal(row)
		if err != nil {
			t.Fatal(err)
		}
		var normalized map[string]any
		if err := json.Unmarshal(encoded, &normalized); err != nil {
			t.Fatal(err)
		}
		wantByID[normalized["run_id"].(string)] = normalized
	}
	if !reflect.DeepEqual(gotByID, wantByID) {
		t.Errorf("DAG rows regressed or diverged: got=%s want=%v", raw, wantByID)
	}
}

func TestDAGSnapshotOrdering(t *testing.T) {
	for _, mode := range []string{"bound", "unbound", "transfer"} {
		t.Run(mode, func(t *testing.T) {
			for _, test := range []struct {
				name, current, incoming string
				accepts                 bool
			}{
				{"older", dagCurrent, dagOlder, false},
				{"equal", dagCurrent, dagCurrent, false},
				{"equivalent_offset", dagCurrent, "2026-09-07T12:02:00.000+02:00", false},
				{"equal_millisecond", dagCurrent, "2026-09-07T10:02:00.000999Z", false},
				{"unknown", dagCurrent, "", false},
				{"invalid", dagCurrent, "invalid", false},
				{"invalid_calendar", dagCurrent, "2026-02-30T10:03:00Z", false},
				{"invalid_offset", dagCurrent, "2026-09-07T10:03:00+24:00", false},
				{"missing_zone", dagCurrent, "2026-09-07T10:03:00", false},
				{"PIN_newer_restart", dagCurrent, dagNewer, true},
				{"PIN_unknown_to_known", "", dagCurrent, true},
				{"PIN_both_unknown", "", "invalid", true},
			} {
				t.Run(test.name, func(t *testing.T) {
					h := newDAGOrderingHarness(t, mode)
					current := dagOrderingRun("ordering-run", "completed", test.current)
					incoming := dagOrderingRun("ordering-run", "running", test.incoming)
					h.emit(t, activitySnapshotOrder[1], dagOrderingSnapshot(current))
					if mode == "transfer" {
						h.bind()
					}
					h.emit(t, activitySnapshotOrder[1], dagOrderingSnapshot(incoming))
					want := current
					if test.accepts {
						want = incoming
					}
					summary := h.summary()
					assertDAGOrderingRows(t, summary.ActivityPair.Dag, want)
					wantActive := 0
					if test.accepts {
						wantActive = 1
					}
					if summary.DagDigest == nil || len(summary.DagDigest.Runs) != wantActive {
						t.Errorf("active digest = %+v, want %d runs", summary.DagDigest, wantActive)
					}
				})
			}
			t.Run("mixed_ids", func(t *testing.T) {
				h := newDAGOrderingHarness(t, mode)
				a := dagOrderingRun("a", "completed", dagCurrent)
				b := dagOrderingRun("b", "completed", dagCurrent)
				h.emit(t, activitySnapshotOrder[1], dagOrderingSnapshot(a, b))
				if mode == "transfer" {
					h.bind()
				}
				newB := dagOrderingRun("b", "running", dagNewer)
				h.emit(t, activitySnapshotOrder[1], dagOrderingSnapshot(dagOrderingRun("a", "running", dagOlder), newB))
				assertDAGOrderingRows(t, h.summary().ActivityPair.Dag, a, newB)
			})
			for _, truncated := range []bool{false, true} {
				name := "omission_high_water"
				if truncated {
					name = "truncated_omission"
				}
				t.Run(name, func(t *testing.T) {
					h := newDAGOrderingHarness(t, mode)
					current := dagOrderingRun("ordering-run", "running", dagCurrent)
					h.emit(t, activitySnapshotOrder[1], dagOrderingSnapshot(current))
					empty := dagOrderingSnapshot()
					empty["truncated_runs"] = truncated
					h.emit(t, activitySnapshotOrder[1], empty)
					if mode == "transfer" {
						h.bind()
					}
					h.emit(t, activitySnapshotOrder[1], dagOrderingSnapshot(dagOrderingRun("ordering-run", "completed", dagOlder)))
					if truncated {
						assertDAGOrderingRows(t, h.summary().ActivityPair.Dag, current)
					} else {
						assertDAGOrderingRows(t, h.summary().ActivityPair.Dag)
					}
				})
			}
			t.Run("stale_terminal_does_not_reconcile_tasks", func(t *testing.T) {
				h := newDAGOrderingHarness(t, mode)
				h.emit(t, activitySnapshotOrder[1], dagOrderingSnapshot(dagOrderingRun("ordering-run", "running", dagNewer)))
				if mode == "transfer" {
					h.bind()
				}
				h.emit(t, activitySnapshotOrder[0], map[string]any{"tasks": []any{map[string]any{"task_id": "task-ordering-run", "status": "running"}}})
				h.emit(t, activitySnapshotOrder[1], dagOrderingSnapshot(dagOrderingRun("ordering-run", "completed", dagCurrent)))
				summary := h.summary()
				if got := activityTaskStatus(t, summary.ActivityPair.Task, "task-ordering-run"); got != "running" {
					t.Errorf("stale terminal reconciled task to %s", got)
				}
				if summary.TaskDigest.Tasks[0].Status != "running" {
					t.Errorf("stale terminal reconciled digest: %+v", summary.TaskDigest)
				}
			})
			for _, stage := range []string{"clear", "stale_refill", "newer_refill", "mixed_unreconstructable"} {
				t.Run("oversized_"+stage, func(t *testing.T) {
					h := newDAGOrderingHarness(t, mode)
					h.emit(t, activitySnapshotOrder[1], dagOrderingSnapshot(dagOrderingRun("ordering-run", "running", dagOlder)))
					large := dagOrderingRun("ordering-run", "completed", dagCurrent)
					large["padding"] = strings.Repeat("x", maxActivitySnapshotBytes)
					h.emit(t, activitySnapshotOrder[1], dagOrderingSnapshot(large))
					if mode == "transfer" {
						h.bind()
					}
					if stage == "stale_refill" {
						h.emit(t, activitySnapshotOrder[1], dagOrderingSnapshot(dagOrderingRun("ordering-run", "running", dagOlder)))
					}
					if stage == "newer_refill" {
						newer := dagOrderingRun("ordering-run", "running", dagNewer)
						h.emit(t, activitySnapshotOrder[1], dagOrderingSnapshot(newer))
						assertDAGOrderingRows(t, h.summary().ActivityPair.Dag, newer)
						if h.summary().DagOversized {
							t.Error("newer bounded input did not restore replay")
						}
						return
					}
					if stage == "mixed_unreconstructable" {
						other := dagOrderingRun("other", "running", dagNewer)
						h.emit(t, activitySnapshotOrder[1], dagOrderingSnapshot(dagOrderingRun("ordering-run", "running", dagOlder), other))
						assertDAGOrderingRows(t, h.summary().ActivityPair.Dag, other)
						var doc struct {
							Truncated bool `json:"truncated_runs"`
						}
						if err := json.Unmarshal(h.summary().ActivityPair.Dag, &doc); err != nil {
							t.Fatal(err)
						}
						if !doc.Truncated {
							t.Error("unavailable incumbent must mark partial replay truncated")
						}
						return
					}
					summary := h.summary()
					if len(summary.ActivityPair.Dag) != 0 || !summary.DagOversized {
						t.Errorf("obsolete replay retained/refilled: bytes=%d oversized=%v", len(summary.ActivityPair.Dag), summary.DagOversized)
					}
					if summary.DagDigest == nil || len(summary.DagDigest.Runs) != 0 {
						t.Errorf("oversized accepted terminal digest regressed: %+v", summary.DagDigest)
					}
					if !h.unbound && len(h.s.ActivitySnapshot()) != 0 {
						t.Error("refresh replays obsolete DAG")
					}
				})
			}
		})
	}
	t.Run("PIN_parent_lifecycle", func(t *testing.T) {
		h := newDAGOrderingHarness(t, "bound")
		current := dagOrderingRun("ordering-run", "completed", dagCurrent)
		h.emit(t, activitySnapshotOrder[1], dagOrderingSnapshot(current))
		injectEvent(t, h.s, map[string]any{"type": "agent_start"})
		injectEvent(t, h.s, map[string]any{"type": "agent_settled", "reason": "end_turn"})
		assertDAGOrderingRows(t, h.summary().ActivityPair.Dag, current)
	})
	t.Run("forwarded_and_attach", func(t *testing.T) {
		h := newDAGOrderingHarness(t, "bound")
		r := newRecorder(8)
		detach := h.s.Attach(r)
		defer detach()
		current := dagOrderingRun("ordering-run", "completed", dagCurrent)
		h.emit(t, activitySnapshotOrder[1], dagOrderingSnapshot(current))
		r.await(t, FrameExtensionEvent)
		h.emit(t, activitySnapshotOrder[1], dagOrderingSnapshot(dagOrderingRun("ordering-run", "running", dagOlder)))
		_, frame := r.await(t, FrameExtensionEvent)
		data := frame.Data.(map[string]any)["data"]
		raw, err := json.Marshal(data)
		if err != nil {
			t.Fatal(err)
		}
		assertDAGOrderingRows(t, raw, current)
		replay := newRecorder(8)
		detachReplay := h.s.Attach(replay)
		defer detachReplay()
		_, frame = replay.await(t, FrameExtensionEvent)
		raw, err = json.Marshal(frame.Data.(map[string]any)["data"])
		if err != nil {
			t.Fatal(err)
		}
		assertDAGOrderingRows(t, raw, current)
	})
}
