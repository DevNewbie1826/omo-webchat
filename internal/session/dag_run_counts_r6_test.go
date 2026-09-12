package session

import "testing"

func TestDagRunCountsR6MixedPartialPostFenceObservation(t *testing.T) {
	for _, mode := range []string{"bound", "unbound", "transfer"} {
		for _, identity := range []string{"live", "new"} {
			t.Run(mode+"/"+identity, func(t *testing.T) {
				h := newDAGOrderingHarness(t, mode)
				h.emit(t, activitySnapshotOrder[1], dagOrderingSnapshot(
					dagOrderingRun("done", "completed", dagOlder),
					dagOrderingRun("live", "running", dagOlder),
				))
				h.emit(t, activitySnapshotOrder[1], dagOrderingSnapshot(dagOrderingRun("done", "completed", dagNewer)))
				assertDagRunCounts(t, h.summary().DagDigest, 0, 2, "accepted omission")

				// Attach before the update or transfer; drain only the bound
				// omission replay so the next frame is the mixed delivery.
				recorder := newRecorder(8)
				detach := h.s.Attach(recorder)
				defer detach()
				if mode == "bound" {
					_, frame := recorder.await(t, FrameExtensionEvent)
					assertDagRunCounts(t, frame.Data.(map[string]any)["data"], 0, 2, "omission replay")
				}
				incoming := dagOrderingSnapshot(
					dagOrderingRun("done", "completed", dagOlder),
					dagOrderingRun(identity, "running", "2026-09-07T10:04:00.000Z"),
				)
				incoming["truncated_runs"] = true
				h.emit(t, activitySnapshotOrder[1], incoming)
				if mode == "transfer" {
					h.bind()
				}
				summary := h.summary()
				wantTotal := 2
				if identity == "new" {
					wantTotal = 3
				}
				// Independent subtests expose both incorrect surfaces on RED.
				t.Run("digest", func(t *testing.T) {
					assertDagRunCounts(t, summary.DagDigest, 1, wantTotal, "post-fence observation")
					if summary.DagDigest.RunCountsUnavailable {
						t.Fatal("proven observation withdrew exact authority")
					}
				})
				if mode != "unbound" {
					_, frame := recorder.await(t, FrameExtensionEvent)
					data := frame.Data.(map[string]any)["data"].(map[string]any)
					t.Run("frame", func(t *testing.T) {
						assertDagRunCounts(t, data, 1, wantTotal, "post-fence observation")
						running, total := decodeDagRunCounts(t, summary.DagDigest)
						assertDagRunCounts(t, data, running, total, "frame/digest agreement")
						if data["run_counts_unavailable"] == true {
							t.Fatal("proven observation frame withdrew exact authority")
						}
					})
					if data["running_count"] != float64(1) || data["agent_running_count"] != float64(1) || data["agent_total_count"] != float64(2) {
						t.Errorf("mixed delivery changed node/agent semantics: %v", data)
					}
				}
				if summary.DagDigest.RunningCount != 1 || summary.DagDigest.AgentRunningCount != 1 || summary.DagDigest.AgentTotalCount != 2 {
					t.Errorf("mixed delivery changed digest node/agent semantics: %+v", summary.DagDigest)
				}
			})
		}
	}
}
