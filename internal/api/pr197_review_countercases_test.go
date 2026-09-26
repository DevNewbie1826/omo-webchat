package api

import (
	"errors"
	"fmt"
	"net/http"
	"testing"

	"github.com/DevNewbie1826/omo-webchat/internal/auth"
	"github.com/DevNewbie1826/omo-webchat/internal/cursorstore"
)

func evictPR197ReviewRow(t *testing.T, f *liveResolveFixture, chatID string) {
	t.Helper()
	ids := make([]string, 256)
	for i := range ids {
		ids[i] = fmt.Sprintf("review-filler-%03d", i)
	}
	frames := f.subscribeExplicit(ids...)
	for _, id := range ids {
		f.emitUnboundTask(id, 1)
		if frame := frames.next(t, "sessions.activity"); frame["sessionId"] != id {
			t.Fatalf("eviction fence = %v, want %q", frame, id)
		}
	}
	rows := liveResolveRows(t, f.serverURL, f.token)
	if len(rows) != 256 {
		t.Fatalf("eviction fixture has %d rows, want 256", len(rows))
	}
	for _, row := range rows {
		if row["id"] == chatID {
			t.Fatalf("fixture did not evict chat: %v", row)
		}
	}
}

func TestPR197ReviewWorkspaceDeleteAfterEviction(t *testing.T) {
	// Given: C:X was published without acquisition, then evicted.
	f := newLiveResolveFixture(t)
	const chatID, durableID = "review-workspace-chat", "review-workspace-durable"
	f.saveChatClaiming(chatID, "Deleted workspace chat", durableID)
	before := f.subscribeExplicit(chatID)
	f.emitUnboundTask(durableID, 1)
	assertLiveFrameIdentity(t, before.next(t, "sessions.activity"), chatID, durableID)
	evictPR197ReviewRow(t, f, chatID)
	workspaceID := f.storeWorkspaceID()
	const marker = "review-workspace-barrier"
	after := f.subscribeExplicit(chatID, durableID, marker)

	// When: the authenticated workspace DELETE succeeds, followed by late X.
	req, err := http.NewRequestWithContext(t.Context(), http.MethodDelete,
		f.serverURL+"/api/workspaces/"+workspaceID, nil)
	if err != nil {
		t.Fatal(err)
	}
	req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: f.token})
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if err := resp.Body.Close(); err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("workspace DELETE = %d, want 204", resp.StatusCode)
	}
	if _, err := f.store.GetChat(chatID); !errors.Is(err, cursorstore.ErrNotFound) {
		t.Fatalf("chat metadata survived workspace deletion: %v", err)
	}
	f.emitUnboundTask(durableID, 2)
	f.emitUnboundTask(marker, 1)
	first := after.next(t, "sessions.activity")
	if first["sessionId"] != marker {
		if fence := after.next(t, "sessions.activity"); fence["sessionId"] != marker {
			t.Fatalf("FIFO barrier missing: %v", fence)
		}
	}

	// Then: neither wire surface may recreate the deleted identity.
	for _, row := range liveResolveRows(t, f.serverURL, f.token) {
		if row["id"] == chatID || row["id"] == durableID {
			t.Errorf("REST resurrected workspace-deleted chat after HTTP 204: %v", row)
		}
	}
	if first["sessionId"] != marker {
		t.Errorf("WS resurrected workspace-deleted chat after HTTP 204: %v", first)
	}
}

func TestPR197ReviewCursorRebindAfterEviction(t *testing.T) {
	// Given: C:X was published and then evicted without acquisition.
	f := newLiveResolveFixture(t)
	const chatID, oldID, newID = "review-evicted-chat", "review-evicted-x", "review-evicted-y"
	f.saveChatClaiming(chatID, "Cursor after eviction", oldID)
	before := f.subscribeExplicit(chatID)
	f.emitUnboundTask(oldID, 1)
	assertLiveFrameIdentity(t, before.next(t, "sessions.activity"), chatID, oldID)
	evictPR197ReviewRow(t, f, chatID)
	const marker = "review-cursor-barrier"
	frames := f.subscribeExplicit(chatID, oldID, marker)

	// When: the stored cursor changes to Y and publishes, then old X arrives.
	rebindLiveRowCursor(t, f, chatID, newID)
	emitRereviewTasks(f, newID, 2, 2)
	assertLiveFrameIdentity(t, frames.next(t, "sessions.activity"), chatID, newID)
	f.emitUnboundTask(oldID, 3)
	f.emitUnboundTask(marker, 1)
	first := frames.next(t, "sessions.activity")
	if first["sessionId"] != marker {
		if fence := frames.next(t, "sessions.activity"); fence["sessionId"] != marker {
			t.Fatalf("FIFO barrier missing: %v", fence)
		}
	}

	// Then: the superseded durable must not return as a second UUID row.
	for _, row := range liveResolveRows(t, f.serverURL, f.token) {
		if row["id"] == oldID {
			t.Errorf("REST resurrected superseded durable after cursor change: %v", row)
		}
	}
	if first["sessionId"] != marker {
		t.Errorf("WS resurrected superseded durable after cursor change: %v", first)
	}
}

func TestPR197ReviewCursorReturnsToRetiredDurable(t *testing.T) {
	// Given: a cold stored chat has transitioned X -> Y, retiring X.
	f := newLiveResolveFixture(t)
	const chatID, oldID, newID = "review-return-chat", "review-return-x", "review-return-y"
	const marker = "review-return-barrier"
	f.saveChatClaiming(chatID, "Returned cursor", oldID)
	frames := f.subscribeExplicit(chatID, marker)
	emitRereviewTasks(f, oldID, 1, 1)
	assertLiveFrameIdentity(t, frames.next(t, "sessions.activity"), chatID, oldID)
	rebindLiveRowCursor(t, f, chatID, newID)
	emitRereviewTasks(f, newID, 2, 2)
	assertLiveFrameIdentity(t, frames.next(t, "sessions.activity"), chatID, newID)

	// When: the authoritative stored cursor returns to X without acquisition.
	rebindLiveRowCursor(t, f, chatID, oldID)
	emitRereviewTasks(f, oldID, 3, 3)
	f.emitUnboundTask(marker, 1)
	first := frames.next(t, "sessions.activity")
	if first["sessionId"] != marker {
		if fence := frames.next(t, "sessions.activity"); fence["sessionId"] != marker {
			t.Fatalf("FIFO barrier missing: %v", fence)
		}
	}

	// Then: the current chat row must carry X's new snapshot, not stale Y.
	if first["sessionId"] != chatID || first["durableSessionId"] != oldID {
		t.Errorf("WS ignored authoritative cursor return to X: first=%v", first)
	}
	found := false
	for _, row := range liveResolveRows(t, f.serverURL, f.token) {
		if row["id"] != chatID {
			continue
		}
		found = true
		running, ok := row["running"].(map[string]any)
		if !ok || running["tasks"] != float64(3) {
			t.Errorf("REST retained Y instead of current X: %v", row)
		}
	}
	if !found {
		t.Fatal("REST omitted the current stored chat entirely")
	}
}
