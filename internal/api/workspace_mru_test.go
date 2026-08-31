package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/DevNewbie1826/omo-webchat/internal/store"
)

// TestListWorkspacesOrdersChatsMRUFirst pins the server-side recency order of
// the workspaces listing: each workspace's chats come back most-recently-used
// first, with legacy rows that never carried a last-used stamp falling back to
// creation time. The store's own order must stay untouched.
func TestListWorkspacesOrdersChatsMRUFirst(t *testing.T) {
	srv, st, ws, _ := newSessionHistoryTestServer(t)
	first, err := st.NewChat(ws.ID, "first-created", ws.Path, "", "omo")
	if err != nil {
		t.Fatalf("create first chat: %v", err)
	}
	second, err := st.NewChat(ws.ID, "second-created", ws.Path, "", "omo")
	if err != nil {
		t.Fatalf("create second chat: %v", err)
	}
	third, err := st.NewChat(ws.ID, "third-created", ws.Path, "", "omo")
	if err != nil {
		t.Fatalf("create third chat: %v", err)
	}
	// The oldest chat is the only one ever opened; its use stamp is newer
	// than every creation time, so it must lead the listing.
	touched := third.CreatedAt + 5_000
	if _, err := st.UpdateChat(ws.ID, first.ID, func(c *store.Chat) {
		c.LastUsedAt = touched
	}); err != nil {
		t.Fatalf("touch first chat: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/workspaces", nil)
	rec := httptest.NewRecorder()
	srv.handleListWorkspaces(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body: %s", rec.Code, http.StatusOK, rec.Body.String())
	}
	var listed []store.Workspace
	if err := json.NewDecoder(rec.Body).Decode(&listed); err != nil {
		t.Fatalf("decode listing: %v", err)
	}
	var chats []store.Chat
	for _, got := range listed {
		if got.ID == ws.ID {
			chats = got.Chats
		}
	}
	if len(chats) != 3 {
		t.Fatalf("listed chats = %+v, want all three", chats)
	}
	wantOrder := []string{first.ID, third.ID, second.ID}
	for i, want := range wantOrder {
		if chats[i].ID != want {
			t.Fatalf("listed chats[%d] = %s, want %s (full order: %v)", i, chats[i].ID, want, chatIDs(chats))
		}
	}

	// The listing is a projection: the store keeps insertion order.
	stored, err := st.GetWorkspace(ws.ID)
	if err != nil {
		t.Fatalf("get workspace: %v", err)
	}
	storedOrder := []string{first.ID, second.ID, third.ID}
	for i, want := range storedOrder {
		if stored.Chats[i].ID != want {
			t.Fatalf("stored chats[%d] = %s, want %s; listing must not reorder the store", i, stored.Chats[i].ID, want)
		}
	}
}

func chatIDs(chats []store.Chat) []string {
	ids := make([]string, 0, len(chats))
	for _, c := range chats {
		ids = append(ids, c.ID)
	}
	return ids
}
