package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
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

func TestOpenWorkspaceSessionWriterStartingAfterRegistrationIsGatedAtProviderAcquisition(t *testing.T) {
	server, store, ws := newChatCreateTestServer(t)
	agentDir := t.TempDir()
	t.Setenv("OMO_CODING_AGENT_DIR", agentDir)
	source := writeAdoptableDiskSession(t, agentDir, ws.Path, "durable-active", "")
	var checks atomic.Int32
	var writerActive atomic.Bool
	server.activityCheck = func(context.Context, string, time.Duration) (sessionActivity, error) {
		checks.Add(1)
		if writerActive.Load() {
			return sessionActivity{SizeDelta: 37, MtimeDeltaNano: 9000}, nil
		}
		return sessionActivity{}, nil
	}

	registered := openWorkspaceSession(t, server, ws.ID, map[string]any{"resumeIdentity": source})
	if registered.Code != http.StatusCreated {
		t.Fatalf("registration status = %d, body = %s", registered.Code, registered.Body.String())
	}
	if checks.Load() != 1 {
		t.Fatalf("activity checks during REST registration = %d, want 1", checks.Load())
	}
	writerActive.Store(true)
	var projected chatResponse
	if err := json.NewDecoder(registered.Body).Decode(&projected); err != nil {
		t.Fatal(err)
	}
	cursorStore := (*wsbridge.CursorStore)(store.Store)
	if _, err := cursorStore.CursorForOpen(t.Context(), projected.ID); !errors.As(err, new(*wsbridge.SessionActiveError)) {
		t.Fatalf("provider acquisition error = %v, want session-active", err)
	}
	if checks.Load() != 2 {
		t.Fatalf("activity checks after provider acquisition = %d, want 2", checks.Load())
	}
	backupPath := filepath.Join(store.StateDir(), "takeover-backups", adoptcopy.DestinationName("durable-active"))
	if _, err := os.Stat(backupPath); !os.IsNotExist(err) {
		t.Fatalf("blocked acquisition consumed backup: %v", err)
	}

	forced := openWorkspaceSession(t, server, ws.ID, map[string]any{"resumeIdentity": source, "force": true})
	if forced.Code != http.StatusOK {
		t.Fatalf("forced registration status = %d, body = %s", forced.Code, forced.Body.String())
	}
	if _, err := cursorStore.CursorForOpen(t.Context(), projected.ID); err != nil {
		t.Fatalf("forced provider acquisition: %v", err)
	}
	if checks.Load() != 2 {
		t.Fatalf("one-shot force ran activity check: checks = %d", checks.Load())
	}
	if _, err := os.Stat(backupPath); err != nil {
		t.Fatalf("forced acquisition did not prepare backup: %v", err)
	}
	if _, err := cursorStore.CursorForOpen(t.Context(), projected.ID); !errors.As(err, new(*wsbridge.SessionActiveError)) {
		t.Fatalf("provider reopen after force error = %v, want session-active", err)
	}
	if checks.Load() != 3 {
		t.Fatalf("force was not consumed once: checks = %d, want 3", checks.Load())
	}
}

func TestStoredInPlaceRowReopenWhileActiveDoesNotOpenOrConsumeBackup(t *testing.T) {
	server, store, ws := newChatCreateTestServer(t)
	agentDir := t.TempDir()
	t.Setenv("OMO_CODING_AGENT_DIR", agentDir)
	source := writeAdoptableDiskSession(t, agentDir, ws.Path, "durable-reopen-active", "Reopen active")
	chat := cursorstore.Chat{ID: "chat-reopen-active", WorkspaceID: ws.ID, CWD: ws.Path, SessionFile: source, DurableSessionID: "durable-reopen-active", SessionProvenance: cursorstore.SessionProvenanceInPlace, Name: "Reopen active", NameSource: cursorstore.NameSourceAuto}
	if err := store.SaveChat(chat); err != nil {
		t.Fatal(err)
	}
	var active atomic.Bool
	server.activityCheck = func(context.Context, string, time.Duration) (sessionActivity, error) {
		if active.Load() {
			return sessionActivity{SizeDelta: 1}, nil
		}
		return sessionActivity{}, nil
	}
	response := openWorkspaceSession(t, server, ws.ID, map[string]any{"resumeIdentity": source, "force": true})
	if response.Code != http.StatusOK {
		t.Fatalf("force registration status = %d, body = %s", response.Code, response.Body.String())
	}

	daemonDir, err := os.MkdirTemp("", "in-place-reopen-active-*")
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
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = manager.CloseAll(ctx)
		_ = client.Close()
		daemon.Stop()
	})

	_, _, detach, err := manager.Acquire(t.Context(), adoptionChatRef{chat: chat}, nil)
	if err != nil {
		t.Fatalf("forced first acquisition: %v", err)
	}
	detach()
	if got := daemon.RequestCount(omorpc.CmdOpenSession); got != 1 {
		t.Fatalf("first acquisition open_session count = %d, want 1", got)
	}
	if err := manager.StopContext(t.Context(), chat.ID); err != nil {
		t.Fatal(err)
	}
	backupDir := filepath.Join(store.StateDir(), "takeover-backups")
	if err := os.RemoveAll(backupDir); err != nil {
		t.Fatal(err)
	}
	active.Store(true)

	_, _, detach, err = manager.Acquire(t.Context(), adoptionChatRef{chat: chat}, nil)
	if detach != nil {
		detach()
	}
	if !errors.As(err, new(*wsbridge.SessionActiveError)) {
		t.Fatalf("stored-row reopen error = %v, want session-active", err)
	}
	if got := daemon.RequestCount(omorpc.CmdOpenSession); got != 1 {
		t.Fatalf("active reopen open_session count = %d, want 1", got)
	}
	if _, err := os.Stat(backupDir); !os.IsNotExist(err) {
		t.Fatalf("active stored-row reopen consumed backup: %v", err)
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
	backupPath := filepath.Join(store.StateDir(), "takeover-backups", adoptcopy.DestinationName("durable-wire-original"))
	backup, err := os.ReadFile(backupPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(backup, before) {
		t.Fatal("takeover backup was not captured before open_session")
	}

	daemon.SetPromptScript(source, map[string]any{"type": omorpctest.EventAgentStart}, map[string]any{"type": omorpctest.EventAgentSettled, "reason": "end_turn"})
	if err := live.SendPrompt(t.Context(), "first web write", nil); err != nil {
		t.Fatal(err)
	}
	sub.await(t, session.FrameRunDone)
	backup, err = os.ReadFile(backupPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(backup, before) {
		t.Fatal("first web write rewrote the pre-takeover backup")
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
