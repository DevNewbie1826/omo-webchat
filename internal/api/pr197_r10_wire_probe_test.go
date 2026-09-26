package api

import "testing"

func TestPR197R10RESTObservedCursorReturnKeepsRowFreshness(t *testing.T) {
	// Given an existing WS subscriber that has observed A:X then newer A:Y.
	f := newLiveResolveFixture(t)
	const chat, x, y = "r10-chat", "r10-x", "r10-y"
	f.saveChatClaiming(chat, "Stable title", x)
	frames := f.subscribeExplicit(chat)
	emitRereviewTasks(f, x, 1, 1)
	assertLiveFrameIdentity(t, frames.next(t, "sessions.activity"), chat, x)
	rebindLiveRowCursor(t, f, chat, y)
	emitRereviewTasks(f, y, 2, 2)
	assertLiveFrameIdentity(t, frames.next(t, "sessions.activity"), chat, y)
	emitRereviewTasks(f, y, 3, 3)
	publishedY := frames.next(t, "sessions.activity")
	assertLiveFrameIdentity(t, publishedY, chat, y)

	// A cursor-only return is visible through REST without an engine event.
	rebindLiveRowCursor(t, f, chat, x)
	readX := assertSoleLiveRow(t, f.serverURL, f.token)
	assertLiveRowTasks(t, readX, 1)
	xRevision := readX["last_activity_ms"].(float64)
	if xRevision <= publishedY["last_activity_ms"].(float64) {
		t.Fatalf("first REST return did not advance freshness: Y=%v X=%v", publishedY, readX)
	}

	// When the cursor returns to Y, its unchanged payload is published again.
	rebindLiveRowCursor(t, f, chat, y)
	emitRereviewTasks(f, y, 3, 3)
	returnedY := frames.next(t, "sessions.activity")
	assertLiveFrameIdentity(t, returnedY, chat, y)
	readY := assertSoleLiveRow(t, f.serverURL, f.token)
	assertLiveRowTasks(t, readY, 3)

	// Then both surfaces must advance beyond the authoritative REST X row.
	t.Logf("FRESHNESS publishedY=%v REST_X=%v WS_Y=%v REST_Y=%v",
		publishedY["last_activity_ms"], xRevision,
		returnedY["last_activity_ms"], readY["last_activity_ms"])
	if revision := returnedY["last_activity_ms"].(float64); revision <= xRevision {
		t.Errorf("WS regressed after an authoritative REST transition: X=%.0f Y=%.0f", xRevision, revision)
	}
	if revision := readY["last_activity_ms"].(float64); revision <= xRevision {
		t.Errorf("REST regressed after an authoritative REST transition: X=%.0f Y=%.0f", xRevision, revision)
	}
}
