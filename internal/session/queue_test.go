package session

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

func TestQueueUpdateStoresSnapshotAndSignalsBridge(t *testing.T) {
	updated := make(chan struct{}, 1)
	manager := &Manager{cfg: Config{OnQueueUpdate: func(chatID string, got *Session) {
		if chatID != "chat" {
			t.Errorf("callback chat id = %q", chatID)
		}
		updated <- struct{}{}
	}}}
	sess := &Session{manager: manager, chatID: "chat", engineQueue: EngineQueueSnapshot{Ordered: []omorpc.QueuedMessage{}}}
	raw := json.RawMessage(`{"type":"queue_update","sessionId":"route","pendingMessageCount":2,"ordered":[{"text":"now","mode":"steer","enqueueOrder":1},{"text":"later","mode":"followUp","enqueueOrder":2}]}`)
	sess.dispatch(&omorpc.Event{Type: omorpc.EventQueueUpdate, Raw: raw})

	select {
	case <-updated:
	case <-time.After(time.Second):
		t.Fatal("queue update callback was not delivered")
	}
	snapshot := sess.EngineQueueSnapshot()
	if snapshot.PendingMessageCount != 2 || len(snapshot.Ordered) != 2 || snapshot.Ordered[0].Text != "now" || snapshot.Ordered[1].Mode != "followUp" {
		t.Fatalf("engine queue snapshot = %+v", snapshot)
	}
	snapshot.Ordered[0].Text = "mutated"
	if got := sess.EngineQueueSnapshot().Ordered[0].Text; got != "now" {
		t.Fatalf("snapshot aliases session state: %q", got)
	}
}
