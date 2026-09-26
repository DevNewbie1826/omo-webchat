package api

import (
	"encoding/json"
	"testing"
)

func TestPR197R9TransferWireForFrontendReplay(t *testing.T) {
	for _, returning := range []bool{false, true} {
		name := "former_owner_has_new_durable"
		if returning {
			name = "ownership_returns_to_original_chat"
		}
		t.Run(name, func(t *testing.T) {
			// Given a real subscriber that has observed A:X.
			f := newLiveResolveFixture(t)
			const a, b, x, y = "r9-chat-a", "r9-chat-b", "r9-durable-x", "r9-durable-y"
			f.saveChatClaiming(a, "First", x)
			conn, frames := f.connectUnsubscribed()
			t.Cleanup(func() { _ = conn.WriteClose(1000, nil) })
			writeActivityE2EFrame(t, conn, map[string]any{"type": "sessions.subscribe", "mode": "all_live"})
			frames.next(t, "ack")
			var captured []map[string]any
			emit := func(chat, durable string, count int) {
				emitRereviewTasks(f, durable, len(captured)+1, count)
				frame := frames.next(t, "sessions.activity")
				assertLiveFrameIdentity(t, frame, chat, durable)
				captured = append(captured, frame)
			}
			emit(a, x, 1)

			// When X transfers, and either A publishes Y or X returns to A.
			rebindLiveRowCursor(t, f, a, y)
			if !returning {
				emit(a, y, 2)
			}
			f.saveChatClaiming(b, "Second", x)
			emit(b, x, 3)
			if returning {
				rebindLiveRowCursor(t, f, b, "r9-unpublished-away")
				rebindLiveRowCursor(t, f, a, x)
				emit(a, x, 4)
			} else {
				emit(a, y, 4)
			}

			// Then record actual WS and REST payloads for the real frontend reducer.
			rows := liveResolveRows(t, f.serverURL, f.token)
			want := 2
			if returning {
				want = 1
			}
			if len(rows) != want {
				t.Fatalf("REST rows=%v, want %d", rows, want)
			}
			evidence, err := json.Marshal(map[string]any{"scenario": name, "frames": captured, "rest": rows})
			if err != nil {
				t.Fatal(err)
			}
			t.Logf("WIRE_EVIDENCE=%s", evidence)
		})
	}
}

func TestPR197R9CursorReturnDoesNotRegressRowRevision(t *testing.T) {
	// Given cached X and a newer published Y for the same stored chat.
	f := newLiveResolveFixture(t)
	const a, x, y = "r9-chat-a", "r9-durable-x", "r9-durable-y"
	f.saveChatClaiming(a, "First", x)
	frames := f.subscribeExplicit(a)
	var captured []map[string]any
	emit := func(durable string, revision, count int) {
		emitRereviewTasks(f, durable, revision, count)
		frame := frames.next(t, "sessions.activity")
		assertLiveFrameIdentity(t, frame, a, durable)
		captured = append(captured, frame)
	}
	emit(x, 1, 1)
	rebindLiveRowCursor(t, f, a, y)
	emit(y, 2, 2)
	// A second scalar change forces Y's revision to advance even in one clock tick.
	emit(y, 3, 3)
	newer := captured[2]["last_activity_ms"].(float64)
	if newer <= captured[0]["last_activity_ms"].(float64) {
		t.Fatal("fixture did not establish newer row freshness")
	}

	// When the stored cursor returns to X with its unchanged activity payload.
	rebindLiveRowCursor(t, f, a, x)
	emit(x, 1, 1)

	// Then the authoritative row must not be rejected by frontend freshness gates.
	rows := liveResolveRows(t, f.serverURL, f.token)
	if len(rows) != 1 {
		t.Fatalf("REST rows=%v, want current X only", rows)
	}
	assertLiveRowTasks(t, rows[0], 1)
	evidence, err := json.Marshal(map[string]any{
		"scenario": "cursor_returns_to_unchanged_cached_durable", "frames": captured, "rest": rows,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("WIRE_EVIDENCE=%s", evidence)
	if returned := captured[3]["last_activity_ms"].(float64); returned <= newer {
		t.Errorf("authoritative X regressed chat freshness: Y=%.0f returned X=%.0f", newer, returned)
	}
}
