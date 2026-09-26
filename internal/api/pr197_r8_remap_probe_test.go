package api

import (
	"encoding/json"
	"testing"
)

func TestPR197R8TransferredDurableDoesNotReplaceFormerOwnersNewRow(t *testing.T) {
	// Given an existing subscriber that has seen chat A move from X to Y.
	f := newLiveResolveFixture(t)
	const first, second, oldID, newID = "r8-chat-a", "r8-chat-b", "r8-durable-x", "r8-durable-y"
	f.saveChatClaiming(first, "First", oldID)
	conn, frames := f.connectUnsubscribed()
	t.Cleanup(func() { _ = conn.WriteClose(1000, nil) })
	writeActivityE2EFrame(t, conn, map[string]any{"type": "sessions.subscribe", "mode": "all_live"})
	frames.next(t, "ack")
	f.emitUnboundTask(oldID, 1)
	firstFrame := frames.next(t, "sessions.activity")
	assertLiveFrameIdentity(t, firstFrame, first, oldID)
	rebindLiveRowCursor(t, f, first, newID)
	f.emitUnboundTask(newID, 1)
	currentFrame := frames.next(t, "sessions.activity")
	assertLiveFrameIdentity(t, currentFrame, first, newID)

	// When another stored chat claims X and publishes its own live row.
	f.saveChatClaiming(second, "Second", oldID)
	f.emitUnboundTask(oldID, 2)
	transferred := frames.next(t, "sessions.activity")
	assertLiveFrameIdentity(t, transferred, second, oldID)
	rows := liveResolveRows(t, f.serverURL, f.token)
	wire, err := json.Marshal([]map[string]any{firstFrame, currentFrame, transferred})
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("WIRE_FRAMES=%s", wire)
	t.Logf("REST_ROWS=%v", rows)

	// Then the remap cannot erase A:Y, which REST still lists independently.
	if len(rows) != 2 {
		t.Fatalf("REST rows=%v, want independent A:Y and B:X", rows)
	}
	if transferred["replacesSessionId"] == first {
		t.Fatalf("WS destructively replaces current A:Y with B:X: %v", transferred)
	}
}
