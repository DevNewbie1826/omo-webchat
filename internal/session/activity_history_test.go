package session

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeActivityStoreJSON(t *testing.T, path string, value any) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestReadHistoricalActivityFiltersParentAndReusesStageEightDigests(t *testing.T) {
	cwd := t.TempDir()
	base := filepath.Join(cwd, ".omo", "senpi-task")
	writeActivityStoreJSON(t, filepath.Join(base, "tasks", "match.json"), map[string]any{
		"task_id": "st-match", "status": "completed", "parent_session_id": "durable-parent",
		"name": "Inspect", "task_summary": "Inspect history", "child_session_id": "child-1",
		"created_at": "2026-09-03T10:00:00Z", "updated_at": "2026-09-03T10:01:00Z",
		"run_stats":  map[string]any{"turns": 2},
		"owner":      map[string]any{"kind": "dag", "runId": "dag-match", "nodeId": "inspect"},
		"spawn_spec": map[string]any{"prompt": "must not leak into the activity snapshot"},
	})
	writeActivityStoreJSON(t, filepath.Join(base, "tasks", "other.json"), map[string]any{
		"task_id": "st-other", "status": "completed", "parent_session_id": "other-parent", "name": "Other",
	})
	if err := os.WriteFile(filepath.Join(base, "tasks", "malformed.json"), []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	writeActivityStoreJSON(t, filepath.Join(base, "dag", "runs", "dag-match.json"), map[string]any{
		"schemaVersion": 1, "runId": "dag-match", "runKey": "history", "name": "History DAG",
		// Owner linkage from the matching task is an accepted fallback when an
		// older checkpoint lacks a parentSessionId.
		"status": "completed", "createdAt": "2026-09-03T10:00:00Z", "updatedAt": "2026-09-03T10:01:00Z",
		"definition": map[string]any{"nodes": []any{map[string]any{
			"id": "inspect", "label": "Inspect", "prompt": "Inspect history", "dependsOn": []any{},
		}}},
		"nodes": []any{map[string]any{
			"id": "inspect", "state": "completed", "attempt": 1, "taskId": "st-match",
			"startedAt": "2026-09-03T10:00:00Z", "completedAt": "2026-09-03T10:01:00Z",
		}},
	})
	writeActivityStoreJSON(t, filepath.Join(base, "dag", "runs", "dag-other.json"), map[string]any{
		"runId": "dag-other", "runKey": "other", "name": "Other DAG", "parentSessionId": "other-parent", "status": "completed",
	})

	activity, err := ReadHistoricalActivity(t.Context(), cwd, "durable-parent")
	if err != nil {
		t.Fatal(err)
	}
	var taskSnapshot struct {
		Parent string                       `json:"parent_session_id"`
		Tasks  []map[string]json.RawMessage `json:"tasks"`
	}
	if err := json.Unmarshal(activity.ActivityPair.Task, &taskSnapshot); err != nil {
		t.Fatal(err)
	}
	if taskSnapshot.Parent != "durable-parent" || len(taskSnapshot.Tasks) != 1 {
		t.Fatalf("task snapshot = %s", activity.ActivityPair.Task)
	}
	if _, leaked := taskSnapshot.Tasks[0]["spawn_spec"]; leaked {
		t.Fatalf("task snapshot leaked store-only fields: %s", activity.ActivityPair.Task)
	}
	if activity.TaskDigest == nil || len(activity.TaskDigest.Tasks) != 1 || activity.TaskDigest.Tasks[0].TaskID != "st-match" || activity.TaskDigest.Tasks[0].Status != "completed" {
		t.Fatalf("task digest = %+v", activity.TaskDigest)
	}
	// Shape parity is pinned through the same stage-8 parser, not a parallel
	// digest implementation.
	wantTaskDigest, ok := parseTaskDigest(activity.ActivityPair.Task)
	if !ok || len(wantTaskDigest.Tasks) != len(activity.TaskDigest.Tasks) || wantTaskDigest.Tasks[0] != activity.TaskDigest.Tasks[0] {
		t.Fatalf("task digest drift: reader=%+v parser=%+v", activity.TaskDigest, wantTaskDigest)
	}

	var dagSnapshot struct {
		Runs []struct {
			RunID  string `json:"run_id"`
			Status string `json:"status"`
			Nodes  []struct {
				TaskID    string   `json:"task_id"`
				DependsOn []string `json:"depends_on"`
			} `json:"nodes"`
		} `json:"runs"`
	}
	if err := json.Unmarshal(activity.ActivityPair.Dag, &dagSnapshot); err != nil {
		t.Fatal(err)
	}
	if len(dagSnapshot.Runs) != 1 || dagSnapshot.Runs[0].RunID != "dag-match" || len(dagSnapshot.Runs[0].Nodes) != 1 || dagSnapshot.Runs[0].Nodes[0].TaskID != "st-match" {
		t.Fatalf("dag snapshot = %s", activity.ActivityPair.Dag)
	}
	wantDagDigest, ok := parseDagDigest(activity.ActivityPair.Dag)
	if !ok || activity.DagDigest == nil || len(wantDagDigest.Runs) != len(activity.DagDigest.Runs) {
		t.Fatalf("dag digest drift: reader=%+v parser=%+v", activity.DagDigest, wantDagDigest)
	}
}

func TestReadHistoricalActivityExcludesOwnedRunWithConflictingParent(t *testing.T) {
	cwd := t.TempDir()
	base := filepath.Join(cwd, ".omo", "senpi-task")
	writeActivityStoreJSON(t, filepath.Join(base, "tasks", "owned.json"), map[string]any{
		"task_id": "task-owned", "status": "running", "parent_session_id": "durable-parent",
		"owner": map[string]any{"kind": "dag", "runId": "run-conflict"},
	})
	writeActivityStoreJSON(t, filepath.Join(base, "dag", "runs", "conflict.json"), map[string]any{
		"runId": "run-conflict", "status": "running", "parentSessionId": "foreign-parent",
	})

	activity, err := ReadHistoricalActivity(t.Context(), cwd, "durable-parent")
	if err != nil {
		t.Fatal(err)
	}
	var snapshot struct {
		Runs []activityDagRun `json:"runs"`
	}
	if err := json.Unmarshal(activity.ActivityPair.Dag, &snapshot); err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Runs) != 0 || len(activity.DagDigest.Runs) != 0 {
		t.Fatalf("conflicting-parent run was included: snapshot=%s digest=%+v", activity.ActivityPair.Dag, activity.DagDigest)
	}
}

func TestReadHistoricalActivityRetainsNewestRowsAfterOrdering(t *testing.T) {
	cwd := t.TempDir()
	dir := filepath.Join(cwd, ".omo", "senpi-task", "tasks")
	for i := 0; i < maxActivityDigestEntries+20; i++ {
		writeActivityStoreJSON(t, filepath.Join(dir, fmt.Sprintf("%04d.json", i)), map[string]any{
			"task_id": fmt.Sprintf("task-%04d", i), "status": "completed", "parent_session_id": "parent",
			"created_at": fmt.Sprintf("2026-09-03T12:%02d:%02dZ", i/60, i%60),
		})
	}

	activity, err := ReadHistoricalActivity(t.Context(), cwd, "parent")
	if err != nil {
		t.Fatal(err)
	}
	if !activity.TaskDigest.Truncated || len(activity.TaskDigest.Tasks) != maxActivityDigestEntries {
		t.Fatalf("digest retention = %+v", activity.TaskDigest)
	}
	if got := activity.TaskDigest.Tasks[0].TaskID; got != fmt.Sprintf("task-%04d", maxActivityDigestEntries+19) {
		t.Fatalf("first retained task = %q, want newest", got)
	}
	for _, row := range activity.TaskDigest.Tasks {
		if row.TaskID == "task-0000" {
			t.Fatal("oldest lexical row displaced a newer row")
		}
	}
}

func TestHistoricalActivitySnapshotCapKeepsNewestPrefix(t *testing.T) {
	cwd := t.TempDir()
	dir := filepath.Join(cwd, ".omo", "senpi-task", "tasks")
	for i := 0; i < 120; i++ {
		writeActivityStoreJSON(t, filepath.Join(dir, fmt.Sprintf("%03d.json", i)), map[string]any{
			"task_id": fmt.Sprintf("task-%03d", i), "status": "completed", "parent_session_id": "parent",
			"created_at":     fmt.Sprintf("2026-09-03T12:%02d:%02dZ", i/60, i%60),
			"final_response": strings.Repeat("x", 1024),
		})
	}
	activity, err := ReadHistoricalActivity(t.Context(), cwd, "parent")
	if err != nil {
		t.Fatal(err)
	}
	var snapshot historicalTaskSnapshot
	if err := json.Unmarshal(activity.ActivityPair.Task, &snapshot); err != nil {
		t.Fatal(err)
	}
	if !activity.TaskOversized || len(activity.ActivityPair.Task) > maxActivitySnapshotBytes || len(snapshot.Tasks) == 0 || !snapshot.Truncated {
		t.Fatalf("bounded prefix: flag=%v bytes=%d rows=%d truncated=%v", activity.TaskOversized, len(activity.ActivityPair.Task), len(snapshot.Tasks), snapshot.Truncated)
	}
	if got := rawString(snapshot.Tasks[0]["task_id"]); got != "task-119" {
		t.Fatalf("first task = %q, want newest", got)
	}
	if activity.TaskDigest == nil || len(activity.TaskDigest.Tasks) != len(snapshot.Tasks) || !activity.TaskDigest.Truncated {
		t.Fatalf("digest does not describe retained prefix: %+v", activity.TaskDigest)
	}
	digest, err := json.Marshal(activity.TaskDigest)
	if err != nil || len(digest) > maxActivitySnapshotBytes {
		t.Fatalf("task digest bytes=%d err=%v", len(digest), err)
	}
}

func TestHistoricalActivityRealisticLargeStoreKeepsTaskAndDagPrefixes(t *testing.T) {
	cwd := t.TempDir()
	base := filepath.Join(cwd, ".omo", "senpi-task")
	for i := 0; i < 110; i++ {
		writeActivityStoreJSON(t, filepath.Join(base, "tasks", fmt.Sprintf("task-%03d.json", i)), map[string]any{
			"task_id": fmt.Sprintf("task-%03d", i), "status": "completed", "parent_session_id": "parent",
			"name": "Audit task", "task_summary": strings.Repeat("summary ", 120), "final_response": strings.Repeat("result ", 180),
			"created_at": fmt.Sprintf("2026-09-03T%02d:%02d:00Z", i/60, i%60), "updated_at": "2026-09-03T23:59:00Z",
			"spawn_spec": map[string]any{"prompt": strings.Repeat("store-only ", 200)},
		})
	}
	for run := 0; run < 16; run++ {
		definitions := make([]any, 8)
		nodes := make([]any, 8)
		for node := range definitions {
			definitions[node] = map[string]any{"id": fmt.Sprintf("node-%02d", node), "label": "Audit node", "prompt": strings.Repeat("inspect ", 140), "dependsOn": []string{}}
			nodes[node] = map[string]any{"id": fmt.Sprintf("node-%02d", node), "state": "completed", "attempt": 1, "taskId": fmt.Sprintf("task-%03d", run*8+node)}
		}
		writeActivityStoreJSON(t, filepath.Join(base, "dag", "runs", fmt.Sprintf("run-%02d.json", run)), map[string]any{
			"runId": fmt.Sprintf("run-%02d", run), "runKey": fmt.Sprintf("audit-%02d", run), "name": "Audit DAG", "status": "completed",
			"parentSessionId": "parent", "createdAt": fmt.Sprintf("2026-09-03T%02d:00:00Z", run),
			"definition": map[string]any{"nodes": definitions}, "nodes": nodes,
		})
	}

	activity, err := ReadHistoricalActivity(t.Context(), cwd, "parent")
	if err != nil {
		t.Fatal(err)
	}
	var tasks historicalTaskSnapshot
	var dags historicalDagSnapshot
	if err := json.Unmarshal(activity.ActivityPair.Task, &tasks); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(activity.ActivityPair.Dag, &dags); err != nil {
		t.Fatal(err)
	}
	if len(tasks.Tasks) == 0 || len(dags.Runs) == 0 || !tasks.Truncated || !dags.Truncated {
		t.Fatalf("prefixes: task rows=%d truncated=%v; dag rows=%d truncated=%v", len(tasks.Tasks), tasks.Truncated, len(dags.Runs), dags.Truncated)
	}
	if len(activity.ActivityPair.Task) > maxActivitySnapshotBytes || len(activity.ActivityPair.Dag) > maxActivitySnapshotBytes {
		t.Fatalf("snapshot sizes: task=%d dag=%d", len(activity.ActivityPair.Task), len(activity.ActivityPair.Dag))
	}
	if rawString(tasks.Tasks[0]["task_id"]) != "task-109" || dags.Runs[0].RunID != "run-15" {
		t.Fatalf("prefix heads: task=%q dag=%q", rawString(tasks.Tasks[0]["task_id"]), dags.Runs[0].RunID)
	}
}

func TestHistoricalActivityDigestsAreByteBounded(t *testing.T) {
	taskDigest := &TaskDigest{Tasks: make([]TaskDigestEntry, 32)}
	for i := range taskDigest.Tasks {
		taskDigest.Tasks[i] = TaskDigestEntry{TaskID: strings.Repeat("task", 1024), Status: "running", UpdatedAt: strings.Repeat("time", 1024)}
	}
	boundTaskDigest(taskDigest)
	taskPayload, err := json.Marshal(taskDigest)
	if err != nil || len(taskPayload) > maxActivitySnapshotBytes || !taskDigest.Truncated {
		t.Fatalf("task digest bytes=%d truncated=%v err=%v", len(taskPayload), taskDigest.Truncated, err)
	}

	dagDigest := &DagDigest{Runs: []RunDigestEntry{{RunID: strings.Repeat("run", 1024), Status: "running", RunningTaskIDs: make([]string, 32)}}}
	for i := range dagDigest.Runs[0].RunningTaskIDs {
		dagDigest.Runs[0].RunningTaskIDs[i] = strings.Repeat("task", 1024)
	}
	boundDagDigest(dagDigest)
	dagPayload, err := json.Marshal(dagDigest)
	if err != nil || len(dagPayload) > maxActivitySnapshotBytes || !dagDigest.Truncated {
		t.Fatalf("DAG digest bytes=%d truncated=%v err=%v", len(dagPayload), dagDigest.Truncated, err)
	}
}

func TestActivityHistoryDirectoryBudgetAndCancellation(t *testing.T) {
	dir := t.TempDir()
	writeActivityStoreJSON(t, filepath.Join(dir, "a.json"), map[string]any{"ok": true})
	writeActivityStoreJSON(t, filepath.Join(dir, "b.json"), map[string]any{"ok": true})
	budget := &activityHistoryBudget{files: maxActivityHistoryFiles - 1}
	visited := 0
	exhausted, err := readActivityDirectory(t.Context(), dir, budget, func(string, os.FileInfo) { visited++ })
	if err != nil || !exhausted || visited != 1 {
		t.Fatalf("budget result: exhausted=%v visited=%d err=%v", exhausted, visited, err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = ReadHistoricalActivity(ctx, t.TempDir(), "parent")
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled read error = %v", err)
	}
}

func TestReadHistoricalActivityNewestCandidateAndIndependentDagBudget(t *testing.T) {
	cwd := t.TempDir()
	base := filepath.Join(cwd, ".omo", "senpi-task")
	for i := 0; i < maxActivityHistoryFiles; i++ {
		writeActivityStoreJSON(t, filepath.Join(base, "tasks", fmt.Sprintf("foreign-%04d.json", i)), map[string]any{
			"task_id": fmt.Sprintf("foreign-%04d", i), "status": "completed", "parent_session_id": "foreign",
		})
	}
	writeActivityStoreJSON(t, filepath.Join(base, "tasks", "zzzz-newest.json"), map[string]any{
		"task_id": "newest", "status": "running", "parent_session_id": "parent", "created_at": "2026-09-03T23:59:59Z",
	})
	writeActivityStoreJSON(t, filepath.Join(base, "dag", "runs", "run.json"), map[string]any{
		"runId": "run", "runKey": "run", "name": "Run", "status": "running", "parentSessionId": "parent",
	})

	activity, err := ReadHistoricalActivity(t.Context(), cwd, "parent")
	if err != nil {
		t.Fatal(err)
	}
	var tasks historicalTaskSnapshot
	var dags historicalDagSnapshot
	if err := json.Unmarshal(activity.ActivityPair.Task, &tasks); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(activity.ActivityPair.Dag, &dags); err != nil {
		t.Fatal(err)
	}
	if len(tasks.Tasks) != 1 || rawString(tasks.Tasks[0]["task_id"]) != "newest" || !tasks.Truncated {
		t.Fatalf("task prefix = %s", activity.ActivityPair.Task)
	}
	if len(dags.Runs) != 1 || dags.Runs[0].RunID != "run" {
		t.Fatalf("DAG was starved by task budget: %s", activity.ActivityPair.Dag)
	}
}

func TestReadHistoricalActivityTreatsOptionalStoreFilesAsAbsent(t *testing.T) {
	cwd := t.TempDir()
	base := filepath.Join(cwd, ".omo", "senpi-task")
	if err := os.MkdirAll(base, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(base, "tasks"), []byte("not a directory"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(base, "dag"), []byte("not a directory"), 0o600); err != nil {
		t.Fatal(err)
	}
	activity, err := ReadHistoricalActivity(t.Context(), cwd, "parent")
	if err != nil {
		t.Fatal(err)
	}
	if activity.TaskDigest == nil || len(activity.TaskDigest.Tasks) != 0 || activity.DagDigest == nil || len(activity.DagDigest.Runs) != 0 {
		t.Fatalf("non-directory optional stores = %+v", activity)
	}
}

func TestReadHistoricalActivityWithoutDurableIdentityIsEmpty(t *testing.T) {
	cwd := t.TempDir()
	writeActivityStoreJSON(t, filepath.Join(cwd, ".omo", "senpi-task", "tasks", "unlinked.json"), map[string]any{
		"task_id": "unlinked", "status": "completed", "name": "Unlinked",
	})
	activity, err := ReadHistoricalActivity(t.Context(), cwd, "")
	if err != nil {
		t.Fatal(err)
	}
	if activity.TaskDigest == nil || len(activity.TaskDigest.Tasks) != 0 || activity.DagDigest == nil || len(activity.DagDigest.Runs) != 0 {
		t.Fatalf("unidentified history = %+v", activity)
	}
}
