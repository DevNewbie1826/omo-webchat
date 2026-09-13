package session_test

import (
	"encoding/json"
	"fmt"
	"testing"
)

func assertEvictedWireScalar(t *testing.T, digest map[string]any, field string, want int, stage string) {
	t.Helper()
	if digest == nil {
		t.Fatalf("%s: task digest absent", stage)
	}
	got, present := digest[field]
	if !present {
		t.Fatalf("%s: task digest field %q absent: %v", stage, field, digest)
	}
	if number, ok := got.(float64); !ok || int(number) != want {
		t.Errorf("%s: task digest %s = %v, want %d", stage, field, got, want)
	}
}

func assertEvictedWireDigest(t *testing.T, digest map[string]any, stage string) {
	t.Helper()
	assertEvictedWireScalar(t, digest, "running_count", 0, stage)
	assertEvictedWireScalar(t, digest, "agent_running_count", 0, stage)
	assertEvictedWireScalar(t, digest, "total_count", evictedTotalCounts, stage)
	assertEvictedWireScalar(t, digest, "agent_total_count", evictedTotalCounts, stage)
	rows, _ := digest["tasks"].([]any)
	if len(rows) != evictedDigestRows {
		t.Errorf("%s: task digest rows=%d, want the %d-entry retention bound", stage, len(rows), evictedDigestRows)
	}
	for _, entry := range rows {
		if entry.(map[string]any)["task_id"] == "task-0000" {
			t.Errorf("%s: evicted victim row retained", stage)
		}
	}
}

func TestEvictedTaskOutcomePublishesCorrectedScalarsOnRESTAndActivityWS(t *testing.T) {
	f := newEvictedCountsFixture(t)
	attached, attachedFrames := f.openChat()
	defer attached.WriteClose(1000, nil)

	subscribeConn, frames := f.connect()
	defer subscribeConn.WriteClose(1000, nil)
	writeEvictedCountsFrame(t, subscribeConn, map[string]any{"type": "sessions.subscribe", "mode": "explicit", "sessionIds": []string{f.chat.ID}})
	if ack := frames.next(t, "ack"); ack["command"] != "sessions.subscribe" {
		t.Fatalf("subscription ack = %v", ack)
	}

	tasks := make([]any, evictedTotalCounts)
	for i := range tasks {
		status := "completed"
		if i == 0 {
			status = "running"
		}
		tasks[i] = map[string]any{
			"task_id": fmt.Sprintf("task-%04d", i), "name": fmt.Sprintf("Task %d", i),
			"status": status, "updated_at": "2026-09-10T10:02:00Z",
		}
	}
	f.daemon.EmitSession(f.chat.SessionFile, map[string]any{
		"type": "extension_event", "name": "omo.task.updated",
		"data": map[string]any{"parent_session_id": f.chat.DurableSessionID, "truncated_tasks": false, "tasks": tasks},
	})
	taskFrame := frames.nextTaskCountFrame(t)
	assertEvictedWireScalar(t, taskFrame["running"].(map[string]any), "tasks", 1, "WS/initial")
	assertEvictedWireScalar(t, taskFrame, "done", evictedTotalCounts-1, "WS/initial")
	initial := attachedFrames.next(t, "extensionEvent")
	if initial["name"] != "omo.task.updated" {
		t.Fatalf("attached initial frame = %v", initial)
	}
	if data, ok := initial["data"].(map[string]any); !ok || data["running_count"] != float64(1) || data["total_count"] != float64(evictedTotalCounts) {
		t.Fatalf("attached initial task counts = %v", initial["data"])
	}

	f.daemon.EmitSession(f.chat.SessionFile, map[string]any{
		"type": "extension_event", "name": "omo.dag.updated",
		"data": map[string]any{
			"parent_session_id": f.chat.DurableSessionID, "truncated_runs": false,
			"runs": []any{map[string]any{
				"run_id": "outcome", "status": "completed", "updated_at": "2026-09-10T10:03:00Z",
				"nodes": []any{map[string]any{"id": "node", "task_id": "task-0000", "state": "completed"}},
			}},
		},
	})
	outcome := attachedFrames.next(t, "extensionEvent")
	if outcome["name"] != "omo.dag.updated" {
		t.Fatalf("attached outcome frame = %v", outcome)
	}
	if data, ok := outcome["data"].(map[string]any); !ok || data["agent_running_count"] != float64(0) || data["agent_total_count"] != float64(evictedTotalCounts) || data["running_count"] != float64(0) {
		t.Errorf("attached outcome authority = %v", outcome["data"])
	}
	outcomeFrame := frames.nextTaskCountFrame(t)
	for stage, row := range map[string]map[string]any{"WS": outcomeFrame, "REST": f.liveRow(t)} {
		assertEvictedWireScalar(t, row["running"].(map[string]any), "tasks", 0, stage)
		assertEvictedWireScalar(t, row["running"].(map[string]any), "agents", 0, stage)
		assertEvictedWireScalar(t, row, "done", evictedTotalCounts, stage)
		if row["truncated"].(map[string]any)["task"] != true {
			t.Errorf("%s lost eviction disclosure: %v", stage, row)
		}
	}
	// The retained digest still owns total-agent and bounded roster guarantees;
	// those per-object payloads intentionally no longer exist on either live wire.
	found := false
	for _, summary := range f.manager.LiveSummaries() {
		if summary.ChatID != f.chat.ID {
			continue
		}
		found = true
		payload, err := json.Marshal(summary.TaskDigest)
		if err != nil {
			t.Fatal(err)
		}
		var digest map[string]any
		if err := json.Unmarshal(payload, &digest); err != nil {
			t.Fatal(err)
		}
		assertEvictedWireDigest(t, digest, "retained manager digest")
	}
	if !found {
		t.Fatal("manager summary missing")
	}
}
