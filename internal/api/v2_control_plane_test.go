package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
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

	"github.com/DevNewbie1826/omo-webchat/internal/auth"
	"github.com/DevNewbie1826/omo-webchat/internal/config"
	"github.com/DevNewbie1826/omo-webchat/internal/cursorstore"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc/omorpctest"
	v2session "github.com/DevNewbie1826/omo-webchat/internal/session"
	"github.com/DevNewbie1826/omo-webchat/internal/store"
	"github.com/DevNewbie1826/omo-webchat/internal/wsbridge"
)

type v2ControlEnv struct {
	server  *Server
	manager *v2session.Manager
	cursors *cursorstore.Store
	daemon  *omorpctest.Daemon
	client  *omorpc.Client
	wsID    string
	chatID  string
}

type v2ControlRef struct{ id, cwd string }

type v2StopControl struct {
	ctx    context.Context
	cancel context.CancelFunc
}

type blockingV2PrepareStore struct {
	store        *cursorstore.Store
	saveStarted  chan struct{}
	continueSave chan struct{}
}

func (s *blockingV2PrepareStore) SaveWorkspace(workspace cursorstore.Workspace) error {
	close(s.saveStarted)
	<-s.continueSave
	return s.store.SaveWorkspace(workspace)
}

func (s *blockingV2PrepareStore) GetChat(chatID string) (cursorstore.Chat, error) {
	return s.store.GetChat(chatID)
}

func (s *blockingV2PrepareStore) SaveChat(chat cursorstore.Chat) error {
	return s.store.SaveChat(chat)
}

func receiveV2Control[T any](t *testing.T, ch <-chan T, event string) T {
	t.Helper()
	select {
	case value := <-ch:
		return value
	case <-time.After(3 * time.Second):
		t.Fatalf("timed out waiting for %s", event)
		var zero T
		return zero
	}
}

func (r v2ControlRef) ChatID() string { return r.id }
func (r v2ControlRef) CWD() string    { return r.cwd }

func newV2ControlEnv(t *testing.T) *v2ControlEnv {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	st, err := store.Load(t.Context(), logger)
	if err != nil {
		t.Fatal(err)
	}
	workspace, err := st.CreateWorkspace("workspace", dir)
	if err != nil {
		t.Fatal(err)
	}
	chat, err := st.NewChat(workspace.ID, "chat", dir, "", "omo")
	if err != nil {
		t.Fatal(err)
	}
	cursors, err := cursorstore.Open(filepath.Join(dir, "v2.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := cursors.SaveWorkspace(cursorstore.Workspace{ID: workspace.ID, Name: workspace.Name, Path: workspace.Path}); err != nil {
		t.Fatal(err)
	}
	if err := cursors.SaveChat(cursorstore.Chat{ID: chat.ID, WorkspaceID: workspace.ID, CWD: dir, Name: chat.Name, NameSource: cursorstore.NameSourceAuto}); err != nil {
		t.Fatal(err)
	}
	daemonDir, err := os.MkdirTemp("", "v2api-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(daemonDir) })
	d := omorpctest.New(daemonDir)
	if err := d.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(d.Stop)
	client, err := omorpc.Dial(t.Context(), d.SocketPath())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close() })
	manager := v2session.NewManager(v2session.Config{Client: client, Store: (*wsbridge.CursorStore)(cursors)})
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = manager.CloseAll(ctx)
	})
	if _, _, _, err := manager.Acquire(t.Context(), v2ControlRef{chat.ID, dir}, nil); err != nil {
		t.Fatal(err)
	}
	server := New(t.Context(), &config.Config{Root: dir}, st, auth.NewSessionStore(t.Context(), "pw", logger), logger)
	server.installV2(manager, cursors, http.NotFoundHandler())
	return &v2ControlEnv{server: server, manager: manager, cursors: cursors, daemon: d, client: client, wsID: workspace.ID, chatID: chat.ID}
}

func TestDeleteChatCanceledRequestDoesNotDiscardLiveV2State(t *testing.T) {
	e := newV2ControlEnv(t)
	releaseFlight, err := e.manager.EnterChat(context.Background(), e.chatID)
	if err != nil {
		t.Fatal(err)
	}
	defer releaseFlight()

	stopContextReady := make(chan v2StopControl, 1)
	originalStopContext := newChatStopContext
	newChatStopContext = func(parent context.Context, _ time.Duration) (context.Context, context.CancelFunc) {
		ctx, cancel := context.WithCancel(parent)
		stopContextReady <- v2StopControl{ctx: ctx, cancel: cancel}
		return ctx, cancel
	}
	t.Cleanup(func() { newChatStopContext = originalStopContext })
	requestCtx, cancelRequest := context.WithCancel(context.Background())
	req := httptest.NewRequest(http.MethodDelete, "/", nil).WithContext(requestCtx)
	req.SetPathValue("wsId", e.wsID)
	req.SetPathValue("chatId", e.chatID)
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		rec := httptest.NewRecorder()
		e.server.handleDeleteChat(rec, req)
		done <- rec
	}()

	stopControl := receiveV2Control(t, stopContextReady, "delete stop context")
	cancelRequest()
	if err := stopControl.ctx.Err(); err != nil {
		t.Fatalf("request cancellation reached lifecycle stop context: %v", err)
	}
	stopControl.cancel()
	rec := receiveV2Control(t, done, "failed delete response")
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("delete status=%d, want %d: %s", rec.Code, http.StatusInternalServerError, rec.Body.String())
	}
	if _, err := e.server.store.GetChat(e.wsID, e.chatID); err != nil {
		t.Fatalf("v1 chat removed after failed stop: %v", err)
	}
	if _, err := e.cursors.GetChat(e.chatID); err != nil {
		t.Fatalf("v2 cursor removed after failed stop: %v", err)
	}
	if _, active := e.manager.Get(e.chatID); !active {
		t.Fatal("v2 session disappeared after failed stop")
	}
}

func TestDeleteChatRetriesProviderCloseAfterTimeout(t *testing.T) {
	e := newV2ControlEnv(t)
	releaseClose := e.daemon.BlockHandler(omorpc.CmdCloseSession)
	defer releaseClose()

	stopContextReady := make(chan context.CancelFunc, 1)
	originalStopContext := newChatStopContext
	newChatStopContext = func(parent context.Context, _ time.Duration) (context.Context, context.CancelFunc) {
		ctx, cancel := context.WithCancel(parent)
		stopContextReady <- cancel
		return ctx, cancel
	}
	t.Cleanup(func() { newChatStopContext = originalStopContext })

	firstDone := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		req := httptest.NewRequest(http.MethodDelete, "/", nil)
		req.SetPathValue("wsId", e.wsID)
		req.SetPathValue("chatId", e.chatID)
		rec := httptest.NewRecorder()
		e.server.handleDeleteChat(rec, req)
		firstDone <- rec
	}()
	cancelStop := receiveV2Control(t, stopContextReady, "delete stop context")
	if !e.daemon.AwaitRequestCount(omorpc.CmdCloseSession, 1, time.Second) {
		t.Fatal("daemon never saw first close_session")
	}
	cancelStop()
	if rec := receiveV2Control(t, firstDone, "timed-out delete"); rec.Code != http.StatusInternalServerError {
		t.Fatalf("first delete status=%d, want 500: %s", rec.Code, rec.Body.String())
	}
	if _, active := e.manager.Get(e.chatID); !active {
		t.Fatal("non-definitive close removed the retryable manager session")
	}
	if _, err := e.cursors.GetChat(e.chatID); err != nil {
		t.Fatalf("timeout removed cursor metadata: %v", err)
	}

	releaseClose()
	retry := httptest.NewRequest(http.MethodDelete, "/", nil)
	retry.SetPathValue("wsId", e.wsID)
	retry.SetPathValue("chatId", e.chatID)
	retryRec := httptest.NewRecorder()
	e.server.handleDeleteChat(retryRec, retry)
	if retryRec.Code != http.StatusNoContent {
		t.Fatalf("retry delete status=%d, want 204: %s", retryRec.Code, retryRec.Body.String())
	}
	if got := e.daemon.RequestCount(omorpc.CmdCloseSession); got != 2 {
		t.Fatalf("close_session requests=%d, want retry count 2", got)
	}
	if live := e.daemon.LiveSessions(); len(live) != 0 {
		t.Fatalf("provider sessions orphaned after retry: %v", live)
	}
	if _, active := e.manager.Get(e.chatID); active {
		t.Fatal("manager retained session after definitive retry")
	}
}

func TestDeleteChatRetriesGenerationMismatchRetiringRoute(t *testing.T) {
	e := newV2ControlEnv(t)
	if err := e.manager.StopContext(context.Background(), e.chatID); err != nil {
		t.Fatal(err)
	}
	baseline := e.daemon.RequestCount(omorpc.CmdCloseSession)
	manager := v2session.NewManager(v2session.Config{Client: e.client, Store: (*wsbridge.CursorStore)(e.cursors), CloseTimeout: 30 * time.Millisecond})
	t.Cleanup(func() { _ = manager.CloseAll(context.Background()) })
	e.server.installV2(manager, e.cursors, http.NotFoundHandler())

	releaseClose := e.daemon.BlockHandler(omorpc.CmdCloseSession)
	defer releaseClose()
	generationMismatch := errors.New("generation mismatch")
	validationCalls := 0
	_, _, _, err := manager.AcquireInitializedChecked(context.Background(), v2ControlRef{e.chatID, t.TempDir()}, nil, nil, func() error {
		validationCalls++
		if validationCalls > 1 {
			return generationMismatch
		}
		return nil
	})
	if !errors.Is(err, generationMismatch) {
		t.Fatalf("checked acquire = %v, want generation mismatch", err)
	}

	deleted := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		req := httptest.NewRequest(http.MethodDelete, "/", nil)
		req.SetPathValue("wsId", e.wsID)
		req.SetPathValue("chatId", e.chatID)
		rec := httptest.NewRecorder()
		e.server.handleDeleteChat(rec, req)
		deleted <- rec
	}()
	if !e.daemon.AwaitRequestCount(omorpc.CmdCloseSession, baseline+2, time.Second) {
		t.Fatal("DELETE did not retry generation-mismatch retiring route")
	}
	releaseClose()
	if rec := receiveV2Control(t, deleted, "retiring-route delete"); rec.Code != http.StatusNoContent {
		t.Fatalf("delete status=%d, want 204: %s", rec.Code, rec.Body.String())
	}
	if live := e.daemon.LiveSessions(); len(live) != 0 {
		t.Fatalf("provider route orphaned after DELETE: %v", live)
	}
	if _, live := manager.Get(e.chatID); live {
		t.Fatal("generation-mismatched route appeared in manager live sessions")
	}
}

func TestDeleteChatRejectsBridgePublicationPreparedBeforeDelete(t *testing.T) {
	e := newV2ControlEnv(t)
	prepared := make(chan struct{})
	continuePrepare := make(chan struct{})
	stopped := make(chan struct{})
	continueDelete := make(chan struct{})
	e.server.afterV2ChatStop = func() {
		close(stopped)
		<-continueDelete
	}
	prepareVersion := func(_ context.Context, wsID, chatID string) (uint64, error) {
		generation, err := e.server.prepareV2ChatVersion(e.cursors, wsID, chatID)
		close(prepared)
		<-continuePrepare
		return generation, err
	}
	preparedChatVersion := e.server.chatLifecycleVersion(e.chatID)
	versionChecks := 0
	chatVersion := func(chatID string) uint64 {
		versionChecks++
		if versionChecks == 1 {
			return preparedChatVersion
		}
		return e.server.chatLifecycleVersion(chatID)
	}
	bridge := wsbridge.New(wsbridge.Config{
		Context: t.Context(), Manager: e.manager, Store: e.cursors,
		ServerVersion: "test", Logger: e.server.logger,
		PrepareChatVersion: prepareVersion, ChatVersion: chatVersion,
	})
	httpServer := httptest.NewServer(bridge)
	defer httpServer.Close()
	frames := &frameCollector{notify: make(chan struct{}, 64)}
	client, _, err := gws.NewClient(frames, &gws.ClientOption{Addr: "ws" + strings.TrimPrefix(httpServer.URL, "http")})
	if err != nil {
		t.Fatal(err)
	}
	defer client.WriteClose(1000, nil)
	go client.ReadLoop()
	frames.waitFor(t, "hello", time.Second)
	writeFrame(t, client, map[string]any{"type": "hello", "version": 2})

	releaseState := e.daemon.BlockHandler(omorpc.CmdGetState)
	defer releaseState()
	writeFrame(t, client, map[string]any{"type": "chat.create", "wsId": e.wsID, "chatId": e.chatID})
	receiveV2Control(t, prepared, "versioned chat prepare")

	deleted := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		req := httptest.NewRequest(http.MethodDelete, "/", nil)
		req.SetPathValue("wsId", e.wsID)
		req.SetPathValue("chatId", e.chatID)
		rec := httptest.NewRecorder()
		e.server.handleDeleteChat(rec, req)
		deleted <- rec
	}()
	receiveV2Control(t, stopped, "provider stop before metadata flush")
	close(continuePrepare)
	if !e.daemon.AwaitRequestCount(omorpc.CmdGetState, 1, time.Second) {
		t.Fatal("bridge initialization did not reach blocked get_state")
	}
	close(continueDelete)
	if rec := receiveV2Control(t, deleted, "delete completion"); rec.Code != http.StatusNoContent {
		t.Fatalf("delete status=%d, want 204: %s", rec.Code, rec.Body.String())
	}
	if _, active := e.manager.Get(e.chatID); active {
		t.Fatal("unvalidated route was published while initialization was blocked")
	}

	releaseState()
	frames.waitFor(t, "error", 3*time.Second)
	var deletionError map[string]any
	for _, raw := range frames.snapshot() {
		var frame map[string]any
		if json.Unmarshal(raw, &frame) == nil && frame["type"] == "error" && frame["code"] == "chat_deleted" {
			deletionError = frame
		}
	}
	if deletionError == nil {
		t.Fatalf("socket did not receive typed chat_deleted error; frames: %s", frames.types())
	}
	if _, active := e.manager.Get(e.chatID); active {
		t.Fatal("stale bridge create published a live session after delete")
	}
	if _, err := e.cursors.GetChat(e.chatID); !errors.Is(err, cursorstore.ErrNotFound) {
		t.Fatalf("cursor survived delete/create race: %v", err)
	}
	if live := e.daemon.LiveSessions(); len(live) != 0 {
		t.Fatalf("provider route orphaned by rejected create: %v", live)
	}
}

func TestDeleteChatAndPrepareV2ChatAreLinearized(t *testing.T) {
	e := newV2ControlEnv(t)
	prepareRead := make(chan struct{})
	continuePrepare := make(chan struct{})
	deleteStarted := make(chan struct{})
	e.server.beforeChatDelete = func() { close(deleteStarted) }
	prepareStore := &blockingV2PrepareStore{store: e.cursors, saveStarted: prepareRead, continueSave: continuePrepare}

	prepared := make(chan error, 1)
	go func() { prepared <- e.server.prepareV2Chat(prepareStore, e.wsID, e.chatID) }()
	receiveV2Control(t, prepareRead, "prepare metadata read")
	deleted := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		req := httptest.NewRequest(http.MethodDelete, "/", nil)
		req.SetPathValue("wsId", e.wsID)
		req.SetPathValue("chatId", e.chatID)
		rec := httptest.NewRecorder()
		e.server.handleDeleteChat(rec, req)
		deleted <- rec
	}()
	receiveV2Control(t, deleteStarted, "concurrent delete start")
	close(continuePrepare)
	if err := receiveV2Control(t, prepared, "prepare completion"); err != nil {
		t.Fatalf("prepare v2 chat: %v", err)
	}
	if rec := receiveV2Control(t, deleted, "delete completion"); rec.Code != http.StatusNoContent {
		t.Fatalf("delete status=%d: %s", rec.Code, rec.Body.String())
	}

	if _, err := e.server.store.GetChat(e.wsID, e.chatID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("v1 chat lookup after race = %v, want not found", err)
	}
	if _, err := e.cursors.GetChat(e.chatID); !errors.Is(err, cursorstore.ErrNotFound) {
		t.Fatalf("v2 cursor was stale-republished after delete: %v", err)
	}
	if _, active := e.manager.Get(e.chatID); active {
		t.Fatal("v2 session remains active after delete won lifecycle race")
	}
}

func TestV2ControlPlaneRoutes(t *testing.T) {
	t.Run("live listing", func(t *testing.T) {
		e := newV2ControlEnv(t)
		rec := httptest.NewRecorder()
		e.server.handleListLiveSessions(rec, httptest.NewRequest(http.MethodGet, "/api/sessions/live", nil))
		var body liveSessionsResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if len(body.Sessions) != 1 || body.Sessions[0].ID != e.chatID || body.Sessions[0].Title != "chat" {
			t.Fatalf("v2 live sessions = %+v", body.Sessions)
		}
	})

	t.Run("rename", func(t *testing.T) {
		e := newV2ControlEnv(t)
		req := httptest.NewRequest(http.MethodPatch, "/", bytes.NewBufferString(`{"name":"renamed"}`))
		req.SetPathValue("wsId", e.wsID)
		req.SetPathValue("chatId", e.chatID)
		rec := httptest.NewRecorder()
		e.server.handleRenameChat(rec, req)
		if rec.Code != http.StatusOK || !e.daemon.AwaitRequestCount(omorpc.CmdSetSessionName, 1, time.Second) {
			t.Fatalf("rename status=%d provider requests=%d", rec.Code, e.daemon.RequestCount(omorpc.CmdSetSessionName))
		}
		chat, err := e.cursors.GetChat(e.chatID)
		if err != nil || chat.Name != "renamed" || chat.NameSource != cursorstore.NameSourceUser {
			t.Fatalf("v2 cursor after rename = %+v, %v", chat, err)
		}
	})

	t.Run("chat delete", func(t *testing.T) {
		e := newV2ControlEnv(t)
		req := httptest.NewRequest(http.MethodDelete, "/", nil)
		req.SetPathValue("wsId", e.wsID)
		req.SetPathValue("chatId", e.chatID)
		rec := httptest.NewRecorder()
		e.server.handleDeleteChat(rec, req)
		if rec.Code != http.StatusNoContent {
			t.Fatalf("delete status=%d: %s", rec.Code, rec.Body.String())
		}
		if _, active := e.manager.Get(e.chatID); active {
			t.Fatal("v2 session remains active")
		}
		if _, err := e.cursors.GetChat(e.chatID); !errors.Is(err, cursorstore.ErrNotFound) {
			t.Fatalf("v2 cursor lookup after delete = %v", err)
		}
	})

	t.Run("workspace delete", func(t *testing.T) {
		e := newV2ControlEnv(t)
		req := httptest.NewRequest(http.MethodDelete, "/", nil)
		req.SetPathValue("wsId", e.wsID)
		rec := httptest.NewRecorder()
		e.server.handleDeleteWorkspace(rec, req)
		if rec.Code != http.StatusNoContent {
			t.Fatalf("delete status=%d: %s", rec.Code, rec.Body.String())
		}
		if _, active := e.manager.Get(e.chatID); active {
			t.Fatal("workspace delete left v2 session active")
		}
		if len(e.cursors.ListWorkspaces()) != 0 {
			t.Fatalf("v2 workspaces remain: %+v", e.cursors.ListWorkspaces())
		}
	})
}
