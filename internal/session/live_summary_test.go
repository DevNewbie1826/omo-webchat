package session

import (
	"encoding/json"
	"fmt"
	"testing"
)

func TestLiveSummaryCounts_whenDAGRunsExceedDigestCap(t *testing.T) {
	// Given full membership with run statuses deliberately unrelated to counts.
	h := newDAGOrderingHarness(t, "unbound")
	runs := make([]any, maxActivityDigestEntries+1)
	for i := range runs {
		runs[i] = map[string]any{"run_id": fmt.Sprintf("r-%d", i), "status": "completed", "updated_at": dagCurrent,
			"counts": map[string]any{"completed": 2, "total": 3}, "nodes": []any{}}
	}
	// When the full inventory is admitted through the real cache.
	h.emit(t, activitySnapshotOrder[1], map[string]any{"runs": runs})
	// Then task counts across ALL runs survive both terminal filtering and caps.
	got := h.summary().LiveValues()
	if got.DagDone != 1026 || got.DagTotal != 1539 || got.Running != (LiveRunning{}) || !got.Truncated.Dag {
		t.Fatalf("lean counts = %+v", got)
	}
}

func TestLiveSummaryCounts_whenTaskStatesIncludePendingAndFailures(t *testing.T) {
	// Given each task status counted by the old UI, plus nonterminal work.
	h := newDAGOrderingHarness(t, "bound")
	rows := make([]map[string]any, 0)
	for i, status := range []string{"running", "pending", "blocked", "completed", "failed", "cancelled", "lost", "interrupted", "error", "skipped", "canceled"} {
		rows = append(rows, taskOrderingRow(fmt.Sprintf("t-%d", i), status, dagCurrent))
	}
	// When admitted as a complete task roster.
	h.emit(t, activitySnapshotOrder[0], taskOrderingSnapshot(rows...))
	// Then done is terminal membership, NOT total minus running.
	got := h.summary().LiveValues()
	if got.Done != 7 || got.Running.Tasks != 1 || got.Running.Agents != 1 || got.Truncated.Task {
		t.Fatalf("lean task counts = %+v", got)
	}
}

func TestLiveSummaryProgress_whenTaskTimestampsTie(t *testing.T) {
	// Given per-task clocks, the later row wins a tie and root progress is irrelevant.
	h := newDAGOrderingHarness(t, "bound")
	rows := []map[string]any{
		{"task_id": "a", "status": "running", "updated_at": dagCurrent, "live_progress": map[string]any{"last_assistant_line": "first"}},
		{"task_id": "b", "status": "running", "created_at": dagCurrent, "live_progress": map[string]any{"activity": "winner"}},
		{"task_id": "c", "status": "pending", "updated_at": dagOlder, "live_progress": map[string]any{"last_assistant_line": "older"}},
	}
	payload := taskOrderingSnapshot(rows...)
	payload["live_progress"] = map[string]any{"last_assistant_line": "root"}
	// When the snapshot is admitted.
	h.emit(t, activitySnapshotOrder[0], payload)
	// Then cached progress uses the existing task selection and fallback.
	got := h.summary().LiveValues()
	if got.LastLine == nil || *got.LastLine != "winner" {
		t.Fatalf("progress = %+v", got.LastLine)
	}
}

func TestLiveSummaryReceipt_whenDigestsHaveDifferentReceiptTimes(t *testing.T) {
	// Given receipt times independent of task raw revision clocks.
	summary := Summary{TaskDigest: &TaskDigest{ReceivedAt: "2026-09-13T12:00:00.001Z"}, DagDigest: &DagDigest{ReceivedAt: "2026-09-13T12:00:00.002Z"}}
	// When the live projection is read.
	got := summary.LiveValues()
	// Then the latest receipt in milliseconds is the sole revision source.
	if got.LastActivityMS == nil || *got.LastActivityMS != 1789300800002 {
		t.Fatalf("receipt = %v", got.LastActivityMS)
	}
}

func TestLiveSummaryEmpty_whenNoActivityHasArrived(t *testing.T) {
	// Given a lifecycle-only session.
	summary := Summary{Active: true}
	// When projected on the live wire.
	payload, err := json.Marshal(summary.LiveValues())
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]json.RawMessage
	if err := json.Unmarshal(payload, &got); err != nil {
		t.Fatal(err)
	}
	// Then no receipt or progress is invented, while zero count fields remain present.
	for _, key := range []string{"last_activity_ms", "last_line"} {
		if _, exists := got[key]; exists {
			t.Errorf("invented %s: %s", key, payload)
		}
	}
	for _, key := range []string{"done", "dag_done", "dag_total", "running", "truncated"} {
		if _, exists := got[key]; !exists {
			t.Errorf("missing %s: %s", key, payload)
		}
	}
}

func TestLiveSummaryPartial_whenDAGCountsAreMalformed(t *testing.T) {
	// Given malformed optional display counts beside valid running node work.
	for _, counts := range []any{nil, "invalid", map[string]any{"completed": -1, "total": 2}} {
		h := newDAGOrderingHarness(t, "bound")
		run := dagOrderingRun("r", "running", dagCurrent)
		run["counts"] = counts
		// When the snapshot crosses the parser boundary.
		h.emit(t, activitySnapshotOrder[1], dagOrderingSnapshot(run))
		// Then display uncertainty is disclosed without corrupting node authority.
		got := h.summary().LiveValues()
		if !got.Truncated.Dag || got.Running.Agents != 1 || got.Running.Dag != 1 {
			t.Fatalf("malformed counts %v: %+v", counts, got)
		}
	}
}
