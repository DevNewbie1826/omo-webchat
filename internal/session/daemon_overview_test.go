package session

import (
	"encoding/json"
	"errors"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

type daemonOverviewFixture struct {
	manager *Manager
	store   *resolvingCursorStore
	updates chan Summary
}

func newDaemonOverviewFixture(t *testing.T) *daemonOverviewFixture {
	t.Helper()
	store := newResolvingCursorStore()
	store.setOwner("daemon-durable", "daemon-chat", "Daemon title")
	manager := testManager(t, dial(t, newDaemon(t)), store, 64)
	updates := make(chan Summary, 64)
	unsubscribe := manager.SubscribeOverview(func(row Summary) { updates <- row })
	t.Cleanup(unsubscribe)
	return &daemonOverviewFixture{manager: manager, store: store, updates: updates}
}

func daemonObservation(status string, activity *HistoricalActivity) DaemonSession {
	return DaemonSession{DurableSessionID: "daemon-durable", Status: status, Activity: activity}
}

func daemonSoleRow(t *testing.T, manager *Manager) Summary {
	t.Helper()
	rows := manager.LiveSummaries()
	if len(rows) != 1 {
		t.Fatalf("live rows = %+v, want one", rows)
	}
	row := rows[0]
	if row.ChatID != "daemon-chat" || row.DurableSessionID != "daemon-durable" || row.Title != "Daemon title" || row.BindingID != "" {
		t.Fatalf("unattached row identity = %+v", row)
	}
	return row
}

// A later known publication is a queue barrier, not a timing-based absence
// check. Any repeat from the preceding apply must arrive before this row.
func (f *daemonOverviewFixture) assertNoRepeat(t *testing.T, current []DaemonSession) {
	t.Helper()
	f.store.setOwner("barrier-durable", "barrier-chat", "Barrier")
	f.manager.ApplyDaemonSessions(append(current, DaemonSession{DurableSessionID: "barrier-durable", Status: "working"}))
	for {
		row := awaitOverview(t, f.updates)
		if row.ChatID == "barrier-chat" {
			return
		}
		t.Fatalf("unexpected repeat publication before barrier: %+v", row)
	}
}

func TestDaemonOverviewWorkingChatRow(t *testing.T) {
	f := newDaemonOverviewFixture(t)
	f.manager.ApplyDaemonSessions([]DaemonSession{daemonObservation("working", nil)})
	published := awaitOverview(t, f.updates)
	row := daemonSoleRow(t, f.manager)
	if !row.Active || !published.Active || published.ChatID != row.ChatID || !reflect.DeepEqual(published.LiveValues(), row.LiveValues()) {
		t.Fatalf("working REST/publication = %+v / %+v", row, published)
	}
}

func TestDaemonOverviewBlockedChatRow(t *testing.T) {
	f := newDaemonOverviewFixture(t)
	f.manager.ApplyDaemonSessions([]DaemonSession{daemonObservation("blocked", nil)})
	published := awaitOverview(t, f.updates)
	if row := daemonSoleRow(t, f.manager); !row.Active || !published.Active {
		t.Fatalf("blocked row lost active: %+v / %+v", row, published)
	}
}

func TestDaemonOverviewIdlePublishesOnce(t *testing.T) {
	f := newDaemonOverviewFixture(t)
	f.manager.ApplyDaemonSessions([]DaemonSession{daemonObservation("working", nil)})
	start := awaitOverview(t, f.updates)
	idle := []DaemonSession{daemonObservation("idle", nil)}
	f.manager.ApplyDaemonSessions(idle)
	end := awaitOverview(t, f.updates)
	if row := daemonSoleRow(t, f.manager); row.Active || end.Active || *end.LiveValues().LastActivityMS <= *start.LiveValues().LastActivityMS {
		t.Fatalf("idle row/revision = %+v / %+v", row, end)
	}
	f.manager.ApplyDaemonSessions(idle)
	f.assertNoRepeat(t, idle)
}

func TestDaemonOverviewDiskExactCounts(t *testing.T) {
	f := newDaemonOverviewFixture(t)
	cwd := t.TempDir()
	taskDir := filepath.Join(cwd, ".omo", "senpi-task", "tasks")
	writeTasks := func(status, at string) {
		for _, id := range []string{"one", "two"} {
			writeActivityStoreJSON(t, filepath.Join(taskDir, id+".json"), map[string]any{
				"task_id": id, "parent_session_id": "daemon-durable", "status": status, "updated_at": at,
			})
		}
	}
	read := func() *HistoricalActivity {
		activity, err := ReadHistoricalActivity(t.Context(), cwd, "daemon-durable")
		if err != nil {
			t.Fatal(err)
		}
		return &activity
	}
	writeTasks("running", "2026-10-06T01:00:00Z")
	f.manager.ApplyDaemonSessions([]DaemonSession{daemonObservation("idle", read())})
	start := awaitOverview(t, f.updates)
	if row := daemonSoleRow(t, f.manager); row.Active || row.LiveValues().Running.Agents != 2 || row.LiveValues().Running.Tasks != 2 || start.LiveValues().Running.Agents != 2 {
		t.Fatalf("disk exact counts = %+v / %+v", row.LiveValues(), start.LiveValues())
	}
	// A failed disk read (nil) retains previous exact counts.
	f.manager.ApplyDaemonSessions([]DaemonSession{daemonObservation("idle", nil)})
	if daemonSoleRow(t, f.manager).LiveValues().Running.Agents != 2 {
		t.Fatal("failed disk read lost counts")
	}
	writeTasks("completed", "2026-10-06T01:01:00Z")
	completed := []DaemonSession{daemonObservation("idle", read())}
	f.manager.ApplyDaemonSessions(completed)
	end := awaitOverview(t, f.updates)
	if row := daemonSoleRow(t, f.manager); row.LiveValues().Running.Agents != 0 || row.LiveValues().Running.Tasks != 0 || end.LiveValues().Running.Agents != 0 ||
		*end.LiveValues().LastActivityMS <= *start.LiveValues().LastActivityMS {
		t.Fatalf("completed counts = %+v / %+v", row.LiveValues(), end.LiveValues())
	}
	completed[0].Activity = read()
	f.manager.ApplyDaemonSessions(completed)
	f.assertNoRepeat(t, completed)
}

func TestDaemonOverviewCachePriorityKeepsActive(t *testing.T) {
	f := newDaemonOverviewFixture(t)
	daemonSeedCache(t, f)
	disk := &HistoricalActivity{TaskDigest: &TaskDigest{RunningCount: 2, AgentRunningCount: 2}}
	f.manager.ApplyDaemonSessions([]DaemonSession{daemonObservation("working", disk)})
	published := awaitOverview(t, f.updates)
	row := daemonSoleRow(t, f.manager)
	if !row.Active || !published.Active || row.LiveValues().Running.Agents != 1 || published.LiveValues().Running.Agents != 1 {
		t.Fatalf("cache priority/active lost: %+v / %+v", row.LiveValues(), published)
	}
}

func TestDaemonOverviewDiskDAGCounts(t *testing.T) {
	f := newDaemonOverviewFixture(t)
	cwd := t.TempDir()
	base := filepath.Join(cwd, ".omo", "senpi-task")
	writeActivityStoreJSON(t, filepath.Join(base, "tasks", "task.json"), map[string]any{
		"task_id": "linked", "parent_session_id": "daemon-durable", "status": "running",
	})
	writeActivityStoreJSON(t, filepath.Join(base, "dag", "runs", "run.json"), map[string]any{
		"runId": "run", "parentSessionId": "daemon-durable", "status": "running",
		"nodes": []any{
			map[string]any{"id": "linked-node", "taskId": "linked", "state": "running"},
			map[string]any{"id": "anonymous-node", "state": "running"},
		},
	})
	activity, err := ReadHistoricalActivity(t.Context(), cwd, "daemon-durable")
	if err != nil {
		t.Fatal(err)
	}
	f.manager.ApplyDaemonSessions([]DaemonSession{daemonObservation("idle", &activity)})
	published := awaitOverview(t, f.updates)
	row := daemonSoleRow(t, f.manager)
	want := LiveRunning{Agents: 2, Tasks: 1, Dag: 1}
	if row.LiveValues().Running != want || published.LiveValues().Running != want {
		t.Fatalf("overlapping task/DAG exact counts = %+v / %+v, want %+v", row.LiveValues().Running, published.LiveValues().Running, want)
	}
}

func daemonSeedCache(t *testing.T, f *daemonOverviewFixture) {
	t.Helper()
	raw := json.RawMessage(`{"name":"omo.task.updated","data":{"parent_session_id":"daemon-durable","tasks":[{"task_id":"cached","status":"running"}]}}`)
	epoch, _ := f.manager.cfg.Client.CurrentEpoch()
	f.manager.ingestEpochEvent(epoch, &omorpc.Event{Type: "extension_event", SessionID: "daemon-durable", Raw: raw})
	awaitOverview(t, f.updates)
}

func TestDaemonOverviewSnapshotExit(t *testing.T) {
	for _, cached := range []bool{false, true} {
		for _, status := range []string{"working", "idle"} {
			t.Run(status+map[bool]string{false: "/disk", true: "/cache"}[cached], func(t *testing.T) {
				f := newDaemonOverviewFixture(t)
				if cached {
					daemonSeedCache(t, f)
				}
				observation := []DaemonSession{daemonObservation(status, nil)}
				f.manager.ApplyDaemonSessions(observation)
				if !cached || status == "working" {
					awaitOverview(t, f.updates)
				}
				f.manager.ApplyDaemonSessions(nil)
				removed := awaitOverview(t, f.updates)
				if removed.Active || removed.ChatID != "daemon-chat" || len(f.manager.LiveSummaries()) != 0 {
					t.Fatalf("snapshot exit retained row or active: %+v; %+v", removed, f.manager.LiveSummaries())
				}
				f.manager.ApplyDaemonSessions(nil)
				f.assertNoRepeat(t, nil)
			})
		}
	}
}

func TestDaemonOverviewSuppressedIdentities(t *testing.T) {
	t.Run("unresolvable", func(t *testing.T) {
		f := newDaemonOverviewFixture(t)
		f.store.deleteOwner("daemon-durable")
		f.manager.ApplyDaemonSessions([]DaemonSession{daemonObservation("working", nil)})
		if rows := f.manager.LiveSummaries(); len(rows) != 0 {
			t.Fatalf("unresolvable durable produced row: %+v", rows)
		}
	})
	t.Run("retired", func(t *testing.T) {
		f := newDaemonOverviewFixture(t)
		f.manager.RetireIdentity("daemon-chat", "daemon-durable")
		f.manager.ApplyDaemonSessions([]DaemonSession{daemonObservation("working", nil)})
		if rows := f.manager.LiveSummaries(); len(rows) != 0 {
			t.Fatalf("retired durable produced row: %+v", rows)
		}
	})
	t.Run("deleting", func(t *testing.T) {
		f := newDaemonOverviewFixture(t)
		err := f.manager.DeleteChatIdentity("daemon-chat", "daemon-durable", func() error {
			f.manager.ApplyDaemonSessions([]DaemonSession{daemonObservation("working", nil)})
			if rows := f.manager.LiveSummaries(); len(rows) != 0 {
				t.Fatalf("deleting durable produced row: %+v", rows)
			}
			return errors.New("rollback deletion")
		})
		if err == nil {
			t.Fatal("fixture deletion unexpectedly succeeded")
		}
	})
}

func TestDaemonOverviewBoundRowsUnchanged(t *testing.T) {
	for _, same := range []bool{true, false} {
		t.Run(map[bool]string{true: "same durable", false: "different durable"}[same], func(t *testing.T) {
			f := newDaemonOverviewFixture(t)
			sess, _, _ := acquire(t, f.manager, testChat{id: "daemon-chat", cwd: t.TempDir()}, nil)
			awaitOverview(t, f.updates)
			durable := "daemon-durable"
			if same {
				durable = sess.ID()
			}
			f.store.setOwner(durable, "daemon-chat", "Daemon title")
			before := f.manager.LiveSummaries()
			f.manager.ApplyDaemonSessions([]DaemonSession{{DurableSessionID: durable, Status: "working"}})
			after := f.manager.LiveSummaries()
			f.manager.ApplyDaemonSessions(nil)
			removed := f.manager.LiveSummaries()
			if !reflect.DeepEqual(before, after) || !reflect.DeepEqual(before, removed) {
				t.Fatalf("bound rows changed: before %+v; after %+v; exit %+v", before, after, removed)
			}
			f.assertNoRepeat(t, nil)
		})
	}
}
