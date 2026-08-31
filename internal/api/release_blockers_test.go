package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/lxzan/gws"

	"github.com/DevNewbie1826/omo-webchat/internal/chat"
	"github.com/DevNewbie1826/omo-webchat/internal/store"
)

func TestConnHandlerAccessIsSynchronizedWithClose(t *testing.T) {
	server := &Server{chats: chat.NewManager()}
	conn := &gws.Conn{}
	h := &connHandler{srv: server, conn: conn, chatID: "chat-race"}
	server.conns.Store(conn, h)

	h.mu.Lock()
	started := make(chan struct{}, 2)
	done := make(chan struct{}, 2)
	go func() {
		started <- struct{}{}
		server.routeMessage(h, []byte(`{"type":"chat.abort","sessionId":"chat-race"}`))
		done <- struct{}{}
	}()
	go func() {
		started <- struct{}{}
		server.OnClose(conn, nil)
		done <- struct{}{}
	}()
	<-started
	<-started
	h.mu.Unlock()
	<-done
	<-done
}

func TestChatCreateAndDeleteLifecycleCannotOrphanSession(t *testing.T) {
	harness := newProviderWSHarness(t, "omo", "", nil)
	lookupReached := make(chan struct{})
	continueCreate := make(chan struct{})
	deleteStarted := make(chan struct{})
	harness.server.afterChatLookup = func() {
		close(lookupReached)
		<-continueCreate
	}
	harness.server.beforeChatDelete = func() { close(deleteStarted) }

	harness.create(t)
	select {
	case <-lookupReached:
	case <-time.After(2 * time.Second):
		t.Fatal("chat create did not reach lookup hook")
	}

	deleted := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		req := httptest.NewRequest(http.MethodDelete, "/api/workspaces/"+harness.workspace.ID+"/chats/"+harness.chat.ID, nil)
		req.SetPathValue("wsId", harness.workspace.ID)
		req.SetPathValue("chatId", harness.chat.ID)
		rec := httptest.NewRecorder()
		harness.server.handleDeleteChat(rec, req)
		deleted <- rec
	}()
	<-deleteStarted
	close(continueCreate)

	select {
	case rec := <-deleted:
		if rec.Code != http.StatusNoContent {
			t.Fatalf("delete status = %d, want %d; body: %s", rec.Code, http.StatusNoContent, rec.Body.String())
		}
	case <-time.After(3 * time.Second):
		t.Fatal("chat delete did not complete")
	}
	if _, err := harness.store.GetChat(harness.workspace.ID, harness.chat.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("deleted chat lookup error = %v, want not found", err)
	}
	if session := harness.server.chats.Get(harness.chat.ID); session != nil {
		t.Fatalf("delete orphaned session %p", session)
	}
}

func TestDeleteWorkspaceSerializesCreateAndStopsEveryActiveChat(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skipf("node not in PATH: %v", err)
	}
	harness := newProviderWSHarness(t, "omo", "", nil)
	activeIDs := []string{harness.chat.ID}
	for _, name := range []string{"active-two", "active-three"} {
		record, err := harness.store.NewChat(harness.workspace.ID, name, harness.workspace.Path, "", "omo")
		if err != nil {
			t.Fatalf("create %s: %v", name, err)
		}
		activeIDs = append(activeIDs, record.ID)
		// The multi-session mock tolerates the --multi-session flag the shared
		// provider appends, so all three chats run on one provider process.
		if _, _, err := harness.server.chats.Acquire(context.Background(), chat.SessionOptions{
			ID: record.ID, Binary: "node", Args: []string{mockPiPath(t)}, Env: os.Environ(),
			ProviderContext: context.Background(),
		}); err != nil {
			t.Fatalf("start %s: %v", name, err)
		}
	}

	lookupReached := make(chan struct{})
	continueCreate := make(chan struct{})
	deleteStarted := make(chan struct{})
	harness.server.afterChatLookup = func() {
		close(lookupReached)
		<-continueCreate
	}
	harness.server.beforeWorkspaceDelete = func() { close(deleteStarted) }
	harness.create(t)
	select {
	case <-lookupReached:
	case <-time.After(2 * time.Second):
		t.Fatal("chat.create did not reach lookup hook")
	}

	deleted := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		req := httptest.NewRequest(http.MethodDelete, "/api/workspaces/"+harness.workspace.ID, nil)
		req.SetPathValue("wsId", harness.workspace.ID)
		rec := httptest.NewRecorder()
		harness.server.handleDeleteWorkspace(rec, req)
		deleted <- rec
	}()
	<-deleteStarted
	close(continueCreate)

	select {
	case rec := <-deleted:
		if rec.Code != http.StatusNoContent {
			t.Fatalf("delete status = %d, want %d; body: %s", rec.Code, http.StatusNoContent, rec.Body.String())
		}
	case <-time.After(3 * time.Second):
		t.Fatal("workspace delete did not complete")
	}
	removed, err := harness.store.GetWorkspace(harness.workspace.ID)
	if !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("workspace lookup = %+v, err %v; want not found", removed, err)
	}
	for _, chatID := range activeIDs {
		if session := harness.server.chats.Get(chatID); session != nil {
			t.Fatalf("workspace delete left active chat %q: %p", chatID, session)
		}
	}
}

// TestListWorkspacesProjectsLegacyChatsWithoutWrites pins the read-only
// listing policy: legacy launchable identities (empty, senpi) are projected to
// omo in returned copies only, unsupported providers stay hidden, and no
// listing call writes the provider back to the store or the state file.
func TestListWorkspacesProjectsLegacyChatsWithoutWrites(t *testing.T) {
	srv, st, ws := newChatCreateTestServer(t)
	srv.cfg.Provider = "not-a-provider"
	legacy, err := st.NewChat(ws.ID, "legacy", ws.Path, "", "")
	if err != nil {
		t.Fatalf("create legacy chat: %v", err)
	}
	rebranded, err := st.NewChat(ws.ID, "rebranded", ws.Path, "", "senpi")
	if err != nil {
		t.Fatalf("create senpi chat: %v", err)
	}
	if _, err := st.NewChat(ws.ID, "unsupported", ws.Path, "", "omp"); err != nil {
		t.Fatalf("create omp chat: %v", err)
	}
	statePath := filepath.Join(mustStateDir(t), "state.json")
	before, err := os.ReadFile(statePath)
	if err != nil {
		t.Fatalf("read state before listing: %v", err)
	}

	rec := httptest.NewRecorder()
	srv.handleListWorkspaces(rec, httptest.NewRequest(http.MethodGet, "/api/workspaces", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body: %s", rec.Code, rec.Body.String())
	}
	var workspaces []store.Workspace
	if err := json.NewDecoder(rec.Body).Decode(&workspaces); err != nil {
		t.Fatalf("decode workspaces: %v", err)
	}
	if len(workspaces) != 1 || len(workspaces[0].Chats) != 2 {
		t.Fatalf("workspaces = %+v, want exactly the two launchable chats", workspaces)
	}
	for _, listed := range workspaces[0].Chats {
		if listed.Provider != "omo" {
			t.Fatalf("listed chat %s provider = %q, want projected omo", listed.Name, listed.Provider)
		}
	}

	after, err := os.ReadFile(statePath)
	if err != nil {
		t.Fatalf("read state after listing: %v", err)
	}
	if !bytes.Equal(before, after) {
		t.Fatalf("listing rewrote the state file:\n got: %s\nwant: %s", after, before)
	}
	persisted, err := st.GetChat(ws.ID, legacy.ID)
	if err != nil || persisted.Provider != "" {
		t.Fatalf("legacy persisted provider = %q, err %v; want empty preserved", persisted.Provider, err)
	}
	persisted, err = st.GetChat(ws.ID, rebranded.ID)
	if err != nil || persisted.Provider != "senpi" {
		t.Fatalf("senpi persisted provider = %q, err %v; want senpi preserved", persisted.Provider, err)
	}
}

func mustStateDir(t *testing.T) string {
	t.Helper()
	dir, err := store.StateDir()
	if err != nil {
		t.Fatalf("state dir: %v", err)
	}
	return dir
}
