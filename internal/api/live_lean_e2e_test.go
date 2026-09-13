package api

import "testing"

func TestLiveLeanPayload_whenTaskAndDAGActivityArrive(t *testing.T) {
	// Given a real server with an attached chat and an established subscription.
	fixture := newCountsE2EFixture(t)
	fixture.attachChat()
	_, frames := fixture.connectSubscribe()
	fixture.daemon.EmitSession(fixture.chat.SessionFile, map[string]any{
		"type": "extension_event", "name": "omo.task.updated",
		"data": map[string]any{"tasks": []any{
			map[string]any{"task_id": "shared", "status": "running", "updated_at": "2026-09-13T12:00:01Z", "live_progress": map[string]any{"last_assistant_line": "progress"}},
			map[string]any{"task_id": "done", "status": "completed", "updated_at": "2026-09-13T12:00:00Z", "live_progress": map[string]any{"last_assistant_line": "older"}},
		}, "live_progress": map[string]any{"last_assistant_line": "wrong root source"}},
	})
	frames.next(t, "sessions.activity")
	// When a DAG snapshot overlaps the task roster and contributes independent work.
	fixture.daemon.EmitSession(fixture.chat.SessionFile, map[string]any{
		"type": "extension_event", "name": "omo.dag.updated",
		"data": map[string]any{"runs": []any{
			map[string]any{"run_id": "r1", "status": "running", "updated_at": "2026-09-13T12:00:02Z", "counts": map[string]any{"completed": 2, "total": 5}, "nodes": []any{
				map[string]any{"id": "n1", "task_id": "shared", "state": "running"},
				map[string]any{"id": "n2", "task_id": "independent", "state": "running"},
			}},
			map[string]any{"run_id": "r2", "status": "completed", "updated_at": "2026-09-13T12:00:02Z", "counts": map[string]any{"completed": 3, "total": 3}, "nodes": []any{}},
		}},
	})
	frame := frames.next(t, "sessions.activity")
	rows := fetchLiveRows(t, fixture.serverURL, fixture.token)
	// Then both real wire surfaces expose only the same rendered scalar values.
	for name, row := range map[string]map[string]any{"REST": rows[0], "WS": frame} {
		t.Run(name, func(t *testing.T) {
			for _, key := range []string{"task", "dag", "task_digest", "dag_digest", "taskDigest", "dagDigest", "snapshots", "task_oversized", "dag_oversized"} {
				if _, exists := row[key]; exists {
					t.Errorf("raw payload key %q remains on %s", key, name)
				}
			}
			for key, want := range map[string]any{"done": float64(1), "dag_done": float64(5), "dag_total": float64(8), "last_line": "progress"} {
				if row[key] != want {
					t.Errorf("%s = %v, want %v", key, row[key], want)
				}
			}
			running, ok := row["running"].(map[string]any)
			if !ok {
				t.Fatal("running fields absent")
			}
			for key, want := range map[string]float64{"agents": 2, "tasks": 1, "dag": 1} {
				if running[key] != want {
					t.Errorf("running.%s = %v, want %v", key, running[key], want)
				}
			}
			truncated, ok := row["truncated"].(map[string]any)
			if !ok || truncated["task"] != false || truncated["dag"] != false {
				t.Errorf("truncated = %v", row["truncated"])
			}
			if millis, ok := row["last_activity_ms"].(float64); !ok || millis <= 0 {
				t.Errorf("last_activity_ms = %v", row["last_activity_ms"])
			}
		})
	}
}
