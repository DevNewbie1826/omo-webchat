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

// Polling delivery must carry exact pre-truncation scalars on both paths:
// the sessions.activity frame digest and every /api/sessions/live row. The
// engine declares the full roster (truncated flags false) while the server
// keeps the delivered row lists truncated, so the scalars are the only place
// the exact numbers exist — and they must always be present.
func TestActivitySubscribeExactCountsSurviveDigestTruncation(t *testing.T) {
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

	collector := &activityE2ECollector{notify: make(chan struct{}, 64)}
	conn, _, dialErr := gws.NewClient(collector, &gws.ClientOption{
		Addr:          "ws" + strings.TrimPrefix(httpServer.URL, "http") + "/api/v2/ws",
		RequestHeader: http.Header{"Cookie": []string{auth.CookieName + "=" + token}},
	})
	if dialErr != nil {
		t.Fatal(dialErr)
	}
	defer conn.WriteClose(1000, nil)
	go conn.ReadLoop()
	collector.next(t, "hello")
	writeActivityE2EFrame(t, conn, map[string]any{"type": "hello", "version": 2})
	writeActivityE2EFrame(t, conn, map[string]any{"type": "sessions.subscribe", "mode": "explicit", "sessionIds": []string{"child-counts", "child-unknown"}})
	if ack := collector.next(t, "ack"); ack["command"] != "sessions.subscribe" {
		t.Fatalf("subscription ack = %v", ack)
	}

	// A first partial delivery has visible rows, but no exact run authority.
	// Exercise the subscription serializer and REST before completing the same revision.
	partial := map[string]any{
		"truncated_runs": true,
		"runs":           []any{map[string]any{"run_id": "partial-run", "status": "running", "updated_at": "2026-09-05T12:00:00Z"}},
	}
	for _, complete := range []bool{false, true} {
		partial["truncated_runs"] = !complete
		daemon.Emit(map[string]any{"type": "extension_event", "sessionId": "child-unknown", "name": "omo.dag.updated", "data": partial})
		pushed := collector.next(t, "sessions.activity")
		if pushed["sessionId"] != "child-unknown" {
			t.Fatalf("unexpected partial activity: %v", pushed)
		}
		assertOptionalDagRunPair(t, retainedDagDigest(t, manager, "child-unknown"), complete)
		if !complete && pushed["truncated"].(map[string]any)["dag"] != true {
			t.Fatalf("WS partial disclosure = %v", pushed)
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
		var rest struct {
			Sessions []map[string]any `json:"sessions"`
		}
		err = json.NewDecoder(resp.Body).Decode(&rest)
		resp.Body.Close()
		if err != nil || resp.StatusCode != http.StatusOK {
			t.Fatalf("partial REST status=%d err=%v", resp.StatusCode, err)
		}
		found := false
		for _, row := range rest.Sessions {
			if row["id"] == "child-unknown" {
				found = true
				if !complete && row["truncated"].(map[string]any)["dag"] != true {
					t.Fatalf("REST partial disclosure = %v", row)
				}
			}
		}
		if !found {
			t.Fatalf("partial session missing from REST: %v", rest.Sessions)
		}
	}

	// >digest-entry-cap roster: 520 tasks, 50 running with the oldest clocks
	// so the newest-first digest rows exclude every running task.
	const totalTasks, runningTasks = 520, 50
	tasks := make([]any, 0, totalTasks)
	for i := 0; i < totalTasks; i++ {
		status := "completed"
		updated := fmt.Sprintf("2026-09-05T%02d:%02d:00Z", 12+i/60, i%60)
		if i < runningTasks {
			status = "running"
			updated = fmt.Sprintf("2026-09-01T%02d:%02d:00Z", i/60, i%60)
		}
		tasks = append(tasks, map[string]any{"task_id": fmt.Sprintf("st-counts-%03d", i), "status": status, "updated_at": updated})
	}
	taskPayload := map[string]any{"parent_session_id": "child-counts", "truncated_tasks": false, "tasks": tasks}
	dagPayload := map[string]any{
		"parent_session_id": "child-counts", "truncated_runs": false,
		"runs": []any{
			map[string]any{
				"run_id": "run-alpha", "run_key": "run-alpha", "name": "Alpha", "status": "running",
				"created_at": "2026-09-05T12:00:00Z", "updated_at": "2026-09-05T12:30:00Z",
				"nodes": []any{
					map[string]any{"id": "alpha-0", "state": "running", "task_id": "st-counts-000", "depends_on": []any{}},
					map[string]any{"id": "alpha-1", "state": "running", "task_id": "st-counts-001", "depends_on": []any{}},
					map[string]any{"id": "alpha-2", "state": "completed", "task_id": "st-counts-002", "depends_on": []any{}},
				},
			},
			map[string]any{
				"run_id": "run-beta", "run_key": "run-beta", "name": "Beta", "status": "running",
				"created_at": "2026-09-05T12:01:00Z", "updated_at": "2026-09-05T12:31:00Z",
				"nodes": []any{
					map[string]any{"id": "beta-0", "state": "running", "task_id": "st-counts-003", "depends_on": []any{}},
					map[string]any{"id": "beta-1", "state": "pending", "depends_on": []any{"beta-0"}},
				},
			},
		},
	}

	for _, event := range []struct {
		name    string
		payload map[string]any
	}{{"omo.task.updated", taskPayload}, {"omo.dag.updated", dagPayload}} {
		daemon.Emit(map[string]any{"type": "extension_event", "sessionId": "child-counts", "name": event.name, "data": event.payload})
		pushed := collector.next(t, "sessions.activity")
		if pushed["sessionId"] != "child-counts" {
			t.Fatalf("unexpected activity: %v", pushed)
		}
		assertExactCountFrame(t, event.name, pushed)
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
	var rest struct {
		Sessions []map[string]any `json:"sessions"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&rest); err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("live REST status = %d", resp.StatusCode)
	}
	var row map[string]any
	for _, candidate := range rest.Sessions {
		if candidate["id"] == "child-counts" {
			row = candidate
			break
		}
	}
	if row == nil {
		t.Fatalf("live rows missing child-counts: %v", rest.Sessions)
	}
	assertExactCountFrame(t, "omo.task.updated", row)
	assertExactCountFrame(t, "omo.dag.updated", row)
	for _, summary := range manager.LiveSummaries() {
		if summary.ChatID == "child-counts" {
			assertExactCountDigest(t, "retained task digest", "task", digestObject(t, summary.TaskDigest), 50, 520)
			assertExactCountDigest(t, "retained DAG digest", "dag", digestObject(t, summary.DagDigest), 3, -1)
		}
	}
}
