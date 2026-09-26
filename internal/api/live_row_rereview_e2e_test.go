package api

import (
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/auth"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/session"
)

// These cases use the same authenticated HTTP server, v2 WebSocket, cursor
// store, and narrow RPC provider fixture as live_row_resolution_e2e_test.go.

func rebindLiveRowCursor(t *testing.T, f *liveResolveFixture, chatID, durableID string) {
	t.Helper()
	chat, err := f.store.GetChat(chatID)
	if err != nil {
		t.Fatal(err)
	}
	chat.DurableSessionID = durableID
	if err := f.store.UpdateChat(chat); err != nil {
		t.Fatal(err)
	}
}

func assertLiveRowIdentity(t *testing.T, row map[string]any, chatID string) {
	t.Helper()
	if row["id"] != chatID {
		t.Fatalf("live REST row = %v, want chat %q", row, chatID)
	}
}

// REST intentionally omits durableSessionId. Distinct task counts on X and Y
// let the real REST projection prove it retained Y's content, not just C's id.
func emitRereviewTasks(f *liveResolveFixture, durableID string, revision, count int) {
	f.t.Helper()
	tasks := make([]any, count)
	for i := range tasks {
		tasks[i] = map[string]any{
			"task_id": fmt.Sprintf("st-rereview-%d", i), "status": "running",
			"created_at": "2026-09-26T00:00:00Z",
			"updated_at": fmt.Sprintf("2026-09-26T00:00:%02dZ", revision),
		}
	}
	f.daemon.Emit(map[string]any{
		"type": "extension_event", "sessionId": durableID, "name": liveResolveSnapshotName,
		"data": map[string]any{"parent_session_id": durableID, "truncated_tasks": false, "tasks": tasks},
	})
}

func assertLiveRowTasks(t *testing.T, row map[string]any, count float64) {
	t.Helper()
	running, ok := row["running"].(map[string]any)
	if !ok || running["tasks"] != count {
		t.Fatalf("live REST row = %v, want %v running tasks", row, count)
	}
}

func assertLiveFrameIdentity(t *testing.T, frame map[string]any, chatID, durableID string) {
	t.Helper()
	if frame["sessionId"] != chatID || frame["durableSessionId"] != durableID {
		t.Fatalf("live WS frame = %v, want chat %q durable %q", frame, chatID, durableID)
	}
	if frame["replacesSessionId"] == chatID {
		t.Fatalf("live WS frame destructively replaces its own chat row: %v", frame)
	}
}

func TestLiveRowRereviewCursorChangeReplacesColdCachedDurable(t *testing.T) {
	// Given: X is cached for a stored chat that has never been acquired.
	f := newLiveResolveFixture(t)
	const chatID, oldID, newID = "chat-rereview-cursor", "durable-rereview-x", "durable-rereview-y"
	f.saveChatClaiming(chatID, "Cursor change", oldID)
	frames := f.subscribeExplicit(chatID)
	emitRereviewTasks(f, oldID, 1, 1)
	assertLiveFrameIdentity(t, frames.next(t, "sessions.activity"), chatID, oldID)

	// When: the persisted cursor moves to Y, without acquiring the chat.
	rebindLiveRowCursor(t, f, chatID, newID)
	emitRereviewTasks(f, newID, 2, 2)

	// Then: both actual overview surfaces expose exactly the Y identity.
	assertLiveFrameIdentity(t, frames.next(t, "sessions.activity"), chatID, newID)
	row := assertSoleLiveRow(t, f.serverURL, f.token)
	assertLiveRowIdentity(t, row, chatID)
	assertLiveRowTasks(t, row, 2)
}

func TestLiveRowRereviewLateOldDurableCannotReplaceNewCursor(t *testing.T) {
	// Given: the cold cached row has already switched from X to Y.
	f := newLiveResolveFixture(t)
	const chatID, oldID, newID = "chat-rereview-late", "durable-rereview-late-x", "durable-rereview-late-y"
	f.saveChatClaiming(chatID, "Late cursor", oldID)
	frames := f.subscribeExplicit(chatID)
	emitRereviewTasks(f, oldID, 1, 1)
	assertLiveFrameIdentity(t, frames.next(t, "sessions.activity"), chatID, oldID)
	rebindLiveRowCursor(t, f, chatID, newID)
	emitRereviewTasks(f, newID, 2, 2)
	assertLiveFrameIdentity(t, frames.next(t, "sessions.activity"), chatID, newID)

	// When: a late X event arrives, followed by a Y event as an ingestion
	// fence. The socket must not receive a destructive X remap before Y.
	emitRereviewTasks(f, oldID, 3, 1)
	emitRereviewTasks(f, newID, 4, 2)

	// Then: the next activity is still Y, with no self-replacement, and the
	// REST projection contains one chat row owned by Y.
	assertLiveFrameIdentity(t, frames.next(t, "sessions.activity"), chatID, newID)
	row := assertSoleLiveRow(t, f.serverURL, f.token)
	assertLiveRowIdentity(t, row, chatID)
	assertLiveRowTasks(t, row, 2)
}

func deleteLiveRowChat(t *testing.T, f *liveResolveFixture, chatID string) {
	t.Helper()
	req, err := http.NewRequest(http.MethodDelete,
		f.serverURL+"/api/workspaces/"+f.storeWorkspaceID()+"/chats/"+chatID, nil)
	if err != nil {
		t.Fatal(err)
	}
	req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: f.token})
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("delete chat status = %d, want 204", resp.StatusCode)
	}
}

func TestLiveRowRereviewEvictedCacheCannotResurrectDeletedChat(t *testing.T) {
	// Given: a cold stored C:X row is pushed out of the 256-entry overview
	// cache by 256 distinct provider activity events, with a WS fence on the
	// final event rather than a timer or an internal cache inspection.
	f := newLiveResolveFixture(t)
	const chatID, durableID = "chat-rereview-evicted", "durable-rereview-evicted"
	f.saveChatClaiming(chatID, "Deleted after eviction", durableID)
	cached := f.subscribeExplicit(chatID)
	f.emitUnboundTask(durableID, 1)
	assertLiveFrameIdentity(t, cached.next(t, "sessions.activity"), chatID, durableID)
	fillers := make([]string, 256)
	for i := 0; i < 256; i++ {
		fillers[i] = "durable-rereview-filler-" + itoa(i)
	}
	fillerFrames := f.subscribeExplicit(fillers...)
	for _, id := range fillers {
		f.emitUnboundTask(id, 1)
		if got := fillerFrames.next(t, "sessions.activity"); got["sessionId"] != id {
			t.Fatalf("eviction fence for %q = %v", id, got)
		}
	}
	if _, exists := f.manager.Get(chatID); exists {
		t.Fatal("cold fixture acquired the chat unexpectedly")
	}
	rows := liveResolveRows(t, f.serverURL, f.token)
	if len(rows) != len(fillers) {
		t.Fatalf("eviction fixture retained %d rows, want %d after 257 accepted events", len(rows), len(fillers))
	}
	for _, row := range rows {
		if row["id"] == chatID || row["durableSessionId"] == durableID {
			t.Fatalf("chat was not evicted before deletion: %v", row)
		}
	}

	// When: DELETE returns 204 and a late event for the evicted durable X
	// arrives before a separate marker event.
	deleteLiveRowChat(t, f, chatID)
	const marker = "durable-rereview-delete-barrier"
	afterDelete := f.subscribeExplicit(durableID, marker)
	f.emitUnboundTask(durableID, 2)
	f.emitUnboundTask(marker, 1)

	// Then: REST cannot contain either deleted identity after the marker
	// crosses the ingestion loop, and the next WS publication is that marker.
	// The latter cannot be a resurrected chat or fallback X row.
	first := afterDelete.next(t, "sessions.activity")
	if first["sessionId"] != marker {
		markerFrame := afterDelete.next(t, "sessions.activity")
		if markerFrame["sessionId"] != marker {
			t.Fatalf("late event did not precede its marker: first=%v next=%v", first, markerFrame)
		}
	}
	for _, row := range liveResolveRows(t, f.serverURL, f.token) {
		if row["id"] == chatID || row["id"] == durableID || row["durableSessionId"] == durableID {
			t.Fatalf("late deleted durable resurrected on REST: %v", row)
		}
	}
	if first["sessionId"] != marker {
		t.Fatalf("late deleted durable resurrected on WS: %v", first)
	}
}

func TestLiveRowRereviewRenameResumableSessionCachedAfterEpochLoss(t *testing.T) {
	// Given: a real WS chat.create acquires C:X, then the provider epoch
	// closes while its Session remains in byChat for resume. A fresh epoch
	// delivers unbound activity into the overview cache for that same C:X.
	f := newLiveResolveFixture(t)
	const chatID = "chat-counts"
	const renamed = "Renamed after epoch loss"
	attached, attachedFrames := f.connectUnsubscribed()
	t.Cleanup(func() { _ = attached.WriteClose(1000, nil) })
	writeActivityE2EFrame(t, attached, map[string]any{"type": "chat.create", "wsId": f.storeWorkspaceID(), "chatId": chatID})
	attachedFrames.next(t, "ready")
	writeActivityE2EFrame(t, attached, map[string]any{"type": "ping"})
	attachedFrames.next(t, "pong")
	chat, err := f.store.GetChat(chatID)
	if err != nil || chat.DurableSessionID == "" || chat.SessionFile == "" {
		t.Fatalf("acquired chat cursor = %+v, err = %v", chat, err)
	}
	// Unbind the browser without stopping the provider session or removing
	// byChat. This prevents automatic subscriber recovery from acquiring a
	// replacement route when the transport drops.
	writeActivityE2EFrame(t, attached, map[string]any{"type": "chat.close", "sessionId": chatID})
	writeActivityE2EFrame(t, attached, map[string]any{"type": "ping"})
	attachedFrames.next(t, "pong")
	previousEpoch, oldEvents := f.client.CurrentEpoch()
	f.daemon.DropConnections()
	select {
	case _, open := <-oldEvents:
		if open {
			t.Fatal("lost provider epoch delivered an unexpected event")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("lost provider epoch did not close")
	}
	if _, exists := f.manager.Get(chatID); !exists {
		t.Fatal("epoch loss removed the resumable session from byChat")
	}
	if _, err := f.client.Call(t.Context(), omorpc.ListSessions{}); err != nil {
		t.Fatalf("establish successor epoch: %v", err)
	}
	if f.client.EpochCurrent(previousEpoch) {
		t.Fatal("successor still uses the lost provider epoch")
	}
	published := make(chan struct{}, 1)
	unsubscribe := f.manager.SubscribeOverview(func(summary session.Summary) {
		if summary.ChatID == chatID && summary.TaskDigest != nil {
			select {
			case published <- struct{}{}:
			default:
			}
		}
	})
	defer unsubscribe()
	f.emitUnboundTask(chat.DurableSessionID, 1)
	select {
	case <-published:
	case <-time.After(5 * time.Second):
		t.Fatal("successor activity never entered the overview cache")
	}
	frames := f.subscribeExplicit(chatID)
	fresh := frames.next(t, "sessions.activity")
	assertLiveFrameIdentity(t, fresh, chatID, chat.DurableSessionID)
	before, ok := fresh["last_activity_ms"].(float64)
	if !ok {
		t.Fatalf("cached activity has no revision: %v", fresh)
	}

	// When: the user renames C through the authenticated HTTP handler.
	renameChatE2E(t, f, chatID, renamed)

	// Then: the cached row's revision and title change for both a newly
	// subscribing browser and a subsequent REST read.
	initial := f.subscribeExplicit(chatID).next(t, "sessions.activity")
	assertLiveFrameIdentity(t, initial, chatID, chat.DurableSessionID)
	after, ok := initial["last_activity_ms"].(float64)
	if initial["title"] != renamed || !ok || after <= before {
		t.Fatalf("new WS initial row missed rename or revision: before=%v initial=%v", before, initial)
	}
	row := assertSoleLiveRow(t, f.serverURL, f.token)
	assertLiveRowIdentity(t, row, chatID)
	if revision, ok := row["last_activity_ms"].(float64); row["title"] != renamed || !ok || revision <= before {
		t.Fatalf("REST row missed rename or revision: before=%v row=%v", before, row)
	}
}
