package api

import (
	"fmt"
	"testing"
)

func TestPR197ClockReviewIdleReturnAfterExposureEviction(t *testing.T) {
	// Given a previously exposed chat revision, followed by complete cache
	// and non-resident exposure-history eviction using ordinary wire events.
	f := newLiveResolveFixture(t)
	const old = "clock-review-old"
	f.saveChatClaiming(f.chat.ID, "Returning idle chat", old)
	conn, frames := f.connectUnsubscribed()
	t.Cleanup(func() { _ = conn.WriteClose(1000, nil) })
	writeActivityE2EFrame(t, conn, map[string]any{"type": "sessions.subscribe", "mode": "all_live"})
	frames.next(t, "ack")
	emitRereviewTasks(f, old, 1, 1)
	first := frames.next(t, "sessions.activity")
	assertLiveFrameIdentity(t, first, f.chat.ID, old)
	for i := 0; i < 512; i++ {
		id := fmt.Sprintf("clock-idle-filler-%03d", i)
		emitRereviewTasks(f, id, 1, 1)
		assertLiveFrameIdentity(t, frames.next(t, "sessions.activity"), id, id)
	}

	// When that same stored chat acquires a new, initially idle durable.
	f.attachChat()
	if f.chat.DurableSessionID == old {
		t.Fatal("fixture did not acquire a replacement durable")
	}
	var returned map[string]any
	for _, row := range liveResolveRows(t, f.serverURL, f.token) {
		if row["id"] == f.chat.ID {
			returned = row
		}
	}
	if returned == nil {
		t.Fatal("REST omitted the acquired chat")
	}

	// Then the returning row must receive the required manager-wide stamp,
	// even though its underlying lifecycle-only row has no activity receipt.
	t.Logf("IDLE_RETURN previous=%v returned=%v", first, returned)
	revision, present := returned["last_activity_ms"].(float64)
	if !present || revision < first["last_activity_ms"].(float64) {
		t.Fatalf("returning chat lost revision continuity: before=%v after=%v",
			first["last_activity_ms"], returned["last_activity_ms"])
	}
}

func TestPR197ClockReviewForgottenRESTOwnerCannotBeRemapped(t *testing.T) {
	// Given a subscriber that saw A:X and a later REST projection of A:Y.
	f := newLiveResolveFixture(t)
	const a, b, x, y = "clock-a", "clock-b", "clock-x", "clock-y"
	f.saveChatClaiming(a, "First", x)
	conn, frames := f.connectUnsubscribed()
	t.Cleanup(func() { _ = conn.WriteClose(1000, nil) })
	writeActivityE2EFrame(t, conn, map[string]any{"type": "sessions.subscribe", "mode": "all_live"})
	frames.next(t, "ack")
	emitRereviewTasks(f, x, 1, 1)
	assertLiveFrameIdentity(t, frames.next(t, "sessions.activity"), a, x)
	emitRereviewTasks(f, y, 2, 2)
	assertLiveFrameIdentity(t, frames.next(t, "sessions.activity"), y, y)
	rebindLiveRowCursor(t, f, a, y)
	restA := assertSoleLiveRow(t, f.serverURL, f.token)
	assertLiveRowIdentity(t, restA, a)
	assertLiveRowTasks(t, restA, 2)

	// When X remains resident while A:Y and A's exposure watermark leave
	// bounded history, then B claims X. A's stored cursor is still Y.
	for i := 0; i < 512; i++ {
		emitRereviewTasks(f, x, 1, 1)
		id := fmt.Sprintf("clock-remap-filler-%03d", i)
		emitRereviewTasks(f, id, 1, 1)
		assertLiveFrameIdentity(t, frames.next(t, "sessions.activity"), id, id)
	}
	f.saveChatClaiming(b, "Second", x)
	emitRereviewTasks(f, x, 3, 3)
	transferred := frames.next(t, "sessions.activity")
	assertLiveFrameIdentity(t, transferred, b, x)
	currentA, err := f.store.GetChat(a)
	if err != nil {
		t.Fatal(err)
	}
	if currentA.DurableSessionID != y {
		t.Fatalf("fixture moved A away from Y: %+v", currentA)
	}

	// Then B:X cannot instruct removal of the REST-exposed A:Y row.
	t.Logf("FORGOTTEN_OWNER REST_A=%v WS_TRANSFER=%v CURRENT_A_DURABLE=%s",
		restA, transferred, currentA.DurableSessionID)
	if transferred["replacesSessionId"] == a {
		t.Fatalf("B:X replaces A:Y after A's exposed-owner evidence expires: %v", transferred)
	}
}
