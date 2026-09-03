package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/adoptcopy"
	"github.com/DevNewbie1826/omo-webchat/internal/cursorstore"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc/omorpctest"
	"github.com/DevNewbie1826/omo-webchat/internal/session"
	"github.com/DevNewbie1826/omo-webchat/internal/wsbridge"
)

func openWorkspaceSession(t *testing.T, server *Server, wsID string, body any) *httptest.ResponseRecorder {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest(http.MethodPost, "/api/workspaces/"+wsID+"/sessions/open", bytes.NewReader(raw))
	r.SetPathValue("wsId", wsID)
	w := httptest.NewRecorder()
	server.handleOpenWorkspaceSession(w, r)
	return w
}

func TestOpenWorkspaceSessionPersistsValidatedOriginal(t *testing.T) {
	server, store, ws := newChatCreateTestServer(t)
	agentDir := t.TempDir()
	t.Setenv("OMO_CODING_AGENT_DIR", agentDir)
	source := writeAdoptableDiskSession(t, agentDir, ws.Path, "durable-in-place", "Original session")
	server.activityCheck = func(context.Context, string, time.Duration) (sessionActivity, error) {
		return sessionActivity{}, nil
	}

	response := openWorkspaceSession(t, server, ws.ID, map[string]any{"id": "durable-in-place", "resumeIdentity": source})
	if response.Code != http.StatusCreated {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	var projected chatResponse
	if err := json.NewDecoder(response.Body).Decode(&projected); err != nil {
		t.Fatal(err)
	}
	chat, err := store.GetChatForOpen(projected.ID)
	if err != nil {
		t.Fatal(err)
	}
	if chat.SessionFile != source || chat.DurableSessionID != "durable-in-place" || !cursorstore.IsInPlaceSession(chat) {
		t.Fatalf("stored in-place identity = %+v", chat)
	}
	if _, err := os.Stat(store.OwnedSessionDir()); !os.IsNotExist(err) {
		t.Fatalf("in-place open created adoption directory: %v", err)
	}
}

func TestOpenWorkspaceSessionFreshnessGateAndForce(t *testing.T) {
	server, store, ws := newChatCreateTestServer(t)
	agentDir := t.TempDir()
	t.Setenv("OMO_CODING_AGENT_DIR", agentDir)
	source := writeAdoptableDiskSession(t, agentDir, ws.Path, "durable-active", "")
	server.activityCheck = func(context.Context, string, time.Duration) (sessionActivity, error) {
		return sessionActivity{SizeDelta: 37, MtimeDeltaNano: 9000}, nil
	}

	blocked := openWorkspaceSession(t, server, ws.ID, map[string]any{"resumeIdentity": source})
	if blocked.Code != http.StatusConflict {
		t.Fatalf("status = %d, body = %s", blocked.Code, blocked.Body.String())
	}
	var state sessionActiveResponse
	if err := json.NewDecoder(blocked.Body).Decode(&state); err != nil {
		t.Fatal(err)
	}
	if state.State != "session-active" || state.SizeDelta != 37 || state.MtimeDeltaNano != 9000 {
		t.Fatalf("active state = %+v", state)
	}
	if chats := store.ListChats(ws.ID); len(chats) != 0 {
		t.Fatalf("freshness rejection persisted chats: %+v", chats)
	}

	forced := openWorkspaceSession(t, server, ws.ID, map[string]any{"resumeIdentity": source, "force": true})
	if forced.Code != http.StatusCreated || len(store.ListChats(ws.ID)) != 1 {
		t.Fatalf("forced status = %d, body = %s, chats = %+v", forced.Code, forced.Body.String(), store.ListChats(ws.ID))
	}
}

func TestInPlaceOpenUsesOriginalOnWireAndSnapshotsBeforeFirstWrite(t *testing.T) {
	server, store, ws := newChatCreateTestServer(t)
	agentDir := t.TempDir()
	t.Setenv("OMO_CODING_AGENT_DIR", agentDir)
	source := writeAdoptableDiskSession(t, agentDir, ws.Path, "durable-wire-original", "Wire original")
	before, err := os.ReadFile(source)
	if err != nil {
		t.Fatal(err)
	}
	server.activityCheck = func(context.Context, string, time.Duration) (sessionActivity, error) { return sessionActivity{}, nil }
	response := openWorkspaceSession(t, server, ws.ID, map[string]any{"resumeIdentity": source})
	if response.Code != http.StatusCreated {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	var projected chatResponse
	if err := json.NewDecoder(response.Body).Decode(&projected); err != nil {
		t.Fatal(err)
	}

	daemonDir, err := os.MkdirTemp("", "in-place-wire-*")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(daemonDir) })
	daemon := omorpctest.New(daemonDir)
	if err := daemon.LoadSessionFile(source); err != nil {
		t.Fatal(err)
	}
	if err := daemon.Start(); err != nil {
		t.Fatal(err)
	}
	client, err := omorpc.Dial(t.Context(), daemon.SocketPath())
	if err != nil {
		t.Fatal(err)
	}
	manager := session.NewManager(session.Config{Client: client, Store: (*wsbridge.CursorStore)(store.Store)})
	server.manager = manager
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = manager.CloseAll(ctx)
		_ = client.Close()
		daemon.Stop()
	})
	chat, err := store.GetChat(projected.ID)
	if err != nil {
		t.Fatal(err)
	}
	sub := &adoptionSessionSubscriber{frames: make(chan session.Frame, 32)}
	live, _, detach, err := manager.Acquire(t.Context(), adoptionChatRef{chat: chat}, sub)
	if err != nil {
		t.Fatal(err)
	}
	defer detach()
	sub.await(t, session.FrameReady)
	openedPath, _ := daemon.LastRequest(omorpc.CmdOpenSession)["sessionPath"].(string)
	if openedPath != source || live.SessionFile() != source {
		t.Fatalf("open_session path = %q, live path = %q, want original %q", openedPath, live.SessionFile(), source)
	}

	daemon.SetPromptScript(source, map[string]any{"type": omorpctest.EventAgentStart}, map[string]any{"type": omorpctest.EventAgentSettled, "reason": "end_turn"})
	if err := live.SendPrompt(t.Context(), "first web write", nil); err != nil {
		t.Fatal(err)
	}
	sub.await(t, session.FrameRunDone)
	backupPath := filepath.Join(store.StateDir(), "takeover-backups", adoptcopy.DestinationName("durable-wire-original"))
	backup, err := os.ReadFile(backupPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(backup, before) {
		t.Fatal("takeover backup does not contain the pre-write original")
	}

	daemon.SetPromptScript(source, map[string]any{"type": omorpctest.EventAgentStart}, map[string]any{"type": omorpctest.EventAgentSettled, "reason": "end_turn"})
	if err := live.SendPrompt(t.Context(), "second web write", nil); err != nil {
		t.Fatal(err)
	}
	sub.await(t, session.FrameRunDone)
	afterSecond, err := os.ReadFile(backupPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(afterSecond, before) {
		t.Fatal("second web write rewrote the one-time takeover backup")
	}
	entries, err := os.ReadDir(filepath.Dir(backupPath))
	if err != nil || len(entries) != 1 {
		t.Fatalf("backup entries = %v, err = %v", entries, err)
	}
}
