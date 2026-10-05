package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/DevNewbie1826/omo-webchat/internal/cursorstore"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc/omorpctest"
	"github.com/DevNewbie1826/omo-webchat/internal/rpcwatch"
	"github.com/DevNewbie1826/omo-webchat/internal/session"
	"github.com/DevNewbie1826/omo-webchat/internal/wsbridge"
)

func TestEnrollmentTombstoneSurvivesDeleteAndReload(t *testing.T) {
	// Given: an auto-enrolled session still listed on the daemon, never attached.
	s, store, caller, ws := enrollmentFixture(t)
	caller.sessions = append(caller.sessions, observedEnrollment(ws, "deleted-durable"))
	s.rpcWatcher.Tick(t.Context())
	chats := store.ListChats(ws.ID)
	if len(chats) != 1 || !chats[0].AutoEnrolled {
		t.Fatalf("enrolled chats = %+v", chats)
	}
	req := httptest.NewRequest(http.MethodDelete, "/", nil)
	req.SetPathValue("wsId", ws.ID)
	req.SetPathValue("chatId", chats[0].ID)
	response := httptest.NewRecorder()
	// When: deleting through the normal handler and reloading persisted state.
	s.handleDeleteChat(response, req)
	if response.Code != http.StatusNoContent {
		t.Fatalf("DELETE = %d: %s", response.Code, response.Body.String())
	}
	reloaded, err := cursorstore.Open(filepath.Join(store.StateDir(), "state-v2.json"))
	if err != nil {
		t.Fatal(err)
	}
	s.cursors = reloaded
	s.rpcWatcher.Tick(t.Context())
	s.rpcWatcher.Tick(t.Context())
	// Then: two discovery ticks cannot recreate the deleted durable identity.
	if chats := reloaded.ListChats(ws.ID); len(chats) != 0 {
		t.Fatalf("deleted durable re-enrolled after reload: %+v", chats)
	}
	if !reloaded.EnrollmentDeleted("deleted-durable") {
		t.Fatal("durable tombstone not persisted")
	}
	// A replacement durable identity is a new session, not a tombstoned row.
	caller.sessions[0].DurableSessionID = "replacement-durable"
	s.rpcWatcher.Tick(t.Context())
	chats = reloaded.ListChats(ws.ID)
	if len(chats) != 1 || chats[0].DurableSessionID != "replacement-durable" {
		t.Fatalf("new durable did not enroll: %+v", chats)
	}
}

func TestEnrollmentDeleteUnattachedRunningKeepsDaemonSession(t *testing.T) {
	// Given: a running daemon route that the manager has never acquired.
	s, store, caller, ws := enrollmentFixture(t)
	dir, err := os.MkdirTemp("", "enrollment-delete-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)
	d := omorpctest.New(dir)
	if err := d.Start(); err != nil {
		t.Fatal(err)
	}
	defer d.Stop()
	owner, err := omorpc.Dial(t.Context(), d.SocketPath())
	if err != nil {
		t.Fatal(err)
	}
	defer owner.Close()
	observer, err := omorpc.Dial(t.Context(), d.SocketPath())
	if err != nil {
		t.Fatal(err)
	}
	defer observer.Close()
	s.manager = session.NewManager(session.Config{Client: observer, Store: (*wsbridge.CursorStore)(store)})
	defer s.manager.CloseAll(context.Background())
	resp, err := owner.Call(t.Context(), omorpc.OpenSession{CWD: ws.Path})
	if err != nil {
		t.Fatal(err)
	}
	var opened omorpc.OpenSessionData
	if err := json.Unmarshal(resp.Data, &opened); err != nil {
		t.Fatal(err)
	}
	release := d.HoldPrompt(opened.State.SessionFile)
	defer release()
	resp, err = owner.Call(t.Context(), omorpc.Prompt{SessionID: opened.SessionID, Message: "still working"})
	if err != nil {
		t.Fatal(err)
	}
	if err := resp.Err(); err != nil {
		t.Fatal(err)
	}
	caller.sessions = []rpcwatch.Session{{SessionID: opened.SessionID, DurableSessionID: opened.State.SessionID, SessionPath: opened.State.SessionFile, Cwd: ws.Path, Status: "working"}}
	s.rpcWatcher.Tick(t.Context())
	chat := store.ListChats(ws.ID)[0]
	req := httptest.NewRequest(http.MethodDelete, "/", nil)
	req.SetPathValue("wsId", ws.ID)
	req.SetPathValue("chatId", chat.ID)
	w := httptest.NewRecorder()
	// When: deleting the unopened auto-enrolled chat through the usual handler.
	s.handleDeleteChat(w, req)
	s.rpcWatcher.Tick(t.Context())
	s.rpcWatcher.Tick(t.Context())
	// Then: tombstone suppresses the row without changing StopContext ownership.
	if w.Code != http.StatusNoContent || len(store.ListChats(ws.ID)) != 0 {
		t.Fatalf("delete = %d, remaining = %+v", w.Code, store.ListChats(ws.ID))
	}
	if got := d.RequestCount(omorpc.CmdCloseSession); got != 0 {
		t.Fatalf("unattached deletion issued %d close_session requests", got)
	}
	stateResp, err := observer.Call(t.Context(), omorpc.GetState{SessionID: opened.SessionID})
	if err != nil {
		t.Fatal(err)
	}
	if err := stateResp.Err(); err != nil {
		t.Fatal(err)
	}
	var state omorpc.SessionState
	if err := json.Unmarshal(stateResp.Data, &state); err != nil {
		t.Fatal(err)
	}
	if state.IsStreaming == nil || !*state.IsStreaming {
		t.Fatalf("unattached daemon session stopped: %+v", state)
	}
}
