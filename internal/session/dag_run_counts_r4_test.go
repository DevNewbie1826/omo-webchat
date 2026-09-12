package session

import (
	"encoding/json"
	"testing"
)

func assertDagRunCountsUnavailable(t *testing.T, value any) {
	t.Helper()
	assertDagRunCountsAbsent(t, value)
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		t.Fatal(err)
	}
	if string(fields["run_counts_unavailable"]) != "true" {
		t.Errorf("missing withdrawal signal: %s", raw)
	}
}

func TestDagRunCountsR4FirstCompleteInventory(t *testing.T) {
	for _, mode := range []string{"bound", "unbound", "transfer"} {
		for _, supplied := range []bool{false, true} {
			name := mode + "/derived_scalars"
			if supplied {
				name = mode + "/supplied_scalars"
			}
			t.Run(name, func(t *testing.T) {
				h := newDAGOrderingHarness(t, mode)
				recorder := newRecorder(8)
				detach := h.s.Attach(recorder)
				defer detach()
				snapshot := dagOrderingSnapshot(dagOrderingRun("first", "running", dagCurrent))
				if supplied {
					snapshot["run_running_count"], snapshot["run_total_count"] = 1, 1
				}
				h.emit(t, activitySnapshotOrder[1], snapshot)
				if mode == "transfer" {
					h.bind()
				}
				summary := h.summary()
				assertDagRunCounts(t, summary.DagDigest, 1, 1, "first complete digest")
				if summary.DagDigest.RunCountsUnavailable {
					t.Fatal("first complete inventory withdrew exact authority")
				}
				if supplied {
					assertDagRunCounts(t, summary.ActivityPair.Dag, 1, 1, "first complete retained payload")
				}
				if mode != "unbound" {
					_, frame := recorder.await(t, FrameExtensionEvent)
					data := frame.Data.(map[string]any)["data"]
					assertDagRunCounts(t, data, 1, 1, "first complete frame")
					if data.(map[string]any)["run_counts_unavailable"] == true {
						t.Fatal("first complete frame carried withdrawal beside scalars")
					}
				}
			})
		}
	}
}

func TestDagRunCountsR4AmbiguousMembership(t *testing.T) {
	done := dagOrderingRun("done", "completed", dagOlder)
	live := dagOrderingRun("live", "running", dagCurrent)
	for _, mode := range []string{"bound", "unbound", "transfer"} {
		for _, scenario := range []struct {
			name      string
			snapshots []map[string]any
		}{
			{"equal_subset_replay", []map[string]any{dagOrderingSnapshot(done), dagOrderingSnapshot(done, live), dagOrderingSnapshot(done)}},
			{"empty_replay", []map[string]any{dagOrderingSnapshot(), dagOrderingSnapshot(live), dagOrderingSnapshot()}},
			{"equal_row_resurrection", []map[string]any{dagOrderingSnapshot(live), dagOrderingSnapshot(), dagOrderingSnapshot(live)}},
			{"unknown_revision", []map[string]any{dagOrderingSnapshot(done, live), dagOrderingSnapshot(dagOrderingRun("done", "completed", ""))}},
		} {
			t.Run(mode+"/"+scenario.name, func(t *testing.T) {
				h := newDAGOrderingHarness(t, mode)
				for _, snapshot := range scenario.snapshots[:len(scenario.snapshots)-1] {
					h.emit(t, activitySnapshotOrder[1], snapshot)
				}
				recorder := newRecorder(8)
				detach := h.s.Attach(recorder)
				defer detach()
				if mode == "bound" {
					recorder.await(t, FrameExtensionEvent)
				}
				h.emit(t, activitySnapshotOrder[1], scenario.snapshots[len(scenario.snapshots)-1])
				if mode == "transfer" {
					h.bind()
				}
				summary := h.summary()
				assertDagRunCountsUnavailable(t, summary.DagDigest)
				assertDagRunCountsUnavailable(t, summary.ActivityPair.Dag)
				reconstructed, ok := parseDagDigest(summary.ActivityPair.Dag)
				if !ok {
					t.Fatal("historical reconstruction rejected")
				}
				assertDagRunCountsUnavailable(t, reconstructed)
				if mode != "unbound" {
					_, frame := recorder.await(t, FrameExtensionEvent)
					assertDagRunCountsUnavailable(t, frame.Data.(map[string]any)["data"])
				}
				// Ambiguity is sticky at the old high-water revision; a genuinely
				// newer complete inventory restores the cumulative pair.
				h.emit(t, activitySnapshotOrder[1], dagOrderingSnapshot(dagOrderingRun("live", "running", dagNewer)))
				total := 1
				if scenario.name == "equal_subset_replay" || scenario.name == "unknown_revision" {
					total = 2
				}
				assertDagRunCounts(t, h.summary().DagDigest, 1, total, "restored")
				if h.summary().DagDigest.RunCountsUnavailable {
					t.Fatal("restored pair retained withdrawal")
				}
				// An identical steady-state resend remains authoritative.
				h.emit(t, activitySnapshotOrder[1], dagOrderingSnapshot(dagOrderingRun("live", "running", dagNewer)))
				assertDagRunCounts(t, h.summary().DagDigest, 1, total, "steady resend")
			})
		}
	}
}
