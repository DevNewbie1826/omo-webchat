package session

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
)

func digestCounts(t *testing.T, value any) (taskRunning, taskTotal, dagRunning, agentRunning, agentTotal int) {
	t.Helper()
	payload, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var fields struct {
		RunningCount      int `json:"running_count"`
		TotalCount        int `json:"total_count"`
		AgentRunningCount int `json:"agent_running_count"`
		AgentTotalCount   int `json:"agent_total_count"`
	}
	if err := json.Unmarshal(payload, &fields); err != nil {
		t.Fatal(err)
	}
	return fields.RunningCount, fields.TotalCount, fields.RunningCount, fields.AgentRunningCount, fields.AgentTotalCount
}

func TestExactCountsRejectMixedStaleRevisionsBothPaths(t *testing.T) {
	for _, mode := range []string{"bound", "unbound"} {
		t.Run("task_"+mode, func(t *testing.T) {
			h := newDAGOrderingHarness(t, mode)
			h.emit(t, activitySnapshotOrder[0], taskOrderingSnapshot(taskOrderingRow("a", "running", dagCurrent)))
			h.emit(t, activitySnapshotOrder[0], taskOrderingSnapshot(
				taskOrderingRow("a", "completed", dagOlder),
				taskOrderingRow("b", "completed", dagNewer),
			))
			summary := h.summary()
			if got := activityTaskStatus(t, summary.ActivityPair.Task, "a"); got != "running" {
				t.Fatalf("accepted task status = %q, want running", got)
			}
			if summary.TaskDigest == nil || summary.TaskDigest.RunningCount != 1 || summary.TaskDigest.TotalCount != 2 {
				t.Fatalf("task scalars = %+v, want running=1 total=2", summary.TaskDigest)
			}
		})
		t.Run("dag_"+mode, func(t *testing.T) {
			h := newDAGOrderingHarness(t, mode)
			h.emit(t, activitySnapshotOrder[1], dagOrderingSnapshot(dagOrderingRun("a", "running", dagCurrent)))
			h.emit(t, activitySnapshotOrder[1], dagOrderingSnapshot(
				dagOrderingRun("a", "completed", dagOlder),
				dagOrderingRun("b", "completed", dagNewer),
			))
			summary := h.summary()
			assertDAGOrderingRows(t, summary.ActivityPair.Dag,
				dagOrderingRun("a", "running", dagCurrent), dagOrderingRun("b", "completed", dagNewer))
			if summary.DagDigest == nil || summary.DagDigest.RunningCount != 1 {
				t.Fatalf("DAG scalar = %+v, want running=1", summary.DagDigest)
			}
		})
	}
}

func TestExactAgentCountsDeduplicateOverlapBeforeTruncationAndReachDispatch(t *testing.T) {
	h := newDAGOrderingHarness(t, "bound")
	recorder := newRecorder(8)
	detach := h.s.Attach(recorder)
	defer detach()
	tasks := make([]map[string]any, maxActivityDigestEntries+1)
	for i := range tasks {
		status := "running"
		if i == 0 {
			status = "completed"
		}
		tasks[i] = taskOrderingRow(fmt.Sprintf("task-%04d", i), status, dagCurrent)
	}
	h.emit(t, activitySnapshotOrder[0], taskOrderingSnapshot(tasks...))
	taskDispatch := recorder.next(t)
	run := dagOrderingRun("overlap", "running", dagNewer)
	run["nodes"] = []any{
		map[string]any{"id": "overlap", "task_id": "task-0000", "state": "running", "attempt": 1},
		map[string]any{"id": "dag-only", "state": "running", "attempt": 1},
	}
	run["counts"] = map[string]any{"total": 2, "completed": 0, "running": 2}
	h.emit(t, activitySnapshotOrder[1], dagOrderingSnapshot(run))
	dagDispatch := recorder.next(t)

	summary := h.summary()
	_, _, _, taskAgentRunning, taskAgentTotal := digestCounts(t, summary.TaskDigest)
	_, _, _, dagAgentRunning, dagAgentTotal := digestCounts(t, summary.DagDigest)
	if taskAgentRunning != maxActivityDigestEntries+1 || taskAgentTotal != maxActivityDigestEntries+2 ||
		dagAgentRunning != taskAgentRunning || dagAgentTotal != taskAgentTotal {
		t.Fatalf("agent authority task=%d/%d dag=%d/%d, want %d/%d", taskAgentRunning, taskAgentTotal,
			dagAgentRunning, dagAgentTotal, maxActivityDigestEntries+1, maxActivityDigestEntries+2)
	}
	assertDispatch := func(frame Frame, wantRunning, wantTotal int) {
		t.Helper()
		wire := frame.Data.(map[string]any)["data"]
		payload, _ := json.Marshal(wire)
		var counts struct {
			RunningCount      int `json:"running_count"`
			TotalCount        int `json:"total_count"`
			AgentRunningCount int `json:"agent_running_count"`
			AgentTotalCount   int `json:"agent_total_count"`
		}
		if err := json.Unmarshal(payload, &counts); err != nil {
			t.Fatal(err)
		}
		name := frame.Data.(map[string]any)["name"]
		if counts.AgentRunningCount != wantRunning || counts.AgentTotalCount != wantTotal {
			t.Fatalf("dispatch %v aggregate = %d/%d, want %d/%d", name, counts.AgentRunningCount, counts.AgentTotalCount, wantRunning, wantTotal)
		}
		if name == activitySnapshotOrder[0] && (counts.RunningCount != maxActivityDigestEntries || counts.TotalCount != maxActivityDigestEntries+1) {
			t.Fatalf("task dispatch scalar = %d/%d", counts.RunningCount, counts.TotalCount)
		}
		if name == activitySnapshotOrder[1] && counts.RunningCount != 2 {
			t.Fatalf("DAG dispatch running scalar = %d", counts.RunningCount)
		}
	}
	assertDispatch(taskDispatch, maxActivityDigestEntries, maxActivityDigestEntries+1)
	assertDispatch(dagDispatch, maxActivityDigestEntries+1, maxActivityDigestEntries+2)
	for _, replay := range h.s.ActivitySnapshot() {
		assertDispatch(replay, maxActivityDigestEntries+1, maxActivityDigestEntries+2)
	}
}

func TestHistoricalExactCountsBeforeScanLimits(t *testing.T) {
	cwd := t.TempDir()
	for i := 0; i < maxActivityHistoryFiles+1; i++ {
		writeActivityStoreJSON(t, filepath.Join(cwd, ".omo", "senpi-task", "tasks", fmt.Sprintf("%04d.json", i)), map[string]any{
			"task_id": fmt.Sprintf("task-%04d", i), "name": "task", "status": "running", "parent_session_id": "parent",
			"created_at": fmt.Sprintf("2026-09-03T12:%02d:%02dZ", (i/60)%60, i%60),
		})
	}
	writeActivityStoreJSON(t, filepath.Join(cwd, ".omo", "senpi-task", "dag", "runs", "run.json"), map[string]any{
		"schemaVersion": 1, "runId": "run", "runKey": "run", "name": "run", "parentSessionId": "parent", "status": "running",
		"createdAt": "2026-09-03T12:00:00Z", "updatedAt": "2026-09-03T12:01:00Z",
		"nodes": []any{
			map[string]any{"id": "overlap", "taskId": "task-0000", "state": "running"},
			map[string]any{"id": "dag-only", "state": "running"},
		},
	})
	activity, err := ReadHistoricalActivity(t.Context(), cwd, "parent")
	if err != nil {
		t.Fatal(err)
	}
	if activity.TaskDigest.RunningCount != maxActivityHistoryFiles+1 || activity.TaskDigest.TotalCount != maxActivityHistoryFiles+1 {
		t.Fatalf("task counts = %d/%d, want %d/%d", activity.TaskDigest.RunningCount, activity.TaskDigest.TotalCount,
			maxActivityHistoryFiles+1, maxActivityHistoryFiles+1)
	}
	_, _, _, agentRunning, agentTotal := digestCounts(t, activity.TaskDigest)
	if activity.DagDigest.RunningCount != 2 || agentRunning != maxActivityHistoryFiles+2 || agentTotal != maxActivityHistoryFiles+2 {
		t.Fatalf("historical authority task=%+v dag=%+v agent=%d/%d", activity.TaskDigest, activity.DagDigest, agentRunning, agentTotal)
	}
	if !activity.TaskDigest.Truncated || len(activity.TaskDigest.Tasks) > maxActivityDigestEntries {
		t.Fatalf("bounded rows = %d truncated=%v", len(activity.TaskDigest.Tasks), activity.TaskDigest.Truncated)
	}

	byteCWD := t.TempDir()
	const byteRecords = 10
	for i := 0; i < byteRecords; i++ {
		writeActivityStoreJSON(t, filepath.Join(byteCWD, ".omo", "senpi-task", "tasks", fmt.Sprintf("%02d.json", i)), map[string]any{
			"task_id": fmt.Sprintf("large-%02d", i), "name": "task", "status": "running", "parent_session_id": "parent",
			"created_at": fmt.Sprintf("2026-09-03T12:00:%02dZ", i), "task_summary": strings.Repeat("x", 7<<19),
		})
	}
	byteActivity, err := ReadHistoricalActivity(t.Context(), byteCWD, "parent")
	if err != nil {
		t.Fatal(err)
	}
	if byteActivity.TaskDigest.RunningCount != byteRecords || byteActivity.TaskDigest.TotalCount != byteRecords || !byteActivity.TaskDigest.Truncated {
		t.Fatalf("byte-budget authority = %+v, want %d exact records with bounded rows", byteActivity.TaskDigest, byteRecords)
	}
}
