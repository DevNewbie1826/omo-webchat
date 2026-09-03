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

func TestHistoricalActivitySnapshotCapKeepsDigest(t *testing.T) {
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
	if !activity.TaskOversized || len(activity.ActivityPair.Task) != 0 {
		t.Fatalf("oversized snapshot retained: flag=%v bytes=%d", activity.TaskOversized, len(activity.ActivityPair.Task))
	}
	if activity.TaskDigest == nil || len(activity.TaskDigest.Tasks) != 120 {
		t.Fatalf("digest lost with oversized snapshot: %+v", activity.TaskDigest)
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
