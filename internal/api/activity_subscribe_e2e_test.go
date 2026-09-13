package api

import (
	"context"
	"encoding/json"
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

func TestActivitySubscribeEngineShapedEndToEnd(t *testing.T) {
	daemonDir, err := os.MkdirTemp("", "activity-e2e-")
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
	workspace := cursorstore.Workspace{ID: "ws-activity", Name: "Activity", Path: root}
	if err := store.SaveWorkspace(workspace); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveChat(cursorstore.Chat{ID: "chat-activity", WorkspaceID: workspace.ID, CWD: root, Name: "Engine activity", NameSource: cursorstore.NameSourceUser}); err != nil {
		t.Fatal(err)
	}

	manager := session.NewManager(session.Config{Client: client, Store: (*wsbridge.CursorStore)(store)})
	activitySource := &activityE2ESource{manager: manager, published: make(chan session.Summary, 8)}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	authStore := auth.NewSessionStore(t.Context(), "pw", logger)
	var server *Server
	bridge := wsbridge.New(wsbridge.Config{
		Context: t.Context(), Manager: manager, Store: store, ActivitySource: activitySource, ServerVersion: client.ServerVersion(), Logger: logger,
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
	connect := func() (*gws.Conn, *activityE2ECollector) {
		collector := &activityE2ECollector{notify: make(chan struct{}, 32)}
		conn, _, dialErr := gws.NewClient(collector, &gws.ClientOption{
			Addr:          "ws" + strings.TrimPrefix(httpServer.URL, "http") + "/api/v2/ws",
			RequestHeader: http.Header{"Cookie": []string{auth.CookieName + "=" + token}},
		})
		if dialErr != nil {
			t.Fatal(dialErr)
		}
		go conn.ReadLoop()
		collector.next(t, "hello")
		writeActivityE2EFrame(t, conn, map[string]any{"type": "hello", "version": 2})
		return conn, collector
	}

	attached, attachedFrames := connect()
	defer attached.WriteClose(1000, nil)
	writeActivityE2EFrame(t, attached, map[string]any{"type": "chat.create", "wsId": workspace.ID, "chatId": "chat-activity"})
	attachedFrames.next(t, "ready")
	// Ready is delivered during checked initialization. A pong on the same
	// socket proves the serialized create handler has returned and the provider
	// route is published before the engine events below are emitted.
	writeActivityE2EFrame(t, attached, map[string]any{"type": "ping"})
	attachedFrames.next(t, "pong")
	chat, err := store.GetChat("chat-activity")
	if err != nil || chat.SessionFile == "" || chat.DurableSessionID == "" {
		t.Fatalf("attached chat identity = %+v, err = %v", chat, err)
	}
	epoch, _ := client.CurrentEpoch()

	overview, overviewFrames := connect()
	defer overview.WriteClose(1000, nil)
	writeActivityE2EFrame(t, overview, map[string]any{"type": "sessions.subscribe", "mode": "explicit", "sessionIds": []string{"chat-activity"}})
	if ack := overviewFrames.next(t, "ack"); ack["command"] != "sessions.subscribe" {
		t.Fatalf("subscription ack = %v", ack)
	}

	taskPayload := map[string]any{
		"parent_session_id":   chat.DurableSessionID,
		"truncated_tasks":     false,
		"running_count":       1,
		"total_count":         2,
		"agent_running_count": 1,
		"agent_total_count":   2,
		"tasks": []any{
			map[string]any{
				"task_id": "st_child_one", "child_session_id": "child-session-1", "status": "running", "task_summary": "Inspect implementation", "name": "inspect", "category": "deep", "execution_mode": "in-process", "model": "test/model", "residency_state": "resident", "depth": 1,
				"created_at": "2026-09-03T00:00:00Z", "updated_at": "2026-09-03T00:00:02Z",
				"run_stats":     map[string]any{"runtime_ms": 2000, "turns": 2, "tool_calls": 1, "total_tokens": 1200, "output_tokens": 200},
				"live_progress": map[string]any{"activity": "reading", "started_at": float64(1788393600000), "current_tool": "read", "last_assistant_line": "Inspecting", "turns": 2, "tool_calls": 1},
			},
			map[string]any{"task_id": "st_child_two", "child_session_id": "child-session-2", "status": "pending", "task_summary": "Verify behavior", "name": "verify", "category": "quick", "execution_mode": "in-process", "depth": 1, "created_at": "2026-09-03T00:00:01Z", "updated_at": "2026-09-03T00:00:01Z"},
		},
	}
	dagPayload := map[string]any{
		"parent_session_id":   chat.DurableSessionID,
		"truncated_runs":      false,
		"running_count":       1,
		"run_running_count":   1,
		"run_total_count":     1,
		"agent_running_count": 1,
		"agent_total_count":   2,
		"runs": []any{map[string]any{
			"run_id": "run-activity", "run_key": "phase-c", "name": "Phase C verification", "status": "running", "created_at": "2026-09-03T00:00:00Z", "updated_at": "2026-09-03T00:00:02Z",
			"counts": map[string]any{"total": 2, "pending": 1, "blocked": 0, "scheduled": 0, "running": 1, "completed": 0, "failed": 0, "cancelled": 0, "skipped": 0},
			"nodes": []any{
				map[string]any{"id": "inspect", "label": "Inspect", "prompt": "Inspect implementation", "depends_on": []any{}, "state": "running", "attempt": 1, "task_id": "st_child_one", "started_at": "2026-09-03T00:00:00Z"},
				map[string]any{"id": "verify", "label": "Verify", "prompt": "Verify behavior", "depends_on": []any{"inspect"}, "state": "pending", "attempt": 0, "task_id": "st_child_two"},
			},
			"edges": []any{map[string]any{"from": "inspect", "to": "verify"}},
			"waves": []any{map[string]any{"index": 0, "node_ids": []any{"inspect"}}, map[string]any{"index": 1, "node_ids": []any{"verify"}}},
		}},
	}

	for _, event := range []struct {
		name    string
		payload map[string]any
	}{{"omo.task.updated", taskPayload}, {"omo.dag.updated", dagPayload}} {
		daemon.EmitSession(chat.SessionFile, map[string]any{"type": "extension_event", "name": event.name, "data": event.payload})
		attachedFrame := attachedFrames.next(t, "extensionEvent")
		if attachedFrame["sessionId"] != "chat-activity" || attachedFrame["name"] != event.name {
			t.Fatalf("attached activity frame = %v", attachedFrame)
		}
		assertEngineActivityPayload(t, event.name, event.payload, attachedFrame["data"])
		select {
		case summary := <-activitySource.published:
			if summary.ChatID != "chat-activity" {
				t.Fatalf("activity source published %q", summary.ChatID)
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("timed out waiting for %s overview publication", event.name)
		}
		pushed := overviewFrames.next(t, "sessions.activity")
		if pushed["sessionId"] != "chat-activity" || pushed["overflow"] != false {
			t.Fatalf("overview activity frame = %v", pushed)
		}
		if pushed["running"].(map[string]any)["agents"] != float64(1) {
			t.Fatalf("lean agent authority = %v", pushed)
		}
		for _, key := range []string{"snapshots", "taskDigest", "dagDigest"} {
			if _, exists := pushed[key]; exists {
				t.Fatalf("rich activity leaked on live socket: %v", pushed)
			}
		}
	}

	req, err := http.NewRequest(http.MethodGet, httpServer.URL+"/api/sessions/live", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: token})
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var rest map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&rest); err != nil {
		t.Fatal(err)
	}
	rows, ok := rest["sessions"].([]any)
	if resp.StatusCode != http.StatusOK || !ok || len(rows) != 1 {
		t.Fatalf("live REST response status=%d body=%v", resp.StatusCode, rest)
	}
	row := rows[0].(map[string]any)
	for _, key := range []string{"id", "title", "running", "done", "dag_done", "dag_total", "truncated"} {
		if _, present := row[key]; !present {
			t.Fatalf("live REST row lost %q: %v", key, row)
		}
	}
	if row["id"] != "chat-activity" || row["running"].(map[string]any)["agents"] != float64(1) {
		t.Fatalf("live REST activity row = %v", row)
	}
	if !client.EpochCurrent(epoch) || daemon.CloseCount() != 0 {
		t.Fatalf("activity flow invalidated provider epoch: closes=%d", daemon.CloseCount())
	}
}
