package api

import (
	"fmt"
	"testing"
)

func TestPR197R6FreshDeletionAtResidentCapacityWire(t *testing.T) {
	// Given: a bound chat provides ingestion barriers without using an
	// unbound cache slot, and 256 deleted durables fill that cache.
	f := newLiveResolveFixture(t)
	f.attachChat()
	conn, frames := f.connectUnsubscribed()
	t.Cleanup(func() { _ = conn.WriteClose(1000, nil) })
	writeActivityE2EFrame(t, conn, map[string]any{"type": "sessions.subscribe", "mode": "all_live"})
	frames.next(t, "ack")
	for i := 0; i < 256; i++ {
		durable := fmt.Sprintf("r6-resident-%03d", i)
		chat := "chat-" + durable
		f.saveChatClaiming(chat, "Deleted before activity", durable)
		deleteLiveRowChat(t, f, chat)
		f.emitUnboundTask(durable, 1)
		f.emitUnboundTask(f.chat.DurableSessionID, 1)
		assertLiveFrameIdentity(t, frames.next(t, "sessions.activity"), f.chat.ID, f.chat.DurableSessionID)
	}

	// When: another chat is deleted before publication and immediately
	// receives late activity, followed by the bound ingestion barrier.
	const chatID, durable = "r6-fresh-chat", "r6-fresh-durable"
	f.saveChatClaiming(chatID, "Fresh deletion", durable)
	deleteLiveRowChat(t, f, chatID)
	f.emitUnboundTask(durable, 1)
	f.emitUnboundTask(f.chat.DurableSessionID, 1)
	first := frames.next(t, "sessions.activity")
	if first["sessionId"] != f.chat.ID {
		assertLiveFrameIdentity(t, frames.next(t, "sessions.activity"), f.chat.ID, f.chat.DurableSessionID)
	}

	// Then: neither authenticated wire surface may resurrect this chat.
	if first["sessionId"] != f.chat.ID {
		t.Errorf("WS resurrected newly deleted durable at full resident capacity: %v", first)
	}
	for _, row := range liveResolveRows(t, f.serverURL, f.token) {
		if row["id"] == chatID || row["id"] == durable {
			t.Errorf("REST resurrected newly deleted durable at full resident capacity: %v", row)
		}
	}
}
