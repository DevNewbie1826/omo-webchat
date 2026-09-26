package api

import (
	"fmt"
	"testing"
)

func TestPR197ReviewerKnownCountercases(t *testing.T) {
	t.Run("workspace_delete_evicted", TestPR197ReviewWorkspaceDeleteAfterEviction)
	t.Run("cursor_rebind_evicted", TestPR197ReviewCursorRebindAfterEviction)
	t.Run("cursor_return", TestPR197ReviewCursorReturnsToRetiredDurable)
}

func TestPR197ReviewerWireRegressions(t *testing.T) {
	t.Run("stored_chat", TestLiveRowResolutionStoredChatKeysOverviewRowsByChatIdentity)
	t.Run("unowned", TestLiveRowResolutionKeepsUnownedDurableUnderOwnID)
	t.Run("remap", TestLiveRowResolutionRekeysFallbackRowWhenChatClaimsDurable)
	t.Run("rename", TestLiveRowResolutionRenameRefreshesCachedRowTitle)
	t.Run("retained_rename", TestLiveRowRereviewRenameResumableSessionCachedAfterEpochLoss)
	t.Run("chat_delete_evicted", TestLiveRowRereviewEvictedCacheCannotResurrectDeletedChat)
	t.Run("cursor_only", TestLiveRowRereviewCursorChangeReplacesColdCachedDurable)
	t.Run("late_old", TestLiveRowRereviewLateOldDurableCannotReplaceNewCursor)
}

func TestPR197ReviewerHotOwnerWire(t *testing.T) {
	// Given: C:X remains hot while other stored chats fill the bounded history.
	f := newLiveResolveFixture(t)
	const chatID, oldID, newID = "hot-chat", "hot-durable", "hot-replacement"
	f.saveChatClaiming(chatID, "Hot", oldID)
	conn, frames := f.connectUnsubscribed()
	t.Cleanup(func() { _ = conn.WriteClose(1000, nil) })
	writeActivityE2EFrame(t, conn, map[string]any{"type": "sessions.subscribe", "mode": "all_live"})
	frames.next(t, "ack")
	f.emitUnboundTask(oldID, 1)
	assertLiveFrameIdentity(t, frames.next(t, "sessions.activity"), chatID, oldID)
	for i := 0; i < 256; i++ {
		id := fmt.Sprintf("owned-filler-%d", i)
		f.saveChatClaiming("chat-"+id, "Other", id)
		f.emitUnboundTask(oldID, 1)
		assertLiveFrameIdentity(t, frames.next(t, "sessions.activity"), chatID, oldID)
		f.emitUnboundTask(id, 1)
		assertLiveFrameIdentity(t, frames.next(t, "sessions.activity"), "chat-"+id, id)
	}

	// When: the stored cursor moves to Y and late X arrives.
	rebindLiveRowCursor(t, f, chatID, newID)
	f.emitUnboundTask(newID, 1)
	assertLiveFrameIdentity(t, frames.next(t, "sessions.activity"), chatID, newID)
	f.emitUnboundTask(oldID, 2)
	const marker = "hot-owner-barrier"
	f.emitUnboundTask(marker, 1)
	first := frames.next(t, "sessions.activity")
	if first["sessionId"] != marker {
		assertLiveFrameIdentity(t, frames.next(t, "sessions.activity"), marker, marker)
	}

	// Then: neither actual wire surface may resurrect superseded X.
	if first["sessionId"] != marker {
		t.Errorf("WS resurrected superseded hot durable: %v", first)
	}
	for _, row := range liveResolveRows(t, f.serverURL, f.token) {
		if row["id"] == oldID {
			t.Errorf("REST resurrected superseded hot durable: %v", row)
		}
	}
}

func TestPR197ReviewerHotRemapWire(t *testing.T) {
	// Given: the first chat's durable is kept hot across 512 other publications.
	f := newLiveResolveFixture(t)
	const durable, firstChat, secondChat = "remap-hot", "remap-first", "remap-second"
	f.saveChatClaiming(firstChat, "First", durable)
	conn, frames := f.connectUnsubscribed()
	t.Cleanup(func() { _ = conn.WriteClose(1000, nil) })
	writeActivityE2EFrame(t, conn, map[string]any{"type": "sessions.subscribe", "mode": "all_live"})
	frames.next(t, "ack")
	f.emitUnboundTask(durable, 1)
	assertLiveFrameIdentity(t, frames.next(t, "sessions.activity"), firstChat, durable)
	for i := 0; i < 512; i++ {
		f.emitUnboundTask(durable, 1)
		assertLiveFrameIdentity(t, frames.next(t, "sessions.activity"), firstChat, durable)
		id := fmt.Sprintf("remap-filler-%d", i)
		f.emitUnboundTask(id, 1)
		assertLiveFrameIdentity(t, frames.next(t, "sessions.activity"), id, id)
	}

	// When: metadata transfers ownership to a different stored chat.
	rebindLiveRowCursor(t, f, firstChat, "unpublished-away")
	f.saveChatClaiming(secondChat, "Second", durable)
	f.emitUnboundTask(durable, 2)

	// Then: REST and WS must agree and the existing WS row must be remapped.
	frame := frames.next(t, "sessions.activity")
	assertLiveFrameIdentity(t, frame, secondChat, durable)
	if frame["replacesSessionId"] != firstChat {
		t.Errorf("WS omitted the previous hot chat identity: %v", frame)
	}
	found := false
	for _, row := range liveResolveRows(t, f.serverURL, f.token) {
		if row["id"] == firstChat {
			t.Errorf("REST retained former owner: %v", row)
		}
		found = found || row["id"] == secondChat
	}
	if !found {
		t.Fatal("REST omitted the current owner")
	}
}
