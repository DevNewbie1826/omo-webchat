package session

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"testing"
)

// Run-level DAG scalars ride the same authority as the existing exact DAG
// counts: the full pre-truncation membership. A run counts as running when
// its status is not terminal; total counts every present run. Both scalars
// must stay exact under any digest row truncation.

func decodeDagRunCounts(t *testing.T, value any) (runRunning, runTotal int) {
	t.Helper()
	payload, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var fields struct {
		RunRunningCount int `json:"run_running_count"`
		RunTotalCount   int `json:"run_total_count"`
	}
	if err := json.Unmarshal(payload, &fields); err != nil {
		t.Fatal(err)
	}
	return fields.RunRunningCount, fields.RunTotalCount
}

func assertDagRunCounts(t *testing.T, value any, wantRunning, wantTotal int, stage string) {
	t.Helper()
	runRunning, runTotal := decodeDagRunCounts(t, value)
	if runRunning != wantRunning || runTotal != wantTotal {
		t.Fatalf("%s run scalars = %d/%d, want %d/%d", stage, runRunning, runTotal, wantRunning, wantTotal)
	}
}

// The omo.dag.updated frame data and the live merge digest both carry the
// exact run pair when membership is complete, next to the existing scalars.
func TestDagRunCountsLiveMergeDigestAndFrame(t *testing.T) {
	for _, mode := range []string{"bound", "transfer"} {
		t.Run(mode, func(t *testing.T) {
			h := newDAGOrderingHarness(t, mode)
			recorder := newRecorder(8)
			detach := h.s.Attach(recorder)
			defer detach()
			h.emit(t, activitySnapshotOrder[1], dagOrderingSnapshot(
				dagOrderingRun("live-running", "running", dagCurrent),
				dagOrderingRun("live-completed", "completed", dagCurrent),
				dagOrderingRun("live-cancelled", "cancelled", dagCurrent),
			))
			if mode == "transfer" {
				h.bind()
			}
			_, frame := recorder.await(t, FrameExtensionEvent)
			data, ok := frame.Data.(map[string]any)["data"].(map[string]any)
			if !ok {
				t.Fatalf("dag frame data shape: %+v", frame.Data)
			}
			assertDagRunCounts(t, data, 1, 3, "frame")
			if data["running_count"] != float64(1) || data["agent_total_count"] != float64(3) {
				t.Fatalf("existing frame scalars disturbed: running=%v agent_total=%v", data["running_count"], data["agent_total_count"])
			}
			summary := h.summary()
			if summary.DagDigest == nil {
				t.Fatal("missing dag digest")
			}
			assertDagRunCounts(t, summary.DagDigest, 1, 3, "live digest")
		})
	}
}

// The historical reconstruction digest carries the pair computed over every
// eligible run record, terminal statuses included in total only.
func TestDagRunCountsHistoricalReconstruction(t *testing.T) {
	t.Run("full_membership", func(t *testing.T) {
		cwd := t.TempDir()
		base := filepath.Join(cwd, ".omo", "senpi-task")
		run := func(id, status string) map[string]any {
			return map[string]any{
				"schemaVersion": 1, "runId": id, "runKey": id, "name": id, "parentSessionId": "parent", "status": status,
				"createdAt": "2026-09-03T12:00:00Z", "updatedAt": "2026-09-03T12:01:00Z",
				"nodes": []any{map[string]any{"id": "node-" + id, "taskId": "task-" + id, "state": status}},
			}
		}
		writeActivityStoreJSON(t, filepath.Join(base, "dag", "runs", "a.json"), run("hist-running", "running"))
		writeActivityStoreJSON(t, filepath.Join(base, "dag", "runs", "b.json"), run("hist-completed", "completed"))
		writeActivityStoreJSON(t, filepath.Join(base, "dag", "runs", "c.json"), run("hist-cancelled", "cancelled"))
		activity, err := ReadHistoricalActivity(t.Context(), cwd, "parent")
		if err != nil {
			t.Fatal(err)
		}
		assertDagRunCounts(t, activity.DagDigest, 1, 3, "historical digest")
		if activity.DagDigest.RunningCount != 1 {
			t.Fatalf("historical node scalar = %d, want 1", activity.DagDigest.RunningCount)
		}
	})
	// Row eviction in the bounded reconstruction never moves the scalars: the
	// count scan is independent of the rich-row retention budget.
	t.Run("truncated_rows", func(t *testing.T) {
		cwd := t.TempDir()
		base := filepath.Join(cwd, ".omo", "senpi-task")
		for i := 0; i < maxActivityDigestEntries+1; i++ {
			id := fmt.Sprintf("hist-trunc-%04d", i)
			writeActivityStoreJSON(t, filepath.Join(base, "dag", "runs", fmt.Sprintf("%04d.json", i)), map[string]any{
				"schemaVersion": 1, "runId": id, "runKey": id, "name": id, "parentSessionId": "parent", "status": "running",
				"createdAt": fmt.Sprintf("2026-09-03T12:%02d:%02dZ", (i/60)%60, i%60), "updatedAt": "2026-09-03T13:00:00Z",
				"nodes": []any{map[string]any{"id": "node", "taskId": "task-" + id, "state": "running"}},
			})
		}
		activity, err := ReadHistoricalActivity(t.Context(), cwd, "parent")
		if err != nil {
			t.Fatal(err)
		}
		assertDagRunCounts(t, activity.DagDigest, maxActivityDigestEntries+1, maxActivityDigestEntries+1, "historical truncated digest")
		if activity.DagDigest == nil || !activity.DagDigest.Truncated || len(activity.DagDigest.Runs) >= maxActivityDigestEntries+1 {
			t.Fatalf("historical digest rows not truncated: n=%d truncated=%v",
				len(activity.DagDigest.Runs), activity.DagDigest.Truncated)
		}
	})
}

// Digest row truncation never moves the scalars: the count membership is
// unbounded, so 513 runs clip to 512 digest rows while both scalars stay 513.
func TestDagRunCountsExactUnderDigestRowTruncation(t *testing.T) {
	h := newDAGOrderingHarness(t, "bound")
	recorder := newRecorder(8)
	detach := h.s.Attach(recorder)
	defer detach()
	rows := make([]map[string]any, maxActivityDigestEntries+1)
	for i := range rows {
		rows[i] = map[string]any{"run_id": fmt.Sprintf("trunc-%04d", i), "status": "running", "updated_at": dagCurrent}
	}
	h.emit(t, activitySnapshotOrder[1], dagOrderingSnapshot(rows...))
	_, frame := recorder.await(t, FrameExtensionEvent)
	data, ok := frame.Data.(map[string]any)["data"].(map[string]any)
	if !ok {
		t.Fatalf("dag frame data shape: %+v", frame.Data)
	}
	assertDagRunCounts(t, data, maxActivityDigestEntries+1, maxActivityDigestEntries+1, "truncated frame")
	summary := h.summary()
	if summary.DagDigest == nil || !summary.DagDigest.Truncated || len(summary.DagDigest.Runs) != maxActivityDigestEntries {
		t.Fatalf("digest rows not truncated: %+v", summary.DagDigest)
	}
	assertDagRunCounts(t, summary.DagDigest, maxActivityDigestEntries+1, maxActivityDigestEntries+1, "truncated digest")
}

// A provider-declared truncated delivery that drops rows from the run list
// keeps the scalars fixed at the last complete membership.
func TestDagRunCountsExactWhenProviderTruncatesKnownMembership(t *testing.T) {
	h := newDAGOrderingHarness(t, "bound")
	recorder := newRecorder(8)
	detach := h.s.Attach(recorder)
	defer detach()
	h.emit(t, activitySnapshotOrder[1], dagOrderingSnapshot(
		dagOrderingRun("kept", "running", dagCurrent),
		dagOrderingRun("dropped", "running", dagCurrent),
	))
	recorder.next(t) // first delivery frame
	truncated := dagOrderingSnapshot(dagOrderingRun("kept", "running", dagNewer))
	truncated["truncated_runs"] = true
	h.emit(t, activitySnapshotOrder[1], truncated)
	frame := recorder.next(t)
	data, ok := frame.Data.(map[string]any)["data"].(map[string]any)
	if !ok {
		t.Fatalf("dag frame data shape: %+v", frame.Data)
	}
	assertDagRunCounts(t, data, 2, 2, "truncated delivery frame")
	// The delivery was declared partial; the scalars must not follow the
	// delivered subset down.
	if data["truncated_runs"] != true {
		t.Fatalf("delivered runs list not disclosed truncated: %v", data["truncated_runs"])
	}
	summary := h.summary()
	assertDagRunCounts(t, summary.DagDigest, 2, 2, "truncated delivery digest")
}
