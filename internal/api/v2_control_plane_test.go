package api

import (
	"bytes"
	"encoding/json"
	"github.com/DevNewbie1826/omo-webchat/internal/cursorstore"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestCursorMetadataCRUD(t *testing.T) {
	s, st, ws := newChatCreateTestServer(t)
	create := httptest.NewRequest(http.MethodPost, "/", bytes.NewBufferString(`{"name":"chat","provider":"omo"}`))
	create.SetPathValue("wsId", ws.ID)
	cw := httptest.NewRecorder()
	s.handleCreateChat(cw, create)
	if cw.Code != http.StatusCreated {
		t.Fatalf("create %d: %s", cw.Code, cw.Body.String())
	}
	var c chatResponse
	if err := json.NewDecoder(cw.Body).Decode(&c); err != nil {
		t.Fatal(err)
	}
	rename := httptest.NewRequest(http.MethodPatch, "/", bytes.NewBufferString(`{"name":"renamed"}`))
	rename.SetPathValue("wsId", ws.ID)
	rename.SetPathValue("chatId", c.ID)
	rw := httptest.NewRecorder()
	s.handleRenameChat(rw, rename)
	if rw.Code != http.StatusOK {
		t.Fatalf("rename %d: %s", rw.Code, rw.Body.String())
	}
	got, err := st.GetChat(c.ID)
	if err != nil || got.Name != "renamed" || got.NameSource != cursorstore.NameSourceUser {
		t.Fatalf("chat=%+v err=%v", got, err)
	}
	del := httptest.NewRequest(http.MethodDelete, "/", nil)
	del.SetPathValue("wsId", ws.ID)
	del.SetPathValue("chatId", c.ID)
	dw := httptest.NewRecorder()
	s.handleDeleteChat(dw, del)
	if dw.Code != http.StatusNoContent {
		t.Fatalf("delete %d: %s", dw.Code, dw.Body.String())
	}
	if _, err = st.GetChat(c.ID); err == nil {
		t.Fatal("chat survived delete")
	}
}
func TestLegacyWebSocketRouteIsGone(t *testing.T) {
	s, _, _ := newChatCreateTestServer(t)
	token, err := s.sessions.Create(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest(http.MethodGet, "/api/ws", nil)
	r.AddCookie(&http.Cookie{Name: "th_session", Value: token})
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	if w.Code != http.StatusNotFound {
		t.Fatalf("/api/ws status=%d", w.Code)
	}
}
