package session

import (
	"encoding/json"
	"reflect"
	"testing"
	"time"
)

func newActivityTestSession(t *testing.T) *Session {
	t.Helper()
	s := &Session{
		manager:              &Manager{},
		durableID:            "activity-test",
		idleAfter:            time.Hour,
		activitySnapshots:    make(map[string]json.RawMessage),
		activityOversized:    make(map[string]bool),
		completedCompactions: make(map[string]struct{}),
	}
	t.Cleanup(func() {
		s.lifecycleMu.Lock()
		s.cancelIdleLocked()
		s.lifecycleMu.Unlock()
	})
	return s
}

func activityTaskStatus(t *testing.T, raw json.RawMessage, taskID string) string {
	t.Helper()
	var payload struct {
		Tasks []TaskDigestEntry `json:"tasks"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		t.Fatalf("decode task snapshot: %v (%s)", err, raw)
	}
	for _, task := range payload.Tasks {
		if task.TaskID == taskID {
			return task.Status
		}
	}
	t.Fatalf("task %q absent from snapshot %s", taskID, raw)
	return ""
}

func TestTerminalDagArrivalReconcilesTaskSnapshotAndDigest(t *testing.T) {
	for _, test := range []struct {
		name      string
		updatedAt any
	}{
		{name: "with updated_at", updatedAt: "2026-01-01T00:00:00Z"},
		{name: "without updated_at"},
	} {
		t.Run(test.name, func(t *testing.T) {
			s := newActivityTestSession(t)
			task := map[string]any{"task_id": "t1", "status": "running"}
			if test.updatedAt != nil {
				task["updated_at"] = test.updatedAt
			}
			injectEvent(t, s, map[string]any{
				"type": "extension_event", "name": activitySnapshotOrder[0],
				"data": map[string]any{"tasks": []any{task}},
			})
			injectEvent(t, s, map[string]any{
				"type": "extension_event", "name": activitySnapshotOrder[1],
				"data": map[string]any{"runs": []any{map[string]any{
					"run_id": "r1", "status": "completed",
					"nodes": []any{map[string]any{"task_id": "t1", "state": "completed"}},
				}}},
			})

			summary, ok := s.summary()
			if !ok {
				t.Fatal("summary absent")
			}
			if got := activityTaskStatus(t, summary.ActivityPair.Task, "t1"); got != "completed" {
				t.Fatalf("snapshot task status = %q, want completed", got)
			}
			if summary.TaskDigest == nil || len(summary.TaskDigest.Tasks) != 1 || summary.TaskDigest.Tasks[0].Status != "completed" {
				t.Fatalf("task digest = %+v, want t1 completed", summary.TaskDigest)
			}
		})
	}
}

func TestAgentSettleReconcilesTaskSnapshotArrivingAfterTerminalDag(t *testing.T) {
	s := newActivityTestSession(t)
	injectEvent(t, s, map[string]any{"type": "agent_start"})
	injectEvent(t, s, map[string]any{
		"type": "extension_event", "name": activitySnapshotOrder[1],
		"data": map[string]any{"runs": []any{map[string]any{
			"run_id": "r1", "status": "failed",
			"nodes": []any{map[string]any{"task_id": "t1", "state": "failed"}},
		}}},
	})
	injectEvent(t, s, map[string]any{
		"type": "extension_event", "name": activitySnapshotOrder[0],
		"data": map[string]any{"tasks": []any{map[string]any{"task_id": "t1", "status": "running"}}},
	})
	before, _ := s.summary()
	if got := activityTaskStatus(t, before.ActivityPair.Task, "t1"); got != "running" {
		t.Fatalf("pre-settle task status = %q, want running", got)
	}

	injectEvent(t, s, map[string]any{"type": "agent_settled", "reason": "end_turn"})

	after, _ := s.summary()
	if got := activityTaskStatus(t, after.ActivityPair.Task, "t1"); got != "failed" {
		t.Fatalf("settled snapshot task status = %q, want failed", got)
	}
	if after.TaskDigest == nil || len(after.TaskDigest.Tasks) != 1 || after.TaskDigest.Tasks[0].Status != "failed" {
		t.Fatalf("settled task digest = %+v, want t1 failed", after.TaskDigest)
	}
}

func TestNullTruncatedTasksPreservesPreviousDigest(t *testing.T) {
	s := newActivityTestSession(t)
	injectEvent(t, s, map[string]any{
		"type": "extension_event", "name": activitySnapshotOrder[0],
		"data": map[string]any{"truncated_tasks": false, "tasks": []any{map[string]any{"task_id": "t1", "status": "running"}}},
	})
	before, _ := s.summary()

	injectEvent(t, s, map[string]any{
		"type": "extension_event", "name": activitySnapshotOrder[0],
		"data": map[string]any{"truncated_tasks": nil, "tasks": []any{}},
	})
	after, _ := s.summary()

	if !reflect.DeepEqual(after.TaskDigest, before.TaskDigest) {
		t.Fatalf("task digest changed after truncated_tasks:null: got %+v, want %+v", after.TaskDigest, before.TaskDigest)
	}
}
