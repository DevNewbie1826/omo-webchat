package api

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/lxzan/gws"

	"github.com/DevNewbie1826/omo-webchat/internal/adoptcopy"
	"github.com/DevNewbie1826/omo-webchat/internal/auth"
	"github.com/DevNewbie1826/omo-webchat/internal/config"
	"github.com/DevNewbie1826/omo-webchat/internal/cursorstore"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc/omorpctest"
	"github.com/DevNewbie1826/omo-webchat/internal/session"
	"github.com/DevNewbie1826/omo-webchat/internal/wsbridge"
)

func writeAdoptableDiskSession(t *testing.T, agentDir, cwd, id, name string) string {
	t.Helper()
	dir := filepath.Join(agentDir, "sessions", sessionDirNameForCwd(cwd))
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, id+".jsonl")
	body := fmt.Sprintf("{\"type\":\"session\",\"id\":%q,\"version\":3,\"timestamp\":\"2026-09-02T00:00:00Z\",\"cwd\":%q}\n", id, cwd)
	if name != "" {
		body += fmt.Sprintf("{\"type\":\"session_info\",\"id\":\"info\",\"parentId\":null,\"name\":%q}\n", name)
	}
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func adoptWorkspaceSession(t *testing.T, s *Server, wsID string, body any) *httptest.ResponseRecorder {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest(http.MethodPost, "/api/workspaces/"+wsID+"/sessions/adopt", bytes.NewReader(raw))
	r.SetPathValue("wsId", wsID)
	w := httptest.NewRecorder()
	s.handleAdoptWorkspaceSession(w, r)
	return w
}

type adoptionWSCollector struct {
	gws.BuiltinEventHandler
	frames chan map[string]any
}

func (c *adoptionWSCollector) OnMessage(_ *gws.Conn, message *gws.Message) {
	defer message.Close()
	var frame map[string]any
	if json.Unmarshal(message.Bytes(), &frame) == nil {
		c.frames <- frame
	}
}

func (c *adoptionWSCollector) next(t *testing.T, typ string) map[string]any {
	t.Helper()
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()
	for {
		select {
		case frame := <-c.frames:
			if frame["type"] == typ {
				return frame
			}
		case <-timer.C:
			t.Fatalf("timed out waiting for %s", typ)
		}
	}
}

func TestLegacyChatCreateRequiresAdoptionBeforeProviderOpen(t *testing.T) {
	dir := t.TempDir()
	daemonDir, err := os.MkdirTemp("", "adopt-guard-*")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(daemonDir) })
	daemon := omorpctest.New(daemonDir)
	if err := daemon.Start(); err != nil {
		t.Fatal(err)
	}
	client, err := omorpc.Dial(t.Context(), daemon.SocketPath())
	if err != nil {
		t.Fatal(err)
	}
	store, err := cursorstore.Open(filepath.Join(dir, "state-v2.json"))
	if err != nil {
		t.Fatal(err)
	}
	ws := cursorstore.Workspace{ID: "ws-adoption-guard", Name: "work", Path: dir}
	if err := store.SaveWorkspace(ws); err != nil {
		t.Fatal(err)
	}

	agentDir := t.TempDir()
	t.Setenv("OMO_CODING_AGENT_DIR", agentDir)
	source := writeAdoptableDiskSession(t, agentDir, ws.Path, "durable-invalid", "Invalid legacy")
	file, err := os.OpenFile(source, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.WriteString("{not-json}\n"); err != nil {
		_ = file.Close()
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	const chatID = "legacy-adoption-guard"
	if err := store.SaveChat(cursorstore.Chat{
		ID: chatID, WorkspaceID: ws.ID, CWD: ws.Path, SessionFile: source,
		DurableSessionID: "durable-invalid", Name: "Invalid legacy", NameSource: cursorstore.NameSourceAuto,
	}); err != nil {
		t.Fatal(err)
	}

	manager := session.NewManager(session.Config{Client: client, Store: (*wsbridge.CursorStore)(store)})
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	sessionStore := auth.NewSessionStore(t.Context(), "pw", logger)
	var server *Server
	bridge := wsbridge.New(wsbridge.Config{
		Context: t.Context(), Manager: manager, Store: store, ServerVersion: client.ServerVersion(), Logger: logger,
		PrepareChatVersion: func(ctx context.Context, wsID, chatID string) (uint64, error) {
			return server.prepareChatVersion(ctx, wsID, chatID)
		},
		ChatVersion: func(chatID string) uint64 { return server.chatLifecycleVersion(chatID) },
	})
	server = New(t.Context(), &config.Config{Root: dir}, store, sessionStore, manager, bridge, logger)
	testServer := httptest.NewServer(server.Handler())
	t.Cleanup(func() {
		testServer.Close()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = manager.CloseAll(ctx)
		_ = client.Close()
		daemon.Stop()
	})

	token, err := sessionStore.Create(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	collector := &adoptionWSCollector{frames: make(chan map[string]any, 8)}
	conn, _, err := gws.NewClient(collector, &gws.ClientOption{
		Addr:          "ws" + strings.TrimPrefix(testServer.URL, "http") + "/api/v2/ws",
		RequestHeader: http.Header{"Cookie": []string{auth.CookieName + "=" + token}},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.WriteClose(1000, nil)
	go conn.ReadLoop()
	collector.next(t, "hello")
	write := func(frame any) {
		raw, marshalErr := json.Marshal(frame)
		if marshalErr != nil {
			t.Fatal(marshalErr)
		}
		if writeErr := conn.WriteMessage(gws.OpcodeText, raw); writeErr != nil {
			t.Fatal(writeErr)
		}
	}
	write(map[string]any{"type": "hello", "version": 2})
	write(map[string]any{"type": "chat.create", "wsId": ws.ID, "chatId": chatID})
	if frame := collector.next(t, "error"); frame["code"] != "adoption_required" {
		t.Fatalf("chat.create error code = %v, want adoption_required", frame["code"])
	}
	if got := daemon.RequestCount(omorpc.CmdOpenSession); got != 0 {
		t.Fatalf("open_session count = %d, want 0", got)
	}
}

func TestAdoptionHTTPToBridgePreservesOriginalThroughCompletedTurn(t *testing.T) {
	dir := t.TempDir()
	daemonDir, err := os.MkdirTemp("", "adopt-e2e-*")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(daemonDir) })
	daemon := omorpctest.New(daemonDir)
	if err := daemon.Start(); err != nil {
		t.Fatal(err)
	}
	client, err := omorpc.Dial(t.Context(), daemon.SocketPath())
	if err != nil {
		t.Fatal(err)
	}
	store, err := cursorstore.Open(filepath.Join(dir, "state-v2.json"))
	if err != nil {
		t.Fatal(err)
	}
	ws := cursorstore.Workspace{ID: "ws-adopt-e2e", Name: "work", Path: dir}
	if err := store.SaveWorkspace(ws); err != nil {
		t.Fatal(err)
	}
	manager := session.NewManager(session.Config{Client: client, Store: (*wsbridge.CursorStore)(store)})
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	sessionStore := auth.NewSessionStore(t.Context(), "pw", logger)
	var server *Server
	bridge := wsbridge.New(wsbridge.Config{
		Context: t.Context(), Manager: manager, Store: store, ServerVersion: client.ServerVersion(), Logger: logger,
		PrepareChatVersion: func(ctx context.Context, wsID, chatID string) (uint64, error) {
			return server.prepareChatVersion(ctx, wsID, chatID)
		},
		ChatVersion: func(chatID string) uint64 { return server.chatLifecycleVersion(chatID) },
	})
	server = New(t.Context(), &config.Config{Root: dir}, store, sessionStore, manager, bridge, logger)
	testServer := httptest.NewServer(server.Handler())
	t.Cleanup(func() {
		testServer.Close()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = manager.CloseAll(ctx)
		_ = client.Close()
		daemon.Stop()
	})

	token, err := sessionStore.Create(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	agentDir := t.TempDir()
	t.Setenv("OMO_CODING_AGENT_DIR", agentDir)
	source := writeAdoptableDiskSession(t, agentDir, ws.Path, "durable-e2e", "Bridge copy")
	sourceBefore, err := os.ReadFile(source)
	if err != nil {
		t.Fatal(err)
	}
	sourceHashBefore := sha256.Sum256(sourceBefore)
	sourceInfoBefore, err := os.Stat(source)
	if err != nil {
		t.Fatal(err)
	}

	post := func(path string, body any) *http.Response {
		t.Helper()
		raw, marshalErr := json.Marshal(body)
		if marshalErr != nil {
			t.Fatal(marshalErr)
		}
		req, requestErr := http.NewRequestWithContext(t.Context(), http.MethodPost, testServer.URL+path, bytes.NewReader(raw))
		if requestErr != nil {
			t.Fatal(requestErr)
		}
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: token})
		resp, requestErr := http.DefaultClient.Do(req)
		if requestErr != nil {
			t.Fatal(requestErr)
		}
		return resp
	}

	legacyCreate := post("/api/workspaces/"+ws.ID+"/chats", map[string]string{
		"name": "legacy", "provider": "omo", "resumeIdentity": source,
	})
	_, _ = io.Copy(io.Discard, legacyCreate.Body)
	_ = legacyCreate.Body.Close()
	if legacyCreate.StatusCode != http.StatusBadRequest {
		t.Fatalf("legacy create status = %d, want %d", legacyCreate.StatusCode, http.StatusBadRequest)
	}

	const chatID = "legacy-adopt-e2e"
	if err := store.SaveChat(cursorstore.Chat{
		ID: chatID, WorkspaceID: ws.ID, CWD: ws.Path, SessionFile: source,
		DurableSessionID: "durable-e2e", Name: "Bridge copy", NameSource: cursorstore.NameSourceAuto,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.GetChatForOpen(chatID); !errors.Is(err, cursorstore.ErrAdoptionRequired) {
		t.Fatalf("original-backed chat was openable before migration: %v", err)
	}
	if got := daemon.RequestCount(omorpc.CmdOpenSession); got != 0 {
		t.Fatalf("provider received %d opens before migration", got)
	}

	resp := post("/api/workspaces/"+ws.ID+"/sessions/adopt", map[string]string{
		"id": "durable-e2e", "resumeIdentity": source,
	})
	if resp.StatusCode != http.StatusOK {
		raw, _ := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		t.Fatalf("adopt status = %d, body = %s", resp.StatusCode, raw)
	}
	var adopted chatResponse
	if err := json.NewDecoder(resp.Body).Decode(&adopted); err != nil {
		_ = resp.Body.Close()
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if adopted.ID != chatID {
		t.Fatalf("adoption replaced legacy chat id: got %q want %q", adopted.ID, chatID)
	}
	stored, err := store.GetChatForOpen(chatID)
	if err != nil {
		t.Fatalf("migrated chat is not openable: %v", err)
	}
	if !cursorstore.IsOwnedSession(stored, store.OwnedSessionDir()) || stored.SessionFile == source {
		t.Fatalf("migration did not install an owned copy: %+v", stored)
	}
	if err := daemon.LoadSessionFile(stored.SessionFile); err != nil {
		t.Fatalf("register owned copy with test daemon: %v", err)
	}

	collector := &adoptionWSCollector{frames: make(chan map[string]any, 32)}
	conn, _, err := gws.NewClient(collector, &gws.ClientOption{
		Addr:          "ws" + strings.TrimPrefix(testServer.URL, "http") + "/api/v2/ws",
		RequestHeader: http.Header{"Cookie": []string{auth.CookieName + "=" + token}},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.WriteClose(1000, nil)
	go conn.ReadLoop()
	collector.next(t, "hello")
	write := func(frame any) {
		raw, marshalErr := json.Marshal(frame)
		if marshalErr != nil {
			t.Fatal(marshalErr)
		}
		if writeErr := conn.WriteMessage(gws.OpcodeText, raw); writeErr != nil {
			t.Fatal(writeErr)
		}
	}
	write(map[string]any{"type": "hello", "version": 2})
	write(map[string]any{"type": "chat.create", "wsId": ws.ID, "chatId": chatID})
	collector.next(t, "ready")

	if got := daemon.RequestCount(omorpc.CmdOpenSession); got != 1 {
		t.Fatalf("open_session count = %d, want 1; requests = %+v", got, daemon.Requests())
	}
	opened := daemon.LastRequest(omorpc.CmdOpenSession)
	openedPath, _ := opened["sessionPath"].(string)
	if openedPath != stored.SessionFile {
		t.Fatalf("open_session sessionPath = %q, want owned copy %q", openedPath, stored.SessionFile)
	}
	copyInfoBefore, err := os.Stat(openedPath)
	if err != nil {
		t.Fatal(err)
	}

	daemon.SetPromptScript(openedPath,
		map[string]any{"type": omorpctest.EventAgentStart},
		map[string]any{"type": omorpctest.EventMessageDelta, "delta": "owned-copy-turn"},
		map[string]any{"type": omorpctest.EventMessage, "message": map[string]any{"role": "assistant", "content": "owned-copy-turn"}},
		map[string]any{"type": omorpctest.EventAgentSettled, "reason": "end_turn"},
	)
	write(map[string]any{"type": "chat.send", "sessionId": chatID, "run": map[string]any{"kind": "prompt", "message": "write only to the owned copy"}})
	collector.next(t, "run.started")
	done := collector.next(t, "run.done")
	if done["sessionId"] != chatID || done["reason"] != "end_turn" {
		t.Fatalf("completion frame = %+v", done)
	}

	sourceAfter, err := os.ReadFile(source)
	if err != nil {
		t.Fatal(err)
	}
	sourceInfoAfter, err := os.Stat(source)
	if err != nil {
		t.Fatal(err)
	}
	if sourceHashAfter := sha256.Sum256(sourceAfter); sourceHashAfter != sourceHashBefore {
		t.Fatalf("completed turn changed original sha256: before=%x after=%x", sourceHashBefore, sourceHashAfter)
	}
	if !sourceInfoAfter.ModTime().Equal(sourceInfoBefore.ModTime()) {
		t.Fatalf("completed turn changed original mtime: before=%s after=%s", sourceInfoBefore.ModTime(), sourceInfoAfter.ModTime())
	}
	copyInfoAfter, err := os.Stat(openedPath)
	if err != nil {
		t.Fatal(err)
	}
	if copyInfoAfter.Size() <= copyInfoBefore.Size() {
		t.Fatalf("owned copy did not grow during turn: before=%d after=%d", copyInfoBefore.Size(), copyInfoAfter.Size())
	}
}

type adoptionSessionSubscriber struct {
	frames chan session.Frame
}

func (s *adoptionSessionSubscriber) Deliver(frame session.Frame) { s.frames <- frame }
func (s *adoptionSessionSubscriber) Cancel() error               { return nil }
func (s *adoptionSessionSubscriber) await(t *testing.T, kind session.FrameKind) session.Frame {
	t.Helper()
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()
	for {
		select {
		case frame := <-s.frames:
			if frame.Kind == kind {
				return frame
			}
		case <-timer.C:
			t.Fatalf("timed out waiting for session frame %s", kind)
		}
	}
}

type adoptionUnsafeCursorStore struct {
	store *cursorstore.Store
}

func (s adoptionUnsafeCursorStore) CursorForOpen(ctx context.Context, id string) (session.Cursor, error) {
	return s.CursorFor(ctx, id)
}

func (s adoptionUnsafeCursorStore) CursorFor(_ context.Context, id string) (session.Cursor, error) {
	chat, err := s.store.GetChat(id)
	if err != nil {
		return session.Cursor{}, err
	}
	return session.Cursor{SessionFile: chat.SessionFile, DurableSessionID: chat.DurableSessionID, Name: chat.Name, NameSource: chat.NameSource, TitleIsPlaceholder: chat.TitleIsPlaceholder}, nil
}

func (s adoptionUnsafeCursorStore) SaveCursor(_ context.Context, id string, cur session.Cursor) error {
	chat, err := s.store.GetChat(id)
	if err != nil {
		return err
	}
	chat.SessionFile, chat.DurableSessionID = cur.SessionFile, cur.DurableSessionID
	chat.Name, chat.NameSource, chat.TitleIsPlaceholder = cur.Name, cur.NameSource, cur.TitleIsPlaceholder
	return s.store.UpdateChat(chat)
}

func (s adoptionUnsafeCursorStore) UpdateIdentity(_ context.Context, id, path, durableID string) error {
	return s.store.UpdateIdentity(id, path, durableID)
}

func (s adoptionUnsafeCursorStore) UpdateName(_ context.Context, id, name, source string) error {
	return s.store.UpdateName(id, name, source)
}

type adoptionChatRef struct{ chat cursorstore.Chat }

func (r adoptionChatRef) ChatID() string { return r.chat.ID }
func (r adoptionChatRef) CWD() string    { return r.chat.CWD }

func newAdoptionLifecycleHarness(t *testing.T, store *cursorstore.Store) (*session.Manager, *omorpctest.Daemon) {
	t.Helper()
	daemonDir, err := os.MkdirTemp("", "adopt-life-*")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(daemonDir) })
	daemon := omorpctest.New(daemonDir)
	if err := daemon.Start(); err != nil {
		t.Fatal(err)
	}
	client, err := omorpc.Dial(t.Context(), daemon.SocketPath())
	if err != nil {
		daemon.Stop()
		t.Fatal(err)
	}
	manager := session.NewManager(session.Config{Client: client, Store: adoptionUnsafeCursorStore{store: store}})
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = manager.CloseAll(ctx)
		_ = client.Close()
		daemon.Stop()
	})
	return manager, daemon
}

func TestCatalogWhileLegacyRouteLiveMigratesLatestFileOnRestart(t *testing.T) {
	s, st, ws := newChatCreateTestServer(t)
	agentDir := t.TempDir()
	t.Setenv("OMO_CODING_AGENT_DIR", agentDir)
	source := writeAdoptableDiskSession(t, agentDir, ws.Path, "durable-live-restart", "Live legacy")
	chat := cursorstore.Chat{ID: "chat-live-restart", WorkspaceID: ws.ID, CWD: ws.Path, SessionFile: source, DurableSessionID: "durable-live-restart", Name: "live", NameSource: cursorstore.NameSourceAuto}
	if err := st.SaveChat(chat); err != nil {
		t.Fatal(err)
	}

	daemonDir, err := os.MkdirTemp("", "adopt-restart-*")
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
	oldManager := session.NewManager(session.Config{Client: client, Store: adoptionUnsafeCursorStore{store: st.Store}})
	s.manager = oldManager
	sub := &adoptionSessionSubscriber{frames: make(chan session.Frame, 32)}
	live, _, detach, err := oldManager.Acquire(t.Context(), adoptionChatRef{chat: chat}, sub)
	if err != nil {
		t.Fatal(err)
	}
	if live.SessionFile() != source {
		t.Fatalf("live route path = %q, want legacy source %q", live.SessionFile(), source)
	}
	sub.await(t, session.FrameReady)

	listWorkspaceSessions(t, s, ws.ID, "")
	if stored, err := st.GetChat(chat.ID); err != nil || stored.SessionFile != source {
		t.Fatalf("catalog changed live cursor: %+v, %v", stored, err)
	}

	daemon.SetPromptScript(source,
		map[string]any{"type": omorpctest.EventAgentStart},
		map[string]any{"type": omorpctest.EventMessage, "message": map[string]any{"role": "assistant", "content": "turn-after-catalog"}},
		map[string]any{"type": omorpctest.EventAgentSettled, "reason": "end_turn"},
	)
	if err := live.SendPrompt(t.Context(), "after catalog", nil); err != nil {
		t.Fatal(err)
	}
	sub.await(t, session.FrameRunDone)
	detach()
	closeCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	if err := oldManager.CloseAll(closeCtx); err != nil {
		cancel()
		t.Fatal(err)
	}
	cancel()
	if err := client.Close(); err != nil {
		t.Fatal(err)
	}
	daemon.Restart()

	restartedClient, err := omorpc.Dial(t.Context(), daemon.SocketPath())
	if err != nil {
		t.Fatal(err)
	}
	restartedManager := session.NewManager(session.Config{Client: restartedClient, Store: (*wsbridge.CursorStore)(st.Store)})
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = restartedManager.CloseAll(ctx)
		_ = restartedClient.Close()
		daemon.Stop()
	})

	releaseOpen := daemon.BlockHandler(omorpc.CmdOpenSession)
	result := make(chan struct {
		sess *session.Session
		err  error
	}, 1)
	go func() {
		reopened, _, reopenedDetach, acquireErr := restartedManager.Acquire(context.Background(), adoptionChatRef{chat: chat}, nil)
		if reopenedDetach != nil {
			reopenedDetach()
		}
		result <- struct {
			sess *session.Session
			err  error
		}{reopened, acquireErr}
	}()
	if !daemon.AwaitRequestCount(omorpc.CmdOpenSession, 2, 5*time.Second) {
		releaseOpen()
		t.Fatal("restart open did not reach provider")
	}
	stored, err := st.GetChat(chat.ID)
	if err != nil {
		releaseOpen()
		t.Fatal(err)
	}
	if stored.SessionFile == source || !cursorstore.IsOwnedSession(stored, st.OwnedSessionDir()) {
		releaseOpen()
		t.Fatalf("restart did not migrate legacy route: %+v", stored)
	}
	if err := daemon.LoadSessionFile(stored.SessionFile); err != nil {
		releaseOpen()
		t.Fatal(err)
	}
	releaseOpen()
	var reopened struct {
		sess *session.Session
		err  error
	}
	select {
	case reopened = <-result:
	case <-time.After(5 * time.Second):
		t.Fatal("restart acquire did not complete")
	}
	if reopened.err != nil {
		t.Fatal(reopened.err)
	}
	if reopened.sess.SessionFile() != stored.SessionFile {
		t.Fatalf("restart route path = %q, stored path = %q", reopened.sess.SessionFile(), stored.SessionFile)
	}
	copied, err := os.ReadFile(stored.SessionFile)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(copied, []byte("turn-after-catalog")) {
		t.Fatal("migrated restart file lost the turn completed after catalog GET")
	}
}

func TestAdoptWorkspaceSessionStopsLiveOriginalBeforeInstallingCopy(t *testing.T) {
	s, st, ws := newChatCreateTestServer(t)
	agentDir := t.TempDir()
	t.Setenv("OMO_CODING_AGENT_DIR", agentDir)
	source := writeAdoptableDiskSession(t, agentDir, ws.Path, "durable-live", "")
	chat := cursorstore.Chat{ID: "chat-live", WorkspaceID: ws.ID, CWD: ws.Path, SessionFile: source, Name: "live", NameSource: cursorstore.NameSourceAuto}
	if err := st.SaveChat(chat); err != nil {
		t.Fatal(err)
	}
	manager, daemon := newAdoptionLifecycleHarness(t, st.Store)
	s.manager = manager
	_, _, detach, err := manager.Acquire(t.Context(), adoptionChatRef{chat: chat}, nil)
	if err != nil {
		t.Fatal(err)
	}
	detach()

	response := adoptWorkspaceSession(t, s, ws.ID, map[string]string{"id": "durable-live", "resumeIdentity": source})
	if response.Code != http.StatusOK {
		t.Fatalf("status %d: %s", response.Code, response.Body.String())
	}
	if _, live := manager.Get(chat.ID); live {
		t.Fatal("original route remained live after adoption")
	}
	if got := daemon.RequestCount(omorpc.CmdCloseSession); got != 1 {
		t.Fatalf("close requests = %d, want 1", got)
	}
	stored, err := st.GetChat(chat.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.SessionFile == source || !cursorstore.IsOwnedSession(stored, st.OwnedSessionDir()) {
		t.Fatalf("stored identity was not replaced with owned copy: %+v", stored)
	}
}

func TestAdoptWorkspaceSessionSerializesWithInflightOriginalOpen(t *testing.T) {
	s, st, ws := newChatCreateTestServer(t)
	agentDir := t.TempDir()
	t.Setenv("OMO_CODING_AGENT_DIR", agentDir)
	source := writeAdoptableDiskSession(t, agentDir, ws.Path, "durable-race", "")
	chat := cursorstore.Chat{ID: "chat-race", WorkspaceID: ws.ID, CWD: ws.Path, SessionFile: source, Name: "race", NameSource: cursorstore.NameSourceAuto}
	if err := st.SaveChat(chat); err != nil {
		t.Fatal(err)
	}
	manager, daemon := newAdoptionLifecycleHarness(t, st.Store)
	s.manager = manager
	releaseOpen := daemon.BlockHandler(omorpc.CmdOpenSession)
	released := false
	defer func() {
		if !released {
			releaseOpen()
		}
	}()
	preparedGeneration := s.chatLifecycleVersion(chat.ID)
	openDone := make(chan error, 1)
	go func() {
		_, _, detach, err := manager.AcquireInitializedChecked(context.Background(), adoptionChatRef{chat: chat}, nil, nil, func() error {
			if s.chatLifecycleVersion(chat.ID) != preparedGeneration {
				return wsbridge.ErrChatDeleted
			}
			return nil
		})
		if detach != nil {
			detach()
		}
		openDone <- err
	}()
	if !daemon.AwaitRequestCount(omorpc.CmdOpenSession, 1, 5*time.Second) {
		t.Fatal("open_session did not enter provider")
	}

	invalidated := make(chan struct{}, 1)
	originalHook := afterAdoptionInvalidated
	defer func() { afterAdoptionInvalidated = originalHook }()
	afterAdoptionInvalidated = func(id string) {
		if id == chat.ID {
			invalidated <- struct{}{}
		}
	}
	adoptDone := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		adoptDone <- adoptWorkspaceSession(t, s, ws.ID, map[string]string{"id": "durable-race", "resumeIdentity": source})
	}()
	select {
	case <-invalidated:
	case <-time.After(5 * time.Second):
		t.Fatal("adoption did not invalidate the in-flight open")
	}
	releaseOpen()
	released = true
	if err := <-openDone; !errors.Is(err, wsbridge.ErrChatDeleted) {
		t.Fatalf("racing open error = %v, want lifecycle invalidation", err)
	}
	response := <-adoptDone
	if response.Code != http.StatusOK {
		t.Fatalf("status %d: %s", response.Code, response.Body.String())
	}
	if _, live := manager.Get(chat.ID); live {
		t.Fatal("route published by racing open survived adoption")
	}
	stored, err := st.GetChat(chat.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.SessionFile == source || !cursorstore.IsOwnedSession(stored, st.OwnedSessionDir()) {
		t.Fatalf("racing adoption stored unsafe identity: %+v", stored)
	}
}

func TestAdoptWorkspaceSessionCreatesOwnedChatWithoutTouchingOriginal(t *testing.T) {
	s, st, ws := newChatCreateTestServer(t)
	agentDir := t.TempDir()
	t.Setenv("OMO_CODING_AGENT_DIR", agentDir)
	source := writeAdoptableDiskSession(t, agentDir, ws.Path, "durable-1", "Source title")
	beforeBytes, err := os.ReadFile(source)
	if err != nil {
		t.Fatal(err)
	}
	beforeInfo, err := os.Stat(source)
	if err != nil {
		t.Fatal(err)
	}
	beforeHash := sha256.Sum256(beforeBytes)

	response := adoptWorkspaceSession(t, s, ws.ID, map[string]string{
		"id": "durable-1", "name": "Source title", "resumeIdentity": source,
	})
	if response.Code != http.StatusCreated {
		t.Fatalf("status %d: %s", response.Code, response.Body.String())
	}
	var projected chatResponse
	if err := json.NewDecoder(response.Body).Decode(&projected); err != nil {
		t.Fatal(err)
	}
	chat, err := st.GetChat(projected.ID)
	if err != nil {
		t.Fatal(err)
	}
	if chat.DurableSessionID != "durable-1" {
		t.Fatalf("durable id = %q", chat.DurableSessionID)
	}
	if filepath.Dir(chat.SessionFile) != filepath.Join(st.StateDir(), "adopted") || chat.SessionFile == source {
		t.Fatalf("session file = %q, want owned adopted copy", chat.SessionFile)
	}
	copyBytes, err := os.ReadFile(chat.SessionFile)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(copyBytes, beforeBytes) {
		t.Fatal("owned copy differs from original")
	}
	afterBytes, err := os.ReadFile(source)
	if err != nil {
		t.Fatal(err)
	}
	afterInfo, err := os.Stat(source)
	if err != nil {
		t.Fatal(err)
	}
	if sha256.Sum256(afterBytes) != beforeHash || !afterInfo.ModTime().Equal(beforeInfo.ModTime()) {
		t.Fatal("adoption changed original hash or mtime")
	}
}

func TestAdoptWorkspaceSessionCreatesChatWithCompleteIdentityInOneSave(t *testing.T) {
	s, _, ws := newChatCreateTestServer(t)
	agentDir := t.TempDir()
	t.Setenv("OMO_CODING_AGENT_DIR", agentDir)
	source := writeAdoptableDiskSession(t, agentDir, ws.Path, "durable-atomic", "")

	originalSave := saveAdoptedChat
	defer func() { saveAdoptedChat = originalSave }()
	calls := 0
	saveAdoptedChat = func(store *cursorstore.Store, chat cursorstore.Chat) error {
		calls++
		if chat.SessionFile == "" || chat.DurableSessionID != "durable-atomic" || !cursorstore.IsOwnedSession(chat, store.OwnedSessionDir()) {
			t.Fatalf("incomplete adopted chat reached save: %+v", chat)
		}
		if _, err := store.GetChat(chat.ID); !errors.Is(err, cursorstore.ErrNotFound) {
			t.Fatalf("chat was visible before complete save: %v", err)
		}
		return store.SaveChat(chat)
	}

	response := adoptWorkspaceSession(t, s, ws.ID, map[string]string{"id": "durable-atomic", "resumeIdentity": source})
	if response.Code != http.StatusCreated {
		t.Fatalf("status %d: %s", response.Code, response.Body.String())
	}
	if calls != 1 {
		t.Fatalf("chat saves = %d, want 1", calls)
	}
}

func TestAdoptWorkspaceSessionIsIdempotentAndCatalogMarksSource(t *testing.T) {
	s, st, ws := newChatCreateTestServer(t)
	agentDir := t.TempDir()
	t.Setenv("OMO_CODING_AGENT_DIR", agentDir)
	source := writeAdoptableDiskSession(t, agentDir, ws.Path, "durable-2", "Adopt once")
	body := map[string]string{"id": "durable-2", "resumeIdentity": source}

	first := adoptWorkspaceSession(t, s, ws.ID, body)
	if first.Code != http.StatusCreated {
		t.Fatalf("first status = %d, body = %s", first.Code, first.Body.String())
	}
	firstStored := st.ListChats(ws.ID)[0]
	copyFile, err := os.OpenFile(firstStored.SessionFile, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := copyFile.WriteString("{\"type\":\"message\",\"id\":\"webchat-turn\"}\n"); err != nil {
		_ = copyFile.Close()
		t.Fatal(err)
	}
	if err := copyFile.Close(); err != nil {
		t.Fatal(err)
	}
	second := adoptWorkspaceSession(t, s, ws.ID, body)
	if first.Code != http.StatusCreated || second.Code != http.StatusOK {
		t.Fatalf("statuses = %d, %d; bodies = %s / %s", first.Code, second.Code, first.Body.String(), second.Body.String())
	}
	var firstChat, secondChat chatResponse
	if err := json.NewDecoder(first.Body).Decode(&firstChat); err != nil {
		t.Fatal(err)
	}
	if err := json.NewDecoder(second.Body).Decode(&secondChat); err != nil {
		t.Fatal(err)
	}
	if firstChat.ID != secondChat.ID || len(st.ListChats(ws.ID)) != 1 {
		t.Fatalf("chat ids = %q, %q; chats = %+v", firstChat.ID, secondChat.ID, st.ListChats(ws.ID))
	}
	entries, err := os.ReadDir(filepath.Join(st.StateDir(), "adopted"))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("adopted entries = %v", entries)
	}

	page := listWorkspaceSessions(t, s, ws.ID, "")
	var stored, sourceRow *sessionHistoryItem
	for i := range page.Items {
		switch page.Items[i].Source {
		case sessionHistorySourceStored:
			stored = &page.Items[i]
		case sessionHistorySourceAlreadyAdopted:
			sourceRow = &page.Items[i]
		}
	}
	if stored == nil || stored.Dangling || sourceRow == nil || sourceRow.ID != "durable-2" || sourceRow.ResumeIdentity != source {
		t.Fatalf("catalog = %+v", page.Items)
	}

	chat, err := st.GetChat(firstChat.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(chat.SessionFile); err != nil {
		t.Fatal(err)
	}
	page = listWorkspaceSessions(t, s, ws.ID, "")
	for _, item := range page.Items {
		if item.Source == sessionHistorySourceStored && item.ID == chat.ID && !item.Dangling {
			t.Fatalf("missing adopted copy was not marked dangling: %+v", item)
		}
	}
}

func TestConcurrentWorkspaceSessionAdoptionsCreateOneChat(t *testing.T) {
	s, st, ws := newChatCreateTestServer(t)
	agentDir := t.TempDir()
	t.Setenv("OMO_CODING_AGENT_DIR", agentDir)
	source := writeAdoptableDiskSession(t, agentDir, ws.Path, "durable-concurrent", "")

	const workers = 8
	start := make(chan struct{})
	responses := make(chan *httptest.ResponseRecorder, workers)
	for i := 0; i < workers; i++ {
		go func() {
			<-start
			responses <- adoptWorkspaceSession(t, s, ws.ID, map[string]string{"resumeIdentity": source})
		}()
	}
	close(start)

	ids := make(map[string]bool)
	created := 0
	for i := 0; i < workers; i++ {
		response := <-responses
		if response.Code == http.StatusCreated {
			created++
		} else if response.Code != http.StatusOK {
			t.Fatalf("status %d: %s", response.Code, response.Body.String())
		}
		var chat chatResponse
		if err := json.NewDecoder(response.Body).Decode(&chat); err != nil {
			t.Fatal(err)
		}
		ids[chat.ID] = true
	}
	if created != 1 || len(ids) != 1 || len(st.ListChats(ws.ID)) != 1 {
		t.Fatalf("created=%d ids=%v chats=%+v", created, ids, st.ListChats(ws.ID))
	}
	entries, err := os.ReadDir(filepath.Join(st.StateDir(), "adopted"))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("adopted entries = %v", entries)
	}
}

func TestAdoptWorkspaceSessionSourceFailuresHaveTyped4xxCodes(t *testing.T) {
	tests := []struct {
		name       string
		mutate     func(*testing.T, string)
		wantStatus int
		wantCode   adoptcopy.Kind
	}{
		{
			name: "oversized",
			mutate: func(t *testing.T, path string) {
				if err := os.Truncate(path, adoptcopy.MaxSourceBytes+1); err != nil {
					t.Fatal(err)
				}
			},
			wantStatus: http.StatusRequestEntityTooLarge,
			wantCode:   adoptcopy.KindTooLarge,
		},
		{
			name: "torn complete record",
			mutate: func(t *testing.T, path string) {
				file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
				if err != nil {
					t.Fatal(err)
				}
				if _, err := file.WriteString("{\"type\":\"message\",\"id\":\"torn\"\n"); err != nil {
					file.Close()
					t.Fatal(err)
				}
				if err := file.Close(); err != nil {
					t.Fatal(err)
				}
			},
			wantStatus: http.StatusUnprocessableEntity,
			wantCode:   adoptcopy.KindInvalidSource,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s, _, ws := newChatCreateTestServer(t)
			agentDir := t.TempDir()
			t.Setenv("OMO_CODING_AGENT_DIR", agentDir)
			source := writeAdoptableDiskSession(t, agentDir, ws.Path, "durable-error", "")
			tt.mutate(t, source)

			response := adoptWorkspaceSession(t, s, ws.ID, map[string]string{"resumeIdentity": source})
			if response.Code != tt.wantStatus {
				t.Fatalf("status %d: %s", response.Code, response.Body.String())
			}
			var payload adoptionErrorResponse
			if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
				t.Fatal(err)
			}
			if payload.Code != tt.wantCode {
				t.Fatalf("code = %q, want %q", payload.Code, tt.wantCode)
			}
		})
	}
}

func TestAdoptedChatRemainsUsableWhenSourceDisappears(t *testing.T) {
	s, st, ws := newChatCreateTestServer(t)
	agentDir := t.TempDir()
	t.Setenv("OMO_CODING_AGENT_DIR", agentDir)
	source := writeAdoptableDiskSession(t, agentDir, ws.Path, "durable-3", "")
	response := adoptWorkspaceSession(t, s, ws.ID, map[string]string{"id": "durable-3"})
	if response.Code != http.StatusCreated {
		t.Fatalf("status %d: %s", response.Code, response.Body.String())
	}
	chat := st.ListChats(ws.ID)[0]
	if err := os.Remove(source); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(chat.SessionFile); err != nil {
		t.Fatalf("owned copy disappeared with source: %v", err)
	}
	page := listWorkspaceSessions(t, s, ws.ID, "")
	if len(page.Items) != 1 || page.Items[0].ID != chat.ID || page.Items[0].Dangling {
		t.Fatalf("catalog after source removal = %+v", page.Items)
	}
}
