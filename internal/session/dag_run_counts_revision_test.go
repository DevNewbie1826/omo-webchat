package session

import (
	"encoding/json"
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
