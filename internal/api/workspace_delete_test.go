package api

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/auth"
	"github.com/DevNewbie1826/omo-webchat/internal/config"
	"github.com/DevNewbie1826/omo-webchat/internal/cursorstore"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc/omorpctest"
	"github.com/DevNewbie1826/omo-webchat/internal/session"
	"github.com/DevNewbie1826/omo-webchat/internal/wsbridge"
)

const workspaceDeleteTestTimeout = 5 * time.Second

type workspaceDeleteChatRef struct {
	id  string
	cwd string
}

func (c workspaceDeleteChatRef) ChatID() string { return c.id }
func (c workspaceDeleteChatRef) CWD() string    { return c.cwd }

type workspaceDeleteHarness struct {
	server  *Server
	store   *cursorstore.Store
	manager *session.Manager
	daemon  *omorpctest.Daemon
	ws      cursorstore.Workspace
	chats   []cursorstore.Chat
}

func newWorkspaceDeleteHarness(t *testing.T, count int) *workspaceDeleteHarness {
	t.Helper()
	dir, err := os.MkdirTemp("", "api-ws-delete-*")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	d := omorpctest.New(dir)
	if err := d.Start(); err != nil {
		t.Fatal(err)
	}
	client, err := omorpc.Dial(context.Background(), d.SocketPath())
	if err != nil {
		t.Fatal(err)
	}
	store, err := cursorstore.Open(filepath.Join(dir, "state-v2.json"))
	if err != nil {
		t.Fatal(err)
	}
	ws := cursorstore.Workspace{ID: "ws-delete", Name: "delete", Path: dir}
	if err := store.SaveWorkspace(ws); err != nil {
		t.Fatal(err)
	}
	manager := session.NewManager(session.Config{Client: client, Store: (*wsbridge.CursorStore)(store)})
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	server := New(context.Background(), &config.Config{Root: dir}, store, auth.NewSessionStore(t.Context(), "pw", logger), manager, wsbridge.Unavailable("test"), logger)
	h := &workspaceDeleteHarness{server: server, store: store, manager: manager, daemon: d, ws: ws}
	for i := 0; i < count; i++ {
		chat := cursorstore.Chat{ID: "chat-" + itoa(i+1), WorkspaceID: ws.ID, CWD: dir, Name: "chat", CreatedAt: int64(i + 1)}
		if err := store.SaveChat(chat); err != nil {
			t.Fatal(err)
		}
		if _, _, detach, err := manager.Acquire(context.Background(), workspaceDeleteChatRef{id: chat.ID, cwd: chat.CWD}, nil); err != nil {
			t.Fatal(err)
		} else {
			detach()
		}
		h.chats = append(h.chats, chat)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), workspaceDeleteTestTimeout)
		defer cancel()
		_ = manager.CloseAll(ctx)
		_ = client.Close()
		d.Stop()
	})
	return h
}

func (h *workspaceDeleteHarness) delete(ctx context.Context) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodDelete, "/api/workspaces/"+h.ws.ID, nil).WithContext(ctx)
	req.SetPathValue("wsId", h.ws.ID)
	rec := httptest.NewRecorder()
	h.server.handleDeleteWorkspace(rec, req)
	return rec
}

func TestDeleteWorkspaceStopsLiveUnsupportedProviderSession(t *testing.T) {
	h := newWorkspaceDeleteHarness(t, 1)
	unsupported := h.chats[0]
	unsupported.Provider = "omp"
	if err := h.store.UpdateChat(unsupported); err != nil {
		t.Fatal(err)
	}
	if got := h.store.ListChats(h.ws.ID); len(got) != 0 {
		t.Fatalf("unsupported fixture unexpectedly listed: %+v", got)
	}

	rec := h.delete(context.Background())
	if rec.Code != http.StatusNoContent {
		t.Fatalf("delete status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if got := h.manager.LiveSummaries(); len(got) != 0 {
		t.Fatalf("live manager sessions after delete = %d", len(got))
	}
	if got := h.daemon.LiveSessions(); len(got) != 0 {
		t.Fatalf("live daemon sessions after delete = %v", got)
	}
	if got := h.daemon.RequestCount(omorpc.CmdCloseSession); got != 1 {
		t.Fatalf("close requests = %d, want 1", got)
	}
}

func TestDeleteWorkspaceStopsEveryActiveChatBeforeDeletingMetadata(t *testing.T) {
	h := newWorkspaceDeleteHarness(t, 3)
	rec := h.delete(context.Background())
	if rec.Code != http.StatusNoContent {
		t.Fatalf("delete status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if _, err := h.store.GetWorkspace(h.ws.ID); !errors.Is(err, cursorstore.ErrNotFound) {
		t.Fatalf("workspace remains after delete: %v", err)
	}
	if got := h.manager.LiveSummaries(); len(got) != 0 {
		t.Fatalf("live manager sessions after delete = %d", len(got))
	}
	if got := h.daemon.LiveSessions(); len(got) != 0 {
		t.Fatalf("live daemon sessions after delete = %v", got)
	}
	if got := h.daemon.RequestCount(omorpc.CmdCloseSession); got != len(h.chats) {
		t.Fatalf("close requests = %d, want %d", got, len(h.chats))
	}
}

func TestDeleteWorkspaceStopFailurePreservesMetadataAndRetrySucceeds(t *testing.T) {
	h := newWorkspaceDeleteHarness(t, 3)
	h.daemon.FailNext(omorpc.CmdCloseSession, omorpc.ErrCodeMissingSessionID)

	first := h.delete(context.Background())
	if first.Code != http.StatusInternalServerError {
		t.Fatalf("first delete status = %d, body = %s", first.Code, first.Body.String())
	}
	if _, err := h.store.GetWorkspace(h.ws.ID); err != nil {
		t.Fatalf("workspace metadata removed after stop failure: %v", err)
	}
	if got := h.daemon.RequestCount(omorpc.CmdCloseSession); got != len(h.chats) {
		t.Fatalf("first attempt close requests = %d, want all %d", got, len(h.chats))
	}

	second := h.delete(context.Background())
	if second.Code != http.StatusNoContent {
		t.Fatalf("retry status = %d, body = %s", second.Code, second.Body.String())
	}
	if _, err := h.store.GetWorkspace(h.ws.ID); !errors.Is(err, cursorstore.ErrNotFound) {
		t.Fatalf("workspace remains after retry: %v", err)
	}
	if got := h.manager.LiveSummaries(); len(got) != 0 {
		t.Fatalf("live manager sessions after retry = %d", len(got))
	}
}

func TestDeleteWorkspaceRequestCancellationDoesNotCancelStops(t *testing.T) {
	h := newWorkspaceDeleteHarness(t, 1)
	release := h.daemon.BlockHandler(omorpc.CmdCloseSession)
	defer release()

	oldNewStopContext := newChatStopContext
	stopParent := make(chan context.Context, 1)
	newChatStopContext = func(parent context.Context, timeout time.Duration) (context.Context, context.CancelFunc) {
		stopParent <- parent
		return context.WithTimeout(parent, timeout)
	}
	t.Cleanup(func() { newChatStopContext = oldNewStopContext })

	requestCtx, cancelRequest := context.WithCancel(context.Background())
	result := make(chan *httptest.ResponseRecorder, 1)
	go func() { result <- h.delete(requestCtx) }()
	select {
	case parent := <-stopParent:
		if parent.Done() != nil {
			t.Fatal("workspace stop inherited a cancelable request context")
		}
	case <-time.After(workspaceDeleteTestTimeout):
		t.Fatal("workspace deletion did not create a stop context")
	}
	if !h.daemon.AwaitRequestCount(omorpc.CmdCloseSession, 1, workspaceDeleteTestTimeout) {
		t.Fatal("workspace deletion did not reach close_session")
	}
	cancelRequest()
	release()
	select {
	case rec := <-result:
		if rec.Code != http.StatusNoContent {
			t.Fatalf("canceled-request delete status = %d, body = %s", rec.Code, rec.Body.String())
		}
	case <-time.After(workspaceDeleteTestTimeout):
		t.Fatal("workspace deletion did not complete within its lifecycle deadline")
	}
	if got := h.daemon.LiveSessions(); len(got) != 0 {
		t.Fatalf("request cancellation orphaned daemon sessions: %v", got)
	}
}
