package session

import "testing"

func TestLiveDagRunning_whenAnonymousNodesTruncateOnlyTheDigest(t *testing.T) {
	// Given a complete rich task roster and a complete DAG with an anonymous node.
	h := newDAGOrderingHarness(t, "bound")
	h.emit(t, activitySnapshotOrder[0], taskOrderingSnapshot(taskOrderingRow("shared", "running", dagCurrent)))
	run := dagOrderingRun("r", "running", dagCurrent)
	run["nodes"] = []any{
		map[string]any{"id": "a", "prompt": "work", "depends_on": []any{}, "state": "running", "task_id": "shared"},
		map[string]any{"id": "b", "prompt": "work", "depends_on": []any{}, "state": "running"},
	}
	// When the DAG is admitted, its digest cannot represent the anonymous identity.
	h.emit(t, activitySnapshotOrder[1], dagOrderingSnapshot(run))
	// Then rich completeness still permits the old client's overlap subtraction.
	summary := h.summary()
	if !summary.DagDigest.Truncated || summary.DagOversized {
		t.Fatal("fixture must truncate only the identity digest")
	}
	got := summary.LiveValues()
	if got.Running != (LiveRunning{Agents: 2, Tasks: 1, Dag: 1}) || !got.Truncated.Dag {
		t.Fatalf("rich overlap = %+v", got)
	}
}

func TestLiveDagTotals_whenLaterInventoryOmitsCompletedRun(t *testing.T) {
	// Given a completed run retained by the rich merge's terminal history policy.
	h := newDAGOrderingHarness(t, "bound")
	completed := dagOrderingRun("completed", "completed", dagCurrent)
	completed["counts"] = map[string]any{"completed": 3, "total": 3}
	h.emit(t, activitySnapshotOrder[1], dagOrderingSnapshot(completed))
	active := dagOrderingRun("active", "running", dagNewer)
	active["counts"] = map[string]any{"completed": 1, "total": 2}
	// When a newer complete inventory omits the terminal run.
	h.emit(t, activitySnapshotOrder[1], dagOrderingSnapshot(active))
	// Then displayed task-count totals still include terminal history, not run counts.
	got := h.summary().LiveValues()
	if got.DagDone != 4 || got.DagTotal != 5 {
		t.Fatalf("terminal history lost: %+v", got)
	}
}
