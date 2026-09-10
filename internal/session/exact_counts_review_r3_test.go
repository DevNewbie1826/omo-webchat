package session

import (
	"encoding/json"
	"testing"
)

// F1 regression (review r2): a rejected stale revision must not resurrect a
// member that a newer complete delivery omitted from count membership.
func TestExactCountsRejectStaleResurrectOfOmittedMembership(t *testing.T) {
	var task taskSnapshotCache
	taskRow := func(status, at string) map[string]json.RawMessage {
		return taskCountTestRow("a", status, at)
	}
	otherRow := taskCountTestRow("b", "completed", "2026-09-10T10:03:00Z")

	task.mergeCountAuthority([]map[string]json.RawMessage{taskRow("running", "2026-09-10T10:02:00Z")}, true)
	if task.runningCount != 1 || task.totalCount != 1 {
		t.Fatalf("accept: running=%d total=%d", task.runningCount, task.totalCount)
	}

	task.mergeCountAuthority([]map[string]json.RawMessage{otherRow}, true)
	if task.runningCount != 0 || task.totalCount != 1 {
		t.Fatalf("complete omission: running=%d total=%d", task.runningCount, task.totalCount)
	}

	task.mergeCountAuthority([]map[string]json.RawMessage{taskRow("running", "2026-09-10T10:01:00Z")}, false)
	if task.runningCount != 0 || task.totalCount != 1 {
		t.Fatalf("stale resurrect: running=%d total=%d", task.runningCount, task.totalCount)
	}

	task.mergeCountAuthority([]map[string]json.RawMessage{taskRow("running", "2026-09-10T10:04:00Z")}, false)
	if task.runningCount != 1 || task.totalCount != 2 {
		t.Fatalf("revival: running=%d total=%d", task.runningCount, task.totalCount)
	}
}

// F2 regression (review r2): a DAG-derived terminal outcome must correct the
// count even when digest/evidence eviction drops the outcome receipt before
// reconcile runs.
func TestExactCountsOutcomeCorrectionSurvivesEvidenceEviction(t *testing.T) {
	var task taskSnapshotCache
	task.mergeCountAuthority([]map[string]json.RawMessage{
		taskCountTestRow("victim", "running", "2026-09-10T10:00:00Z"),
	}, true)
	if task.runningCount != 1 {
		t.Fatalf("setup running=%d", task.runningCount)
	}

	terminalRun := json.RawMessage(`{"run_id":"r1","status":"completed","updated_at":"2026-09-10T10:05:00Z","nodes":[{"id":"n1","task_id":"victim","state":"completed"}]}`)
	task.observe([]json.RawMessage{terminalRun})
	for key := range task.outcomes {
		delete(task.outcomes, key)
	}

	if task.runningCount != 0 || task.totalCount != 1 {
		t.Fatalf("correction lost after eviction: running=%d total=%d", task.runningCount, task.totalCount)
	}
}

func taskCountTestRow(id, status, at string) map[string]json.RawMessage {
	row := map[string]any{"task_id": id, "status": status, "updated_at": at}
	raw, _ := json.Marshal(row)
	var out map[string]json.RawMessage
	_ = json.Unmarshal(raw, &out)
	return out
}
