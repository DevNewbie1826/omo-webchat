package api

import (
	"context"
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
	"github.com/DevNewbie1826/omo-webchat/internal/session"
	"github.com/DevNewbie1826/omo-webchat/internal/wsbridge"
)

// Both polling delivery paths must carry exact pre-truncation count scalars:
// every /api/sessions/live row and every sessions.activity digest reports
// task running/total and DAG running counts computed from the full rows
// before any digest row cap or byte bound trims the row lists.

type countsE2ECollector = activityE2ECollector

type countsE2EFixture struct {
	t         *testing.T
	daemon    *omorpctest.Daemon
	client    *omorpc.Client
	store     *cursorstore.Store
	chat      cursorstore.Chat
	serverURL string
	token     string
	manager   *session.Manager
}

func newCountsE2EFixture(t *testing.T) *countsE2EFixture {
	t.Helper()
	daemonDir, err := os.MkdirTemp("", "activity-counts-")
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

	root := t.TempDir()
	store, err := cursorstore.Open(filepath.Join(root, "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	workspace := cursorstore.Workspace{ID: "ws-counts", Name: "Counts", Path: root}
	if err := store.SaveWorkspace(workspace); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveChat(cursorstore.Chat{ID: "chat-counts", WorkspaceID: workspace.ID, CWD: root, Name: "Exact counts", NameSource: cursorstore.NameSourceUser}); err != nil {
		t.Fatal(err)
	}

	manager := session.NewManager(session.Config{Client: client, Store: (*wsbridge.CursorStore)(store)})
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	authStore := auth.NewSessionStore(t.Context(), "pw", logger)
	var server *Server
	bridge := wsbridge.New(wsbridge.Config{
		Context: t.Context(), Manager: manager, Store: store, ServerVersion: client.ServerVersion(), Logger: logger,
		PrepareChatVersion: func(ctx context.Context, wsID, chatID string) (uint64, error) {
			return server.prepareChatVersion(ctx, wsID, chatID)
		},
		ChatVersion: func(chatID string) uint64 { return server.chatLifecycleVersion(chatID) },
	})
	server = New(t.Context(), &config.Config{Root: root}, store, authStore, manager, bridge, logger)
	httpServer := httptest.NewServer(server.Handler())
	t.Cleanup(func() {
		httpServer.Close()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = manager.CloseAll(ctx)
		_ = client.Close()
		daemon.Stop()
	})
	token, err := authStore.Create(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	chat, err := store.GetChat("chat-counts")
	if err != nil {
		t.Fatal(err)
	}
	return &countsE2EFixture{t: t, daemon: daemon, client: client, store: store, chat: chat, serverURL: httpServer.URL, token: token, manager: manager}
}

func (f *countsE2EFixture) connectSubscribe() (*gws.Conn, *countsE2ECollector) {
	f.t.Helper()
	collector := &activityE2ECollector{notify: make(chan struct{}, 64)}
	conn, _, err := gws.NewClient(collector, &gws.ClientOption{
		Addr:          "ws" + strings.TrimPrefix(f.serverURL, "http") + "/api/v2/ws",
		RequestHeader: http.Header{"Cookie": []string{auth.CookieName + "=" + f.token}},
	})
	if err != nil {
		f.t.Fatal(err)
	}
	f.t.Cleanup(func() { _ = conn.WriteClose(1000, nil) })
	go conn.ReadLoop()
	collector.next(f.t, "hello")
	writeActivityE2EFrame(f.t, conn, map[string]any{"type": "hello", "version": 2})
	writeActivityE2EFrame(f.t, conn, map[string]any{"type": "sessions.subscribe", "mode": "explicit", "sessionIds": []string{f.chat.ID}})
	if ack := collector.next(f.t, "ack"); ack["command"] != "sessions.subscribe" {
		f.t.Fatalf("subscription ack = %v", ack)
	}
	return conn, collector
}

func (f *countsE2EFixture) attachChat() {
	f.t.Helper()
	conn, frames := f.connectUnsubscribed()
	defer conn.WriteClose(1000, nil)
	writeActivityE2EFrame(f.t, conn, map[string]any{"type": "chat.create", "wsId": f.storeWorkspaceID(), "chatId": f.chat.ID})
	frames.next(f.t, "ready")
	writeActivityE2EFrame(f.t, conn, map[string]any{"type": "ping"})
	frames.next(f.t, "pong")
	chat, err := f.store.GetChat(f.chat.ID)
	if err != nil || chat.SessionFile == "" || chat.DurableSessionID == "" {
		f.t.Fatalf("attached chat identity = %+v, err = %v", chat, err)
	}
	f.chat = chat
}

func (f *countsE2EFixture) storeWorkspaceID() string {
	workspaces := f.store.ListWorkspaces()
	if len(workspaces) == 0 {
		f.t.Fatal("no workspace saved")
	}
	return workspaces[0].ID
}

func (f *countsE2EFixture) connectUnsubscribed() (*gws.Conn, *countsE2ECollector) {
	f.t.Helper()
	collector := &activityE2ECollector{notify: make(chan struct{}, 64)}
	conn, _, err := gws.NewClient(collector, &gws.ClientOption{
		Addr:          "ws" + strings.TrimPrefix(f.serverURL, "http") + "/api/v2/ws",
		RequestHeader: http.Header{"Cookie": []string{auth.CookieName + "=" + f.token}},
	})
	if err != nil {
		f.t.Fatal(err)
	}
	go conn.ReadLoop()
	collector.next(f.t, "hello")
	writeActivityE2EFrame(f.t, conn, map[string]any{"type": "hello", "version": 2})
	return conn, collector
}

func TestSessionsLiveExactCountsBeyondDigestCap(t *testing.T) {
	fixture := newCountsE2EFixture(t)
	fixture.attachChat()
	_, overviewFrames := fixture.connectSubscribe()
	fixture.emitTruncatingActivity()
	// The overview frame proves the manager ingested both snapshots before the
	// poll; the frame scalars themselves are covered by the frame test below.
	for i := 0; i < 2; i++ {
		overviewFrames.next(t, "sessions.activity")
	}
	rows := fetchLiveRows(t, fixture.serverURL, fixture.token)
	assertLiveRowCounts(t, rows[0])
	fixture.assertRetainedCounts()
}

func TestActivityFrameExactCountsBeyondDigestCap(t *testing.T) {
	fixture := newCountsE2EFixture(t)
	fixture.attachChat()
	_, overviewFrames := fixture.connectSubscribe()
	fixture.emitTruncatingActivity()
	taskFrame := overviewFrames.next(t, "sessions.activity")
	dagFrame := overviewFrames.next(t, "sessions.activity")
	if taskFrame["sessionId"] != fixture.chat.ID || taskFrame["overflow"] != false {
		t.Fatalf("task activity frame = %v", taskFrame)
	}
	assertDigestScalar(t, taskFrame["running"].(map[string]any), "tasks", 50)
	assertDigestScalar(t, taskFrame, "done", 550)
	assertLiveRowCounts(t, dagFrame)
	fixture.assertRetainedCounts()
}
