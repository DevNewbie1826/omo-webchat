package api

import (
	"fmt"
	"testing"
)

func TestPR197R6RecentlyEvictedOwnerSurvivesOwnedCapacityWire(t *testing.T) {
	// Given: a published owner is the first eviction from a full owned cache.
	f := newLiveResolveFixture(t)
	const chatID, oldID, newID = "r6-cold-chat", "r6-cold-old", "r6-cold-new"
	f.saveChatClaiming(chatID, "Cold owner", oldID)
	conn, frames := f.connectUnsubscribed()
	t.Cleanup(func() { _ = conn.WriteClose(1000, nil) })
	writeActivityE2EFrame(t, conn, map[string]any{"type": "sessions.subscribe", "mode": "all_live"})
	frames.next(t, "ack")
	f.emitUnboundTask(oldID, 1)
	assertLiveFrameIdentity(t, frames.next(t, "sessions.activity"), chatID, oldID)
	for i := 0; i < 256; i++ {
		durable := fmt.Sprintf("r6-owned-filler-%03d", i)
		chat := "chat-" + durable
		f.saveChatClaiming(chat, "Other owner", durable)
		f.emitUnboundTask(durable, 1)
		assertLiveFrameIdentity(t, frames.next(t, "sessions.activity"), chat, durable)
	}
	for _, row := range liveResolveRows(t, f.serverURL, f.token) {
		if row["id"] == chatID {
			t.Fatal("fixture failed to evict the original owner's activity")
		}
	}

	// When: its cursor changes and the just-evicted durable sends late activity.
	rebindLiveRowCursor(t, f, chatID, newID)
	f.emitUnboundTask(newID, 1)
	assertLiveFrameIdentity(t, frames.next(t, "sessions.activity"), chatID, newID)
	f.emitUnboundTask(oldID, 2)
	const marker = "r6-owned-capacity-barrier"
	f.emitUnboundTask(marker, 1)
	first := frames.next(t, "sessions.activity")
	if first["sessionId"] != marker {
		assertLiveFrameIdentity(t, frames.next(t, "sessions.activity"), marker, marker)
	}

	// Then: the last few non-resident identities must not resurrect a UUID row.
	if first["sessionId"] != marker {
		t.Errorf("WS resurrected recently evicted superseded durable: %v", first)
	}
	for _, row := range liveResolveRows(t, f.serverURL, f.token) {
		if row["id"] == oldID {
			t.Errorf("REST resurrected recently evicted superseded durable: %v", row)
		}
	}
}
