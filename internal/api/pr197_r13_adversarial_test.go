package api

import "testing"

func TestPR197R13RESTHandoffCannotRemapAnotherDurable(t *testing.T) {
	// Given an existing WS subscriber that saw A:X and a cached unowned Y.
	f := newLiveResolveFixture(t)
	const a, b, x, y = "r13-chat-a", "r13-chat-b", "r13-x", "r13-y"
	f.saveChatClaiming(a, "First", x)
	conn, frames := f.connectUnsubscribed()
	t.Cleanup(func() { _ = conn.WriteClose(1000, nil) })
	writeActivityE2EFrame(t, conn, map[string]any{"type": "sessions.subscribe", "mode": "all_live"})
	frames.next(t, "ack")
	emitRereviewTasks(f, x, 1, 1)
	assertLiveFrameIdentity(t, frames.next(t, "sessions.activity"), a, x)
	emitRereviewTasks(f, y, 2, 2)
	assertLiveFrameIdentity(t, frames.next(t, "sessions.activity"), y, y)

	// When the client's REST read observes A:Y without a Y publication,
	// and a different chat subsequently claims and publishes X.
	rebindLiveRowCursor(t, f, a, y)
	restA := assertSoleLiveRow(t, f.serverURL, f.token)
	assertLiveRowIdentity(t, restA, a)
	assertLiveRowTasks(t, restA, 2)
	f.saveChatClaiming(b, "Second", x)
	emitRereviewTasks(f, x, 3, 3)
	transferred := frames.next(t, "sessions.activity")
	assertLiveFrameIdentity(t, transferred, b, x)
	rows := liveResolveRows(t, f.serverURL, f.token)
	t.Logf("REST_BEFORE=%v WS_TRANSFER=%v REST_AFTER=%v", restA, transferred, rows)

	// Then the backend wire cannot instruct deletion of the current A:Y row.
	if len(rows) != 2 {
		t.Fatalf("expected A:Y and B:X: %v", rows)
	}
	if transferred["replacesSessionId"] == a {
		t.Fatalf("B:X instructs removal of the REST-exposed A:Y row: %v", transferred)
	}
}
