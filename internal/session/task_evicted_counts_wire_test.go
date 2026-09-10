package session_test

// Real-surface regression (review r4/G1) for observed engine behavior and the
// public delivery contract: when bounded retention has evicted a task's row
// and an accepted terminal DAG outcome later completes it, the authenticated
// REST row, the sessions.activity digest, and the attached shelf authority
// must all publish the corrected task running scalar alongside the aggregate.

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
	"sync"
	"testing"
	"time"

	"github.com/lxzan/gws"

	"github.com/DevNewbie1826/omo-webchat/internal/api"
	"github.com/DevNewbie1826/omo-webchat/internal/auth"
	"github.com/DevNewbie1826/omo-webchat/internal/config"
	"github.com/DevNewbie1826/omo-webchat/internal/cursorstore"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc/omorpctest"
	"github.com/DevNewbie1826/omo-webchat/internal/session"
	"github.com/DevNewbie1826/omo-webchat/internal/wsbridge"
)

// Retention bound of the bounded digest projection, as declared by the
// engine's public count contract.
const (
	evictedDigestRows  = 512
	evictedTotalCounts = 513
)

type evictedCountsCollector struct {
	gws.BuiltinEventHandler
	mu     sync.Mutex
	frames []map[string]any
	notify chan struct{}
}

func (c *evictedCountsCollector) OnMessage(_ *gws.Conn, message *gws.Message) {
	defer message.Close()
	var frame map[string]any
	if json.Unmarshal(message.Bytes(), &frame) != nil {
		return
	}
	c.mu.Lock()
	c.frames = append(c.frames, frame)
	c.mu.Unlock()
	select {
	case c.notify <- struct{}{}:
	default:
	}
}

func (c *evictedCountsCollector) next(t *testing.T, typ string) map[string]any {
	t.Helper()
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()
	for {
		c.mu.Lock()
		for i, frame := range c.frames {
			if frame["type"] == typ {
				c.frames = append(c.frames[:i], c.frames[i+1:]...)
				c.mu.Unlock()
				return frame
			}
		}
		c.mu.Unlock()
		select {
		case <-c.notify:
		case <-timer.C:
			t.Fatalf("timed out waiting for %s", typ)
		}
	}
}

// nextTaskDigestFrame awaits the next sessions.activity frame carrying a task
// digest, skipping any digest-less frame. Waiting is event-driven only.
func (c *evictedCountsCollector) nextTaskDigestFrame(t *testing.T) map[string]any {
	t.Helper()
	for i := 0; i < 8; i++ {
		frame := c.next(t, "sessions.activity")
		if _, ok := frame["taskDigest"].(map[string]any); ok {
			return frame
		}
	}
	t.Fatal("no sessions.activity frame with a task digest")
	return nil
}

func writeEvictedCountsFrame(t *testing.T, conn *gws.Conn, frame any) {
	t.Helper()
	raw, err := json.Marshal(frame)
	if err != nil {
		t.Fatal(err)
	}
	if err := conn.WriteMessage(gws.OpcodeText, raw); err != nil {
		t.Fatal(err)
	}
}

type evictedCountsFixture struct {
	t         *testing.T
	daemon    *omorpctest.Daemon
	client    *omorpc.Client
	store     *cursorstore.Store
	chat      cursorstore.Chat
	serverURL string
	token     string
}

func newEvictedCountsFixture(t *testing.T) *evictedCountsFixture {
	t.Helper()
	daemonDir, err := os.MkdirTemp("", "evicted-counts-")
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
	workspace := cursorstore.Workspace{ID: "ws-evicted", Name: "Evicted", Path: root}
	if err := store.SaveWorkspace(workspace); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveChat(cursorstore.Chat{ID: "chat-evicted", WorkspaceID: workspace.ID, CWD: root, Name: "Evicted counts", NameSource: cursorstore.NameSourceUser}); err != nil {
		t.Fatal(err)
	}

	manager := session.NewManager(session.Config{Client: client, Store: (*wsbridge.CursorStore)(store)})
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	authStore := auth.NewSessionStore(t.Context(), "pw", logger)
	bridge := wsbridge.New(wsbridge.Config{
		Context: t.Context(), Manager: manager, Store: store, ServerVersion: client.ServerVersion(), Logger: logger,
	})
	server := api.New(t.Context(), &config.Config{Root: root}, store, authStore, manager, bridge, logger)
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
	chat, err := store.GetChat("chat-evicted")
	if err != nil {
		t.Fatal(err)
	}
	return &evictedCountsFixture{t: t, daemon: daemon, client: client, store: store, chat: chat, serverURL: httpServer.URL, token: token}
}

func (f *evictedCountsFixture) connect() (*gws.Conn, *evictedCountsCollector) {
	f.t.Helper()
	collector := &evictedCountsCollector{notify: make(chan struct{}, 64)}
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
	writeEvictedCountsFrame(f.t, conn, map[string]any{"type": "hello", "version": 2})
	return conn, collector
}

func (f *evictedCountsFixture) workspaceID() string {
	f.t.Helper()
	workspaces := f.store.ListWorkspaces()
	if len(workspaces) == 0 {
		f.t.Fatal("no workspace saved")
	}
	return workspaces[0].ID
}

// openChat attaches the chat so later engine events dispatch to a bound
// session, and refreshes the stored chat identity.
func (f *evictedCountsFixture) openChat() (*gws.Conn, *evictedCountsCollector) {
	f.t.Helper()
	conn, frames := f.connect()
	writeEvictedCountsFrame(f.t, conn, map[string]any{"type": "chat.create", "wsId": f.workspaceID(), "chatId": f.chat.ID})
	frames.next(f.t, "ready")
	writeEvictedCountsFrame(f.t, conn, map[string]any{"type": "ping"})
	frames.next(f.t, "pong")
	chat, err := f.store.GetChat(f.chat.ID)
	if err != nil || chat.SessionFile == "" || chat.DurableSessionID == "" {
		f.t.Fatalf("attached chat identity = %+v, err = %v", chat, err)
	}
	f.chat = chat
	return conn, frames
}

func (f *evictedCountsFixture) liveRow(t *testing.T) map[string]any {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, f.serverURL+"/api/sessions/live", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: f.token})
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var body map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("live REST status=%d body=%v", resp.StatusCode, body)
	}
	rows, ok := body["sessions"].([]any)
	if !ok || len(rows) == 0 {
		t.Fatalf("live REST rows absent: %v", body)
	}
	for _, row := range rows {
		if entry, ok := row.(map[string]any); ok && entry["id"] == f.chat.ID {
			return entry
		}
	}
	t.Fatalf("live REST row for %q absent: %v", f.chat.ID, body)
	return nil
}

func assertEvictedWireScalar(t *testing.T, digest map[string]any, field string, want int, stage string) {
	t.Helper()
	if digest == nil {
		t.Fatalf("%s: task digest absent", stage)
	}
	got, present := digest[field]
	if !present {
		t.Fatalf("%s: task digest field %q absent: %v", stage, field, digest)
	}
	if number, ok := got.(float64); !ok || int(number) != want {
		t.Errorf("%s: task digest %s = %v, want %d", stage, field, got, want)
	}
}

func assertEvictedWireDigest(t *testing.T, digest map[string]any, stage string) {
	t.Helper()
	assertEvictedWireScalar(t, digest, "running_count", 0, stage)
	assertEvictedWireScalar(t, digest, "agent_running_count", 0, stage)
	assertEvictedWireScalar(t, digest, "total_count", evictedTotalCounts, stage)
	assertEvictedWireScalar(t, digest, "agent_total_count", evictedTotalCounts, stage)
	rows, _ := digest["tasks"].([]any)
	if len(rows) != evictedDigestRows {
		t.Errorf("%s: task digest rows=%d, want the %d-entry retention bound", stage, len(rows), evictedDigestRows)
	}
	for _, entry := range rows {
		if entry.(map[string]any)["task_id"] == "task-0000" {
			t.Errorf("%s: evicted victim row retained", stage)
		}
	}
}

func TestEvictedTaskOutcomePublishesCorrectedScalarsOnRESTAndActivityWS(t *testing.T) {
	f := newEvictedCountsFixture(t)
	attached, attachedFrames := f.openChat()
	defer attached.WriteClose(1000, nil)

	subscribeConn, frames := f.connect()
	defer subscribeConn.WriteClose(1000, nil)
	writeEvictedCountsFrame(t, subscribeConn, map[string]any{"type": "sessions.subscribe", "mode": "explicit", "sessionIds": []string{f.chat.ID}})
	if ack := frames.next(t, "ack"); ack["command"] != "sessions.subscribe" {
		t.Fatalf("subscription ack = %v", ack)
	}

	tasks := make([]any, evictedTotalCounts)
	for i := range tasks {
		status := "completed"
		if i == 0 {
			status = "running"
		}
		tasks[i] = map[string]any{
			"task_id": fmt.Sprintf("task-%04d", i), "name": fmt.Sprintf("Task %d", i),
			"status": status, "updated_at": "2026-09-10T10:02:00Z",
		}
	}
	f.daemon.EmitSession(f.chat.SessionFile, map[string]any{
		"type": "extension_event", "name": "omo.task.updated",
		"data": map[string]any{"parent_session_id": f.chat.DurableSessionID, "truncated_tasks": false, "tasks": tasks},
	})
	taskFrame := frames.nextTaskDigestFrame(t)
	assertEvictedWireScalar(t, taskFrame["taskDigest"].(map[string]any), "running_count", 1, "WS/initial")
	assertEvictedWireScalar(t, taskFrame["taskDigest"].(map[string]any), "total_count", evictedTotalCounts, "WS/initial")
	initial := attachedFrames.next(t, "extensionEvent")
	if initial["name"] != "omo.task.updated" {
		t.Fatalf("attached initial frame = %v", initial)
	}
	if data, ok := initial["data"].(map[string]any); !ok || data["running_count"] != float64(1) || data["total_count"] != float64(evictedTotalCounts) {
		t.Fatalf("attached initial task counts = %v", initial["data"])
	}

	f.daemon.EmitSession(f.chat.SessionFile, map[string]any{
		"type": "extension_event", "name": "omo.dag.updated",
		"data": map[string]any{
			"parent_session_id": f.chat.DurableSessionID, "truncated_runs": false,
			"runs": []any{map[string]any{
				"run_id": "outcome", "status": "completed", "updated_at": "2026-09-10T10:03:00Z",
				"nodes": []any{map[string]any{"id": "node", "task_id": "task-0000", "state": "completed"}},
			}},
		},
	})
	outcome := attachedFrames.next(t, "extensionEvent")
	if outcome["name"] != "omo.dag.updated" {
		t.Fatalf("attached outcome frame = %v", outcome)
	}
	if data, ok := outcome["data"].(map[string]any); !ok || data["agent_running_count"] != float64(0) || data["agent_total_count"] != float64(evictedTotalCounts) || data["running_count"] != float64(0) {
		t.Errorf("attached outcome authority = %v", outcome["data"])
	}
	outcomeFrame := frames.nextTaskDigestFrame(t)
	assertEvictedWireDigest(t, outcomeFrame["taskDigest"].(map[string]any), "WS")
	assertEvictedWireDigest(t, f.liveRow(t)["task_digest"].(map[string]any), "REST")
}
