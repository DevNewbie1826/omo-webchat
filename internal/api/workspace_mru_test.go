package api

import (
	"encoding/json"
	"github.com/DevNewbie1826/omo-webchat/internal/cursorstore"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestWorkspaceProjectionNormalizesLegacyTimestamps(t *testing.T) {
	s, st, ws := newChatCreateTestServer(t)
	chat := cursorstore.Chat{ID: "legacy", WorkspaceID: ws.ID, CWD: ws.Path, Name: "legacy", NameSource: "auto", CreatedAt: 1_700_000_000, LastUsedAt: 1_700_000_100}
	if err := st.SaveChat(chat); err != nil {
		t.Fatal(err)
	}

	projected := s.projectWorkspace(ws)
	if len(projected.Chats) != 1 {
		t.Fatalf("chats = %+v", projected.Chats)
	}
	if got := projected.Chats[0]; got.CreatedAt != 1_700_000_000_000 || got.LastUsedAt != 1_700_000_100_000 {
		t.Fatalf("projected timestamps = created %d, used %d", got.CreatedAt, got.LastUsedAt)
	}
}

func TestListWorkspacesOrdersChatsMRUFirst(t *testing.T) {
	s, st, ws := newChatCreateTestServer(t)
	for _, c := range []cursorstore.Chat{{ID: "first", WorkspaceID: ws.ID, CWD: ws.Path, Name: "first", NameSource: "auto", CreatedAt: 1, LastUsedAt: 10}, {ID: "second", WorkspaceID: ws.ID, CWD: ws.Path, Name: "second", NameSource: "auto", CreatedAt: 2}} {
		if err := st.SaveChat(c); err != nil {
			t.Fatal(err)
		}
	}
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	w := httptest.NewRecorder()
	s.handleListWorkspaces(w, r)
	var rows []workspaceResponse
	if err := json.NewDecoder(w.Body).Decode(&rows); err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || len(rows[0].Chats) != 2 || rows[0].Chats[0].ID != "first" {
		t.Fatalf("rows=%+v", rows)
	}
}
