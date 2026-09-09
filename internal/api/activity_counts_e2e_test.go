package api

import (
	"context"
	"encoding/json"
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
	return &countsE2EFixture{t: t, daemon: daemon, client: client, store: store, chat: chat, serverURL: httpServer.URL, token: token}
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

// emitTruncatingActivity publishes one task snapshot with more tasks than the
// digest entry cap, where the 50 running rows are the oldest admitted rows, so
// every bounded retention window drops exactly the running rows from the
// projected lists. The scalars must still report 50 running of 600 total.
func (f *countsE2EFixture) emitTruncatingActivity() {
	f.t.Helper()
	const totalTasks, runningTasks = 600, 50
	tasks := make([]any, 0, totalTasks)
	for i := 0; i < totalTasks; i++ {
		status := "completed"
		if i < runningTasks {
			status = "running"
		}
		tasks = append(tasks, map[string]any{
			"task_id": fmt.Sprintf("st-counts-%03d", i), "status": status,
			"created_at": "2026-09-03T00:00:00Z", "updated_at": "2026-09-03T00:00:01Z",
		})
	}
	f.daemon.EmitSession(f.chat.SessionFile, map[string]any{
		"type": "extension_event", "name": "omo.task.updated",
		"data": map[string]any{"parent_session_id": f.chat.DurableSessionID, "truncated_tasks": false, "tasks": tasks},
	})

	// One active DAG run with 600 running nodes; the first 50 nodes carry no
	// task_id, so the task-ID projection can never represent them. The running
	// count is node-based and must stay exact: 600.
	const totalNodes = 600
	nodes := make([]any, 0, totalNodes)
	for i := 0; i < totalNodes; i++ {
		node := map[string]any{"id": fmt.Sprintf("node-%03d", i), "state": "running", "attempt": 1}
		if i >= 50 {
			node["task_id"] = fmt.Sprintf("st-dag-%03d", i)
		}
		nodes = append(nodes, node)
	}
	f.daemon.EmitSession(f.chat.SessionFile, map[string]any{
		"type": "extension_event", "name": "omo.dag.updated",
		"data": map[string]any{
			"parent_session_id": f.chat.DurableSessionID, "truncated_runs": false,
			"runs": []any{map[string]any{
				"run_id": "run-counts", "run_key": "run-counts", "name": "Counts", "status": "running",
				"created_at": "2026-09-03T00:00:00Z", "updated_at": "2026-09-03T00:00:02Z",
				"nodes": nodes,
			}},
		},
	})
}

func assertDigestScalar(t *testing.T, digest map[string]any, field string, want int) {
	t.Helper()
	if digest == nil {
		t.Fatalf("digest absent, want %s = %d", field, want)
	}
	got, present := digest[field]
	if !present {
		t.Fatalf("digest field %s absent (pre-truncation scalars must always be present): %v", field, digest)
	}
	if number, ok := got.(float64); !ok || int(number) != want {
		t.Fatalf("digest field %s = %v, want %d", field, got, want)
	}
}

func assertLiveRowCounts(t *testing.T, row map[string]any) {
	t.Helper()
	taskDigest, ok := row["task_digest"].(map[string]any)
	if !ok {
		t.Fatalf("live row task_digest = %v", row["task_digest"])
	}
	assertDigestScalar(t, taskDigest, "running_count", 50)
	assertDigestScalar(t, taskDigest, "total_count", 600)
	if taskDigest["truncated"] != true {
		t.Fatalf("task digest must stay truncated: %v", taskDigest)
	}
	rows, _ := taskDigest["tasks"].([]any)
	if len(rows) != 512 {
		t.Fatalf("task digest rows = %d, want the 512-entry cap", len(rows))
	}
	for _, entry := range rows {
		if entry.(map[string]any)["status"] == "running" {
			t.Fatalf("running row leaked into the truncated digest: %v", entry)
		}
	}
	dagDigest, ok := row["dag_digest"].(map[string]any)
	if !ok {
		t.Fatalf("live row dag_digest = %v", row["dag_digest"])
	}
	assertDigestScalar(t, dagDigest, "running_count", 600)
	if dagDigest["truncated"] != true {
		t.Fatalf("dag digest must stay truncated: %v", dagDigest)
	}
	runs, _ := dagDigest["runs"].([]any)
	if len(runs) != 1 {
		t.Fatalf("dag digest runs = %v", runs)
	}
	ids, _ := runs[0].(map[string]any)["running_task_ids"].([]any)
	if len(ids) != 512 {
		t.Fatalf("dag digest running_task_ids = %d, want the 512-entry cap", len(ids))
	}
}

func fetchLiveRows(t *testing.T, serverURL, token string) []map[string]any {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, serverURL+"/api/sessions/live", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: token})
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var body struct {
		Sessions []map[string]any `json:"sessions"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK || len(body.Sessions) != 1 {
		t.Fatalf("live REST response status=%d body=%v", resp.StatusCode, body.Sessions)
	}
	return body.Sessions
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
	taskDigest, ok := taskFrame["taskDigest"].(map[string]any)
	if !ok {
		t.Fatalf("activity frame taskDigest = %v", taskFrame["taskDigest"])
	}
	assertDigestScalar(t, taskDigest, "running_count", 50)
	assertDigestScalar(t, taskDigest, "total_count", 600)
	if taskDigest["truncated"] != true {
		t.Fatalf("frame task digest must stay truncated: %v", taskDigest)
	}
	tasks, _ := taskDigest["tasks"].([]any)
	if len(tasks) != 512 {
		t.Fatalf("frame task digest rows = %d, want the 512-entry cap", len(tasks))
	}
	dagDigest, ok := dagFrame["dagDigest"].(map[string]any)
	if !ok {
		t.Fatalf("activity frame dagDigest = %v", dagFrame["dagDigest"])
	}
	assertDigestScalar(t, dagDigest, "running_count", 600)
	if dagDigest["truncated"] != true {
		t.Fatalf("frame dag digest must stay truncated: %v", dagDigest)
	}
	runs, _ := dagDigest["runs"].([]any)
	if len(runs) != 1 {
		t.Fatalf("frame dag digest runs = %v", runs)
	}
	ids, _ := runs[0].(map[string]any)["running_task_ids"].([]any)
	if len(ids) != 512 {
		t.Fatalf("frame dag digest running_task_ids = %d, want the 512-entry cap", len(ids))
	}
}
