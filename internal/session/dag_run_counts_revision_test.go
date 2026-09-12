package session

import (
	"encoding/json"
	"path/filepath"
	"testing"
)

func assertDagRunCountsAbsent(t *testing.T, value any) {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"run_running_count", "run_total_count"} {
		if _, exists := fields[key]; exists {
			t.Errorf("unknown authority emitted %s: %s", key, raw)
		}
	}
}

func TestDagRunCountsRevisionCumulative(t *testing.T) {
	for _, mode := range []string{"bound", "unbound", "transfer"} {
		for _, scenario := range []string{"terminal_omission", "older_subset", "running_omission"} {
			t.Run(mode+"/"+scenario, func(t *testing.T) {
				h := newDAGOrderingHarness(t, mode)
				old := dagOrderingSnapshot(dagOrderingRun("completed", "completed", dagOlder))
				h.emit(t, activitySnapshotOrder[1], old)
				h.emit(t, activitySnapshotOrder[1], dagOrderingSnapshot(
					dagOrderingRun("completed", "completed", dagCurrent),
					dagOrderingRun("running", "running", dagCurrent),
				))
				recorder := newRecorder(8)
				detach := h.s.Attach(recorder)
				defer detach()
				if mode == "bound" {
					recorder.await(t, FrameExtensionEvent) // Consume attach replay before the tested delivery.
				}
				switch scenario {
				case "terminal_omission":
					h.emit(t, activitySnapshotOrder[1], dagOrderingSnapshot(dagOrderingRun("running", "running", dagNewer)))
				case "older_subset":
					h.emit(t, activitySnapshotOrder[1], old)
				case "running_omission":
					h.emit(t, activitySnapshotOrder[1], dagOrderingSnapshot(dagOrderingRun("completed", "completed", dagNewer)))
				}
				if mode == "transfer" {
					h.bind()
				}
				summary := h.summary()
				wantRunning := 1
				if scenario == "running_omission" {
					wantRunning = 0
				}
				assertDagRunCounts(t, summary.DagDigest, wantRunning, 2, "cumulative digest")
				if mode != "unbound" {
					_, frame := recorder.await(t, FrameExtensionEvent)
					assertDagRunCounts(t, frame.Data.(map[string]any)["data"], wantRunning, 2, "cumulative live")
				}
				// Run membership must not change the existing present-node/agent authority.
				wantNodes, wantAgents := 0, 1
				if scenario == "terminal_omission" {
					wantNodes, wantAgents = 1, 1
				}
				if summary.DagDigest.RunningCount != wantNodes || summary.DagDigest.AgentTotalCount != wantAgents {
					t.Fatalf("node/agent semantics changed: %+v", summary.DagDigest)
				}
			})
		}
	}
}

func TestDagRunCountsRevisionUnknownAndSameRevisionCompletion(t *testing.T) {
	for _, mode := range []string{"bound", "unbound", "transfer"} {
		t.Run(mode, func(t *testing.T) {
			h := newDAGOrderingHarness(t, mode)
			recorder := newRecorder(8)
			detach := h.s.Attach(recorder)
			defer detach()
			row := dagOrderingRun("running", "running", dagCurrent)
			partial := dagOrderingSnapshot(row)
			partial["truncated_runs"] = true
			h.emit(t, activitySnapshotOrder[1], partial)
			if mode == "transfer" {
				h.bind()
			}
			if mode != "unbound" {
				_, frame := recorder.await(t, FrameExtensionEvent)
				assertDagRunCountsAbsent(t, frame.Data.(map[string]any)["data"])
			}
			summary := h.summary()
			assertDagRunCountsAbsent(t, summary.DagDigest)
			assertDagRunCountsAbsent(t, summary.ActivityPair.Dag)
			// Reconstructing a digest from retained partial history cannot invent authority.
			reconstructed, ok := parseDagDigest(summary.ActivityPair.Dag)
			if !ok || len(reconstructed.Runs) != 1 {
				t.Fatalf("partial reconstruction = %+v", reconstructed)
			}
			assertDagRunCountsAbsent(t, reconstructed)

			h.emit(t, activitySnapshotOrder[1], dagOrderingSnapshot(row))
			if mode != "unbound" {
				_, frame := recorder.await(t, FrameExtensionEvent)
				assertDagRunCounts(t, frame.Data.(map[string]any)["data"], 1, 1, "same revision live")
			}
			summary = h.summary()
			assertDagRunCounts(t, summary.DagDigest, 1, 1, "same revision digest")
		})
	}
}

func TestDagRunCountsRevisionRunningOmission(t *testing.T) {
	for _, mode := range []string{"bound", "unbound", "transfer"} {
		t.Run(mode, func(t *testing.T) {
			h := newDAGOrderingHarness(t, mode)
			recorder := newRecorder(8)
			detach := h.s.Attach(recorder)
			defer detach()
			h.emit(t, activitySnapshotOrder[1], dagOrderingSnapshot(
				dagOrderingRun("first", "running", dagCurrent),
				dagOrderingRun("second", "running", dagCurrent),
			))
			if mode == "transfer" {
				h.bind()
			}
			assertDagRunCounts(t, h.summary().DagDigest, 2, 2, "initial digest")
			if mode != "unbound" {
				_, frame := recorder.await(t, FrameExtensionEvent)
				assertDagRunCounts(t, frame.Data.(map[string]any)["data"], 2, 2, "initial live")
			}
			for _, step := range []struct {
				snapshot map[string]any
				running  int
			}{
				{dagOrderingSnapshot(dagOrderingRun("first", "running", dagCurrent)), 1},
				{dagOrderingSnapshot(), 0},
			} {
				h.emit(t, activitySnapshotOrder[1], step.snapshot)
				assertDagRunCounts(t, h.summary().DagDigest, step.running, 2, "omitted digest")
				if mode != "unbound" {
					_, frame := recorder.await(t, FrameExtensionEvent)
					assertDagRunCounts(t, frame.Data.(map[string]any)["data"], step.running, 2, "omitted live")
				}
			}
		})
	}
}

// Historical inventory and live deliveries must use the same membership rule
// once admitted, regardless of which run carries the newest row revision.
func TestDagRunCountsRevisionMembershipOrdering(t *testing.T) {
	for _, source := range []string{"live", "historical"} {
		for _, mode := range []string{"bound", "unbound", "transfer"} {
			for _, scenario := range []struct {
				name, accepted, delivered string
				wantRunning               int
				unknown                   bool
			}{
				{"stale_omission", dagNewer, dagCurrent, 1, false},
				{"newer_removal_unchanged_survivor", dagOlder, dagOlder, 0, false},
				{"unknown_incoming", dagOlder, "", 0, true},
				{"unknown_incumbent", "", dagOlder, 0, true},
				{"both_unknown", "", "", 0, true},
			} {
				t.Run(source+"/"+mode+"/"+scenario.name, func(t *testing.T) {
					h := newDAGOrderingHarness(t, mode)
					initial := dagOrderingSnapshot(
						dagOrderingRun("done", "completed", scenario.accepted),
						dagOrderingRun("live", "running", dagCurrent),
					)
					if source == "historical" {
						cwd := t.TempDir()
						for _, row := range initial["runs"].([]map[string]any) {
							id := row["run_id"].(string)
							writeActivityStoreJSON(t, filepath.Join(cwd, ".omo", "senpi-task", "dag", "runs", id+".json"), map[string]any{
								"schemaVersion": 1, "runId": id, "runKey": id, "name": id,
								"parentSessionId": h.s.durableID, "status": row["status"],
								"createdAt": dagOlder, "updatedAt": row["updated_at"],
								"nodes": []any{map[string]any{"id": "node", "state": row["status"]}},
							})
						}
						activity, err := ReadHistoricalActivity(t.Context(), cwd, h.s.durableID)
						if err != nil {
							t.Fatal(err)
						}
						assertDagRunCounts(t, activity.DagDigest, 1, 2, "historical inventory")
						if err := json.Unmarshal(activity.ActivityPair.Dag, &initial); err != nil {
							t.Fatal(err)
						}
					}
					h.emit(t, activitySnapshotOrder[1], initial)
					assertDagRunCounts(t, h.summary().DagDigest, 1, 2, "initial digest")
					recorder := newRecorder(8)
					detach := h.s.Attach(recorder)
					defer detach()
					if mode == "bound" {
						recorder.await(t, FrameExtensionEvent)
					}
					h.emit(t, activitySnapshotOrder[1], dagOrderingSnapshot(dagOrderingRun("done", "completed", scenario.delivered)))
					if mode == "transfer" {
						h.bind()
					}
					summary := h.summary()
					// Check both surfaces even when one fails, so RED records agreement.
					t.Run("digest", func(t *testing.T) {
						if scenario.unknown {
							assertDagRunCountsAbsent(t, summary.DagDigest)
						} else {
							assertDagRunCounts(t, summary.DagDigest, scenario.wantRunning, 2, "ordered digest")
						}
					})
					if mode != "unbound" {
						_, frame := recorder.await(t, FrameExtensionEvent)
						t.Run("frame", func(t *testing.T) {
							data := frame.Data.(map[string]any)["data"]
							if scenario.unknown {
								assertDagRunCountsAbsent(t, data)
							} else {
								assertDagRunCounts(t, data, scenario.wantRunning, 2, "ordered live")
								running, total := decodeDagRunCounts(t, summary.DagDigest)
								assertDagRunCounts(t, data, running, total, "frame/digest agreement")
							}
						})
					}
				})
			}
		}
	}
}

func TestDagRunCountsRevisionKnownEmpty(t *testing.T) {
	h := newDAGOrderingHarness(t, "bound")
	recorder := newRecorder(8)
	detach := h.s.Attach(recorder)
	defer detach()
	h.emit(t, activitySnapshotOrder[1], dagOrderingSnapshot())
	summary := h.summary()
	assertDagRunCounts(t, summary.DagDigest, 0, 0, "known empty digest")
	_, frame := recorder.await(t, FrameExtensionEvent)
	assertDagRunCounts(t, frame.Data.(map[string]any)["data"], 0, 0, "known empty live")
	activity, err := ReadHistoricalActivity(t.Context(), t.TempDir(), "parent")
	if err != nil {
		t.Fatal(err)
	}
	assertDagRunCounts(t, activity.DagDigest, 0, 0, "known empty historical digest")
}
