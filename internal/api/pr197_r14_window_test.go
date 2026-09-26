package api

import (
	"fmt"
	"testing"
)

func TestPR197R14ResidentDurableReturnRegressesAfterRowHistoryEviction(t *testing.T) {
	// Given ordinary real HTTP/WS publications: older B:Y and newer A:X.
	// Neither receipts nor revision state are injected or clock-adjusted.
	f := newLiveResolveFixture(t)
	const a, b, x, y = "r14-a", "r14-b", "r14-x", "r14-y"
	f.saveChatClaiming(a, "Shared title", x)
	f.saveChatClaiming(b, "Shared title", y)
	conn, frames := f.connectUnsubscribed()
	t.Cleanup(func() { _ = conn.WriteClose(1000, nil) })
	writeActivityE2EFrame(t, conn, map[string]any{"type": "sessions.subscribe", "mode": "all_live"})
	frames.next(t, "ack")
	emitRereviewTasks(f, y, 1, 1)
	firstY := frames.next(t, "sessions.activity")
	assertLiveFrameIdentity(t, firstY, b, y)
	var high float64
	for count := 2; count <= 4; count++ {
		emitRereviewTasks(f, x, count, count)
		published := frames.next(t, "sessions.activity")
		assertLiveFrameIdentity(t, published, a, x)
		high = published["last_activity_ms"].(float64)
	}
	if high <= firstY["last_activity_ms"].(float64) {
		t.Fatal("fixture did not establish A:X newer than B:Y")
	}

	// When A stops owning resident activity, unrelated rows evict its
	// watermark. Y stays resident and keeps its unchanged scalar revision.
	rebindLiveRowCursor(t, f, a, "r14-unpublished-a")
	for i := 0; i < 512; i++ {
		emitRereviewTasks(f, y, 1, 1)
		kept := frames.next(t, "sessions.activity")
		assertLiveFrameIdentity(t, kept, b, y)
		if kept["last_activity_ms"] != firstY["last_activity_ms"] {
			t.Fatal("unchanged resident Y unexpectedly advanced")
		}
		other := fmt.Sprintf("r14-filler-%03d", i)
		emitRereviewTasks(f, other, 1, 1)
		assertLiveFrameIdentity(t, frames.next(t, "sessions.activity"), other, other)
	}
	rebindLiveRowCursor(t, f, b, "r14-unpublished-b")
	rebindLiveRowCursor(t, f, a, y)
	var rest map[string]any
	for _, row := range liveResolveRows(t, f.serverURL, f.token) {
		if row["id"] == a {
			rest = row
		}
	}
	if rest == nil {
		t.Fatal("REST omitted the returning chat")
	}
	assertLiveRowTasks(t, rest, 1)
	emitRereviewTasks(f, y, 1, 1)
	returned := frames.next(t, "sessions.activity")
	assertLiveFrameIdentity(t, returned, a, y)

	// Then neither real wire surface may lower A's exposed revision.
	t.Logf("WIRE_RETURN original_A=%.0f retained_Y=%v REST_A=%v WS_A=%v",
		high, firstY["last_activity_ms"], rest, returned)
	for surface, row := range map[string]map[string]any{"REST": rest, "WS": returned} {
		if revision := row["last_activity_ms"].(float64); revision < high {
			t.Errorf("%s regressed A's revision after cached durable return: %.0f -> %.0f",
				surface, high, revision)
		}
	}
}
