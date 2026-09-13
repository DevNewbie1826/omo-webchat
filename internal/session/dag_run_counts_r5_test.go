package session

import "testing"

func TestDagRunCountsR5RowUpdateCannotResurrectMembership(t *testing.T) {
	for _, mode := range []string{"bound", "unbound", "transfer"} {
		for _, partial := range []bool{true, false} {
			name := "rejected_complete_inventory"
			if partial {
				name = "ambiguous_partial_resurrection"
			}
			t.Run(mode+"/"+name, func(t *testing.T) {
				h := newDAGOrderingHarness(t, mode)
				h.emit(t, activitySnapshotOrder[1], dagOrderingSnapshot(
					dagOrderingRun("done", "completed", dagOlder),
					dagOrderingRun("live", "running", dagOlder),
				))
				h.emit(t, activitySnapshotOrder[1], dagOrderingSnapshot(dagOrderingRun("done", "completed", dagNewer)))
				assertDagRunCounts(t, h.summary().DagDigest, 0, 2, "accepted omission")

				// Subscribe before delivery (or ownership transfer), and consume
				// the bound replay before checking the update's exact frame.
				recorder := newRecorder(8)
				detach := h.s.Attach(recorder)
				defer detach()
				if mode == "bound" {
					_, frame := recorder.await(t, FrameExtensionEvent)
					assertDagRunCounts(t, frame.Data.(map[string]any)["data"], 0, 2, "omission replay")
				}
				live := dagOrderingRun("live", "running", dagCurrent)
				incoming := dagOrderingSnapshot(dagOrderingRun("done", "completed", dagOlder), live)
				if partial {
					incoming = dagOrderingSnapshot(live)
					incoming["truncated_runs"] = true
				}
				h.emit(t, activitySnapshotOrder[1], incoming)
				if mode == "transfer" {
					h.bind()
				}
				summary := h.summary()
				assertAuthority := func(t *testing.T, value any) {
					t.Helper()
					if partial {
						assertDagRunCountsUnavailable(t, value)
					} else {
						assertDagRunCounts(t, value, 0, 2, "rejected stale inventory")
					}
				}
				// Separate subtests record both surfaces even on the failing-first run.
				t.Run("digest", func(t *testing.T) {
					assertAuthority(t, summary.DagDigest)
					if !partial && summary.DagDigest.RunCountsUnavailable {
						t.Fatal("rejected inventory withdrew accepted authority")
					}
				})
				if mode != "unbound" {
					_, frame := recorder.await(t, FrameExtensionEvent)
					data := frame.Data.(map[string]any)["data"].(map[string]any)
					t.Run("frame", func(t *testing.T) {
						assertAuthority(t, data)
						if !partial {
							running, total := decodeDagRunCounts(t, summary.DagDigest)
							assertDagRunCounts(t, data, running, total, "frame/digest agreement")
							if data["run_counts_unavailable"] == true {
								t.Fatal("rejected inventory frame withdrew accepted authority")
							}
						}
					})
					if data["running_count"] != float64(1) || data["agent_running_count"] != float64(1) || data["agent_total_count"] != float64(2) {
						t.Errorf("row update changed node/agent semantics: %v", data)
					}
				}
				if summary.DagDigest.RunningCount != 1 || summary.DagDigest.AgentRunningCount != 1 || summary.DagDigest.AgentTotalCount != 2 {
					t.Errorf("row update changed digest node/agent semantics: %+v", summary.DagDigest)
				}
				if partial {
					assertDagRunCountsUnavailable(t, summary.ActivityPair.Dag)
				}
				// A later complete inventory admits the resurrection without
				// losing either session-cumulative identity.
				h.emit(t, activitySnapshotOrder[1], dagOrderingSnapshot(dagOrderingRun("live", "running", "2026-09-07T10:04:00.000Z")))
				assertDagRunCounts(t, h.summary().DagDigest, 1, 2, "ordered recovery")
			})
		}
	}
}
