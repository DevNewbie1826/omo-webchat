package api

import (
	"encoding/json"
	"github.com/DevNewbie1826/omo-webchat/internal/cursorstore"
	"net/http"
	"net/http/httptest"
	"testing"
)

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
