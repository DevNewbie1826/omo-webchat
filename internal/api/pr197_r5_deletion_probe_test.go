package api

import (
	"fmt"
	"testing"
)

func TestPR197R5HotDeletedBeforeFirstPublication(t *testing.T) {
	// Given: a stored cursor is deleted before its first activity publication.
	f := newLiveResolveFixture(t)
	const chatID, durable, marker = "r5-deleted-chat", "r5-deleted-durable", "r5-delete-barrier"
	f.saveChatClaiming(chatID, "Deleted before activity", durable)
	conn, frames := f.connectUnsubscribed()
	t.Cleanup(func() { _ = conn.WriteClose(1000, nil) })
	writeActivityE2EFrame(t, conn, map[string]any{"type": "sessions.subscribe", "mode": "all_live"})
	frames.next(t, "ack")
	deleteLiveRowChat(t, f, chatID)

	// When: late activity keeps the deleted durable resident while other
	// authenticated deletions fill the retirement history. Every marker
	// acknowledges ingestion; the test uses no timing or polling assumptions.
	for i := 0; i < 256; i++ {
		f.emitUnboundTask(durable, 1)
		f.emitUnboundTask(marker, 1)
		assertLiveFrameIdentity(t, frames.next(t, "sessions.activity"), marker, marker)
		other := fmt.Sprintf("r5-retired-%d", i)
		f.saveChatClaiming("chat-"+other, "Other", other)
		deleteLiveRowChat(t, f, "chat-"+other)
	}
	f.emitUnboundTask(durable, 2)
	f.emitUnboundTask(marker, 1)
	first := frames.next(t, "sessions.activity")
	if first["sessionId"] != marker {
		assertLiveFrameIdentity(t, frames.next(t, "sessions.activity"), marker, marker)
	}

	// Then: a still-resident deleted durable cannot become an unowned row.
	if first["sessionId"] != marker {
		t.Errorf("WS resurrected a resident deleted durable after retirement churn: %v", first)
	}
	for _, row := range liveResolveRows(t, f.serverURL, f.token) {
		if row["id"] == chatID || row["id"] == durable {
			t.Errorf("REST resurrected a resident deleted durable after retirement churn: %v", row)
		}
	}
}
