package chat

import (
	"encoding/json"
	"strings"
	"testing"
)

func oversizedActivityData(side string) string {
	return `{"` + side + `":{"pad":"` + strings.Repeat("a", maxActivitySnapshotBytes+1024) + `"}}`
}

func liveManagerWith(t *testing.T, s *Session) *Manager {
	t.Helper()
	manager := NewManager()
	t.Cleanup(manager.CloseAll)
	manager.sessions[s.id] = s
	return manager
}

func requireLiveSummary(t *testing.T, manager *Manager) LiveSummary {
	t.Helper()
	summaries := manager.LiveSummaries()
	if len(summaries) != 1 {
		t.Fatalf("LiveSummaries len = %d, want 1", len(summaries))
	}
	return summaries[0]
}

func TestOversizedActivitySnapshotReportsLiveFlagAndLeavesCacheUnchanged(t *testing.T) {
	tests := []struct {
		name      string
		id        string
		eventName string
		side      string
		cached    string
		wantTask  bool
		wantDag   bool
	}{
		{
			name:      "task side",
			id:        "chat-oversize-task",
			eventName: "omo.task.updated",
			side:      "task",
			cached:    `{"task":{"id":"st_cached"}}`,
			wantTask:  true,
		},
		{
			name:      "dag side",
			id:        "chat-oversize-dag",
			eventName: "omo.dag.updated",
			side:      "dag",
			cached:    `{"dag":{"nodes":[{"id":"st_cached"}]}}`,
			wantDag:   true,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Given: a live session with an in-cap snapshot already cached.
			s := newTestSession(tt.id, nil)
			dispatchEvent(s, "extension_event", `{"type":"extension_event","name":"`+tt.eventName+`","data":`+tt.cached+`}`)
			manager := liveManagerWith(t, s)

			// When: a payload over the cache cap is delivered for that side.
			dispatchEvent(s, "extension_event", `{"type":"extension_event","name":"`+tt.eventName+`","data":`+oversizedActivityData(tt.side)+`}`)

			// Then: the cached snapshot is unchanged and only that side is oversized.
			pair := s.ActivitySnapshot()
			if tt.side == "task" && string(pair.Task) != tt.cached {
				t.Fatalf("cached task = %s, want unchanged %s", pair.Task, tt.cached)
			}
			if tt.side == "dag" && string(pair.Dag) != tt.cached {
				t.Fatalf("cached dag = %s, want unchanged %s", pair.Dag, tt.cached)
			}
			summary := requireLiveSummary(t, manager)
			if summary.TaskOversized != tt.wantTask {
				t.Fatalf("TaskOversized = %v, want %v", summary.TaskOversized, tt.wantTask)
			}
			if summary.DagOversized != tt.wantDag {
				t.Fatalf("DagOversized = %v, want %v", summary.DagOversized, tt.wantDag)
			}
			if tt.side == "task" && string(summary.Pair.Task) != tt.cached {
				t.Fatalf("LiveSummaries task = %s, want cached %s", summary.Pair.Task, tt.cached)
			}
			if tt.side == "dag" && string(summary.Pair.Dag) != tt.cached {
				t.Fatalf("LiveSummaries dag = %s, want cached %s", summary.Pair.Dag, tt.cached)
			}
		})
	}
}

func TestInCapActivitySnapshotAfterOversizedClearsLiveFlag(t *testing.T) {
	tests := []struct {
		name      string
		id        string
		eventName string
		side      string
		small     string
	}{
		{
			name:      "task side",
			id:        "chat-oversize-task-clear",
			eventName: "omo.task.updated",
			side:      "task",
			small:     `{"task":{"id":"st_small"}}`,
		},
		{
			name:      "dag side",
			id:        "chat-oversize-dag-clear",
			eventName: "omo.dag.updated",
			side:      "dag",
			small:     `{"dag":{"nodes":[{"id":"st_small"}]}}`,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Given: a live session whose latest replayable payload was oversized.
			s := newTestSession(tt.id, nil)
			manager := liveManagerWith(t, s)
			dispatchEvent(s, "extension_event", `{"type":"extension_event","name":"`+tt.eventName+`","data":`+oversizedActivityData(tt.side)+`}`)
			if summary := requireLiveSummary(t, manager); !summary.TaskOversized && !summary.DagOversized {
				t.Fatal("oversized delivery did not set a live oversized flag")
			}

			// When: a later in-cap payload arrives for the same side.
			dispatchEvent(s, "extension_event", `{"type":"extension_event","name":"`+tt.eventName+`","data":`+tt.small+`}`)

			// Then: the flag clears and the cache holds the in-cap payload.
			pair := s.ActivitySnapshot()
			summary := requireLiveSummary(t, manager)
			if tt.side == "task" {
				if string(pair.Task) != tt.small {
					t.Fatalf("cached task = %s, want %s", pair.Task, tt.small)
				}
				if summary.TaskOversized {
					t.Fatal("TaskOversized still true, want cleared")
				}
				if summary.DagOversized {
					t.Fatal("DagOversized = true, want false")
				}
			} else {
				if string(pair.Dag) != tt.small {
					t.Fatalf("cached dag = %s, want %s", pair.Dag, tt.small)
				}
				if summary.DagOversized {
					t.Fatal("DagOversized still true, want cleared")
				}
				if summary.TaskOversized {
					t.Fatal("TaskOversized = true, want false")
				}
			}
		})
	}
}

func TestSeedActivitySnapshotsDoesNotSetOversizedFlags(t *testing.T) {
	// Given: a restored session whose persisted pair is over the cache cap.
	s := newTestSession("chat-seed-oversize", nil)
	seed := ActivitySnapshotPair{
		Task: json.RawMessage(oversizedActivityData("task")),
		Dag:  json.RawMessage(oversizedActivityData("dag")),
	}

	// When
	s.seedActivitySnapshots(&seed)

	// Then: seed still drops oversized payloads and never raises live flags.
	pair := s.ActivitySnapshot()
	if len(pair.Task) != 0 || len(pair.Dag) != 0 {
		t.Fatalf("seeded pair = %+v, want both sides empty", pair)
	}
	summary := requireLiveSummary(t, liveManagerWith(t, s))
	if summary.TaskOversized || summary.DagOversized {
		t.Fatalf("seeded flags task=%v dag=%v, want both false", summary.TaskOversized, summary.DagOversized)
	}
}
