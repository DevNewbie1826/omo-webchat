package session

import (
	"context"
	"testing"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

func TestPR197CursorOnlyRebindPreservesCurrentRow(t *testing.T) {
	for _, lateFirst := range []bool{false, true} {
		name := "replacement_before_late_event"
		if lateFirst {
			name = "late_event_before_replacement"
		}
		t.Run(name, func(t *testing.T) {
			store := newResolvingCursorStore()
			store.setOwner("old", "chat", "Title")
			mgr := NewManager(Config{Store: store})
			t.Cleanup(func() { _ = mgr.CloseAll(context.Background()) })
			ingest := func(durable string) Summary {
				_, snapshot, _ := mgr.ingestEpochEvent(omorpc.EpochToken{}, &omorpc.Event{
					Type: "extension_event", SessionID: durable,
					Raw: []byte(`{"name":"omo.task.updated","data":{"tasks":[]}}`),
				})
				return snapshot
			}
			if initial := ingest("old"); initial.ChatID != "chat" {
				t.Fatalf("initial row = %+v", initial)
			}
			store.deleteOwner("old")
			store.setOwner("new", "chat", "Title")

			if lateFirst {
				if late := ingest("old"); late.ReplacesSessionID == "chat" || (late.ChatID != "" && late.ChatID != "chat") {
					t.Fatalf("late activity destructively remapped stored chat: %+v", late)
				}
			}
			if replacement := ingest("new"); replacement.ChatID != "chat" || replacement.DurableSessionID != "new" {
				t.Fatalf("replacement row = %+v", replacement)
			}
			if live := mgr.LiveSummaries(); len(live) != 1 || live[0].ChatID != "chat" || live[0].DurableSessionID != "new" {
				t.Fatalf("cursor-only rebinding duplicated current row: %+v", live)
			}
			if late := ingest("old"); late.ChatID != "" {
				t.Fatalf("superseded durable republished: %+v", late)
			}
			initial, stop := mgr.SubscribeActivity(true, nil, func(Summary, bool) {})
			stop()
			if len(initial) != 1 || initial[0].ChatID != "chat" || initial[0].DurableSessionID != "new" {
				t.Fatalf("late activity displaced WS initial row: %+v", initial)
			}
		})
	}
}

func TestPR197PendingReplacementPreservesProvisionalRemap(t *testing.T) {
	store := newResolvingCursorStore()
	mgr := NewManager(Config{Store: store})
	t.Cleanup(func() {
		mgr.mu.Lock()
		clear(mgr.byChat)
		clear(mgr.byRoute)
		mgr.mu.Unlock()
		_ = mgr.CloseAll(context.Background())
	})
	epoch := omorpc.EpochToken{}
	old := newSession(mgr, "chat", "/tmp", omorpc.OpenSessionData{
		SessionID: "old-route", State: omorpc.SessionState{SessionID: "old"},
	}, false, epoch)
	old.invalidate("provider_disconnected", "provider connection lost")
	mgr.mu.Lock()
	mgr.byChat["chat"] = old
	mgr.mu.Unlock()
	ev := &omorpc.Event{Type: "extension_event", SessionID: "new",
		Raw: []byte(`{"name":"omo.task.updated","data":{"tasks":[]}}`)}
	_, provisional, _ := mgr.ingestEpochEvent(epoch, ev)
	if provisional.ChatID != "new" {
		t.Fatalf("unclaimed initial row = %+v", provisional)
	}

	store.setOwner("new", "chat", "Replacement")
	_, pending, _ := mgr.ingestEpochEvent(epoch, ev)
	if pending.ChatID != "chat" || pending.ReplacesSessionID != "new" {
		t.Fatalf("current stored owner did not remap the provisional row: %+v", pending)
	}
	replacement := newSession(mgr, "chat", "/tmp", omorpc.OpenSessionData{
		SessionID: "new-route", State: omorpc.SessionState{SessionID: "new"},
	}, false, epoch)
	replacement.lifecycleMu.Lock()
	mgr.mu.Lock()
	mgr.byChat["chat"] = replacement
	mgr.byRoute["new-route"] = replacement
	published, _ := mgr.mergeOverviewIntoSessionLocked(replacement)
	mgr.mu.Unlock()
	replacement.lifecycleMu.Unlock()
	if published.ChatID != "chat" || published.ReplacesSessionID != "" {
		t.Fatalf("acquisition repeated an already published remap: %+v", published)
	}
}
