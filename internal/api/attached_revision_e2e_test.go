package api

import (
	"fmt"
	"math"
	"testing"
)

func requireAttachedWireRevision(t *testing.T, frame map[string]any) float64 {
	t.Helper()
	revision, ok := frame["revision"].(float64)
	if !ok || revision <= 0 || revision > 9007199254740991 || math.Trunc(revision) != revision {
		t.Fatalf("attached content lacks safe production revision: %v", frame)
	}
	return revision
}

// Adapted from the same-binding review fixture: all observations cross the
// authenticated server, with no capture files or external test artifacts.
func TestAttachedRevisionSameBindingAuthenticatedWire(t *testing.T) {
	// Given one attached binding and an independent overview subscriber.
	f := newLiveResolveFixture(t)
	f.saveChatClaiming("A", "A", "")
	conn, attached := f.connectUnsubscribed()
	defer conn.WriteClose(1000, nil)
	writeActivityE2EFrame(t, conn, map[string]any{
		"type": "chat.create", "wsId": f.storeWorkspaceID(), "chatId": "A",
	})
	ready := attached.next(t, "ready")
	binding := requireBindingIncarnation(t, ready, "")
	chat, err := f.store.GetChat("A")
	if err != nil {
		t.Fatal(err)
	}
	overview := f.subscribeExplicit("A")
	emit := func(name string, data map[string]any) map[string]any {
		t.Helper()
		f.daemon.EmitSession(chat.SessionFile, map[string]any{
			"type": "extension_event", "name": name, "data": data, "revision": 9007199254740991,
		})
		frame := attached.next(t, "extensionEvent")
		if frame["name"] != name {
			t.Fatalf("attached stream order differs: %v", frame)
		}
		requireBindingIncarnation(t, frame, binding)
		return frame
	}
	capture := func(count, second int) []map[string]any {
		t.Helper()
		tasks := make([]any, count)
		for i := range tasks {
			tasks[i] = map[string]any{
				"task_id": fmt.Sprintf("task-%d", i), "status": "running",
				"created_at": "2026-09-26T00:00:00Z",
				"updated_at": fmt.Sprintf("2026-09-26T00:00:%02dZ", second),
			}
		}
		task := emit("omo.task.updated", map[string]any{
			"parent_session_id": chat.DurableSessionID, "tasks": tasks,
			"truncated_tasks": false, "agent_running_count": count, "agent_total_count": count,
		})
		dag := emit("omo.dag.updated", map[string]any{
			"parent_session_id": chat.DurableSessionID, "runs": []any{},
			"agent_running_count": count, "agent_total_count": count,
		})
		activity := emit("omo.dag.activity", map[string]any{
			"runId": "run", "nodeId": "node", "taskId": "task-0",
			"at":                fmt.Sprintf("2026-09-26T00:00:%02dZ", second+1),
			"lastAssistantLine": fmt.Sprintf("activity at count %d", count),
		})
		for range 16 {
			frame := overview.next(t, "sessions.activity")
			requireBindingIncarnation(t, frame, binding)
			if running, ok := frame["running"].(map[string]any); ok && running["agents"] == float64(count) {
				return []map[string]any{task, dag, activity}
			}
		}
		t.Fatalf("missing overview count %d", count)
		return nil
	}
	// When earlier task/DAG/activity frames survive a newer same-binding row.
	old := capture(7, 1)
	current := capture(2, 4)
	row := assertSoleLiveRow(t, f.serverURL, f.token)
	assertLiveRowTasks(t, row, 2)
	requireBindingIncarnation(t, row, binding)
	currentOverview, ok := row["last_activity_ms"].(float64)
	if !ok {
		t.Fatalf("overview lacks revision: %v", row)
	}
	// Then the old frames cannot claim authority over the current overview.
	for i, frame := range old {
		oldRevision := requireAttachedWireRevision(t, frame)
		newRevision := requireAttachedWireRevision(t, current[i])
		if oldRevision >= currentOverview || newRevision <= oldRevision {
			t.Fatalf("same-binding revisions are not comparable: old=%v new=%v overview=%v", oldRevision, newRevision, currentOverview)
		}
	}
	writeActivityE2EFrame(t, conn, map[string]any{"type": "activity.refresh", "sessionId": "A"})
	for i := range 2 {
		frame := attached.next(t, "extensionEvent")
		requireBindingIncarnation(t, frame, binding)
		if got, want := requireAttachedWireRevision(t, frame), requireAttachedWireRevision(t, current[i]); got != want {
			t.Fatalf("refresh restamped cached content: got %v want %v", got, want)
		}
	}
}
