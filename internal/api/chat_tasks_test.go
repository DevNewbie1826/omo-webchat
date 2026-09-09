package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/DevNewbie1826/omo-webchat/internal/auth"
	"github.com/DevNewbie1826/omo-webchat/internal/cursorstore"
)

type taskHTTPFixture struct {
	server           *Server
	store            *testMetadataStore
	ws               cursorstore.Workspace
	dir, path, token string
}

func newTaskHTTPFixture(t *testing.T) taskHTTPFixture {
	t.Helper()
	server, store, ws := newChatCreateTestServer(t)
	chat := cursorstore.Chat{ID: "task-chat", WorkspaceID: ws.ID, CWD: ws.Path, DurableSessionID: "parent", Name: "Tasks"}
	if err := store.SaveChat(chat); err != nil {
		t.Fatal(err)
	}
	token, err := server.sessions.Create(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(ws.Path, ".omo", "senpi-task", "tasks")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	return taskHTTPFixture{server, store, ws, dir, "/api/workspaces/" + ws.ID + "/chats/" + chat.ID + "/tasks", token}
}

func (f taskHTTPFixture) get(t *testing.T, path string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil).WithContext(t.Context())
	req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: f.token})
	rec := httptest.NewRecorder()
	f.server.Handler().ServeHTTP(rec, req)
	return rec
}

func writeTaskStoreJSON(t *testing.T, path string, value any) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
}

type chatTasksBody struct {
	ParentSessionID string           `json:"parent_session_id"`
	TruncatedTasks  bool             `json:"truncated_tasks"`
	Tasks           []map[string]any `json:"tasks"`
}

func assertJSONNotFound(t *testing.T, rec *httptest.ResponseRecorder) {
	t.Helper()
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status=%d want 404 body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Header().Get("Content-Type"), "application/json") {
		t.Fatalf("not-found Content-Type=%q body=%s", rec.Header().Get("Content-Type"), rec.Body.String())
	}
	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || body["error"] == "" {
		t.Fatalf("not-found body=%s", rec.Body.String())
	}
}

func decodeChatTasks(t *testing.T, rec *httptest.ResponseRecorder) chatTasksBody {
	t.Helper()
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	if rec.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("Cache-Control = %q, want no-store", rec.Header().Get("Cache-Control"))
	}
	var body chatTasksBody
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Tasks == nil {
		t.Fatalf("tasks must be an array, got null: %s", rec.Body.String())
	}
	if body.TruncatedTasks {
		t.Fatalf("full fetch must not set truncated_tasks: %s", rec.Body.String())
	}
	return body
}

func TestChatTasksRouteAuthAndOwnership(t *testing.T) {
	f := newTaskHTTPFixture(t)
	writeTaskStoreJSON(t, filepath.Join(f.dir, "owned.json"), map[string]any{
		"task_id": "st-owned", "status": "completed", "parent_session_id": "parent",
		"name": "Owned", "created_at": "2026-09-03T12:00:00Z", "updated_at": "2026-09-03T12:01:00Z",
	})

	unauthorized := httptest.NewRecorder()
	f.server.Handler().ServeHTTP(unauthorized, httptest.NewRequest(http.MethodGet, f.path, nil))
	if unauthorized.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated status=%d want 401", unauthorized.Code)
	}

	rec := f.get(t, f.path)
	if rec.Code == http.StatusNotFound && rec.Header().Get("Content-Type") != "application/json" {
		t.Fatalf("route absent: status=%d body=%s", rec.Code, rec.Body.String())
	}
	body := decodeChatTasks(t, rec)
	if body.ParentSessionID != "parent" || len(body.Tasks) != 1 {
		t.Fatalf("owned body = %s", rec.Body.String())
	}
	if got, _ := body.Tasks[0]["task_id"].(string); got != "st-owned" {
		t.Fatalf("owned task_id = %v", body.Tasks[0]["task_id"])
	}

	assertJSONNotFound(t, f.get(t, "/api/workspaces/missing-ws/chats/task-chat/tasks"))
	assertJSONNotFound(t, f.get(t, "/api/workspaces/"+f.ws.ID+"/chats/missing-chat/tasks"))
	assertJSONNotFound(t, f.get(t, "/api/workspaces/"+f.ws.ID+"/chats/%2e%2e/tasks"))

	if err := f.store.SaveChat(cursorstore.Chat{ID: "other", WorkspaceID: f.ws.ID, CWD: f.ws.Path, DurableSessionID: "other"}); err != nil {
		t.Fatal(err)
	}
	if err := f.store.SaveWorkspace(cursorstore.Workspace{ID: "other-ws", Path: t.TempDir()}); err != nil {
		t.Fatal(err)
	}
	other := decodeChatTasks(t, f.get(t, strings.Replace(f.path, "task-chat", "other", 1)))
	if other.ParentSessionID != "other" || len(other.Tasks) != 0 {
		t.Fatalf("same-workspace other chat must not leak owned tasks: %+v", other)
	}
	cross := f.get(t, strings.Replace(f.path, f.ws.ID, "other-ws", 1))
	if cross.Code == http.StatusForbidden {
		t.Fatal("cross-workspace must be 404, got 403")
	}
	assertJSONNotFound(t, cross)
}

func TestChatTasksLiveRowShapeAndParentFilter(t *testing.T) {
	f := newTaskHTTPFixture(t)
	writeTaskStoreJSON(t, filepath.Join(f.dir, "match.json"), map[string]any{
		"task_id": "st-match", "status": "running", "parent_session_id": "parent",
		"name": "Inspect", "task_summary": "Inspect history", "agent_type": "explore",
		"category": "audit", "created_at": "2026-09-03T10:00:00Z", "updated_at": "2026-09-03T10:01:00Z",
		"child_session_id": "child-1",
		"run_stats":        map[string]any{"turns": 2},
		"owner":            map[string]any{"kind": "dag", "runId": "dag-match", "nodeId": "inspect"},
		"spawn_spec":       map[string]any{"prompt": "must not leak"},
		"model":            "secret-model",
		"final_response":   "secret-result",
		"error_message":    "secret-error",
		"live_progress": map[string]any{
			"activity": "unused", "started_at": "unused", "total_tokens": 10_000,
			"current_tool": "read", "last_assistant_line": "working", "turns": 3,
			"tool_calls": 4, "tokens_per_second": 1.5,
		},
	})
	writeTaskStoreJSON(t, filepath.Join(f.dir, "other.json"), map[string]any{
		"task_id": "st-other", "status": "completed", "parent_session_id": "other-parent", "name": "Other",
	})
	if err := os.WriteFile(filepath.Join(f.dir, "malformed.json"), []byte("{"), 0600); err != nil {
		t.Fatal(err)
	}
	writeTaskStoreJSON(t, filepath.Join(f.dir, "nameless.json"), map[string]any{
		"task_id": "st-nameless", "status": "completed", "parent_session_id": "parent",
		"created_at": "2026-09-03T09:00:00Z",
	})

	body := decodeChatTasks(t, f.get(t, f.path))
	if body.ParentSessionID != "parent" || len(body.Tasks) != 2 {
		t.Fatalf("body = %+v", body)
	}
	if got, _ := body.Tasks[0]["task_id"].(string); got != "st-match" {
		t.Fatalf("newest-first task_id = %v", body.Tasks[0]["task_id"])
	}
	row := body.Tasks[0]
	for _, field := range []string{"spawn_spec", "model", "final_response", "error_message", "child_session_id", "owner", "run_stats"} {
		if _, leaked := row[field]; leaked {
			t.Fatalf("row leaked %s: %v", field, row)
		}
	}
	if row["name"] != "Inspect" || row["status"] != "running" || row["task_summary"] != "Inspect history" || row["agent_type"] != "explore" || row["category"] != "audit" {
		t.Fatalf("live fields = %v", row)
	}
	progress, _ := row["live_progress"].(map[string]any)
	if progress["current_tool"] != "read" || progress["last_assistant_line"] != "working" || progress["turns"] != float64(3) {
		t.Fatalf("live_progress = %v", progress)
	}
	for _, field := range []string{"activity", "started_at", "total_tokens"} {
		if _, leaked := progress[field]; leaked {
			t.Fatalf("live_progress leaked %s: %v", field, progress)
		}
	}
	if got, _ := body.Tasks[1]["name"].(string); got != "st-nameless" {
		t.Fatalf("missing name must default to task_id, got %q", got)
	}
}

func TestChatTasksFullRosterBeyondLiveBudget(t *testing.T) {
	f := newTaskHTTPFixture(t)
	const total = 520
	for i := 0; i < total; i++ {
		writeTaskStoreJSON(t, filepath.Join(f.dir, fmt.Sprintf("%04d.json", i)), map[string]any{
			"task_id": fmt.Sprintf("task-%04d", i), "status": "completed", "parent_session_id": "parent",
			"name": "Audit task", "task_summary": strings.Repeat("x", 1024),
			"created_at": fmt.Sprintf("2026-09-03T12:%02d:%02dZ", i/60, i%60),
		})
	}

	body := decodeChatTasks(t, f.get(t, f.path))
	if len(body.Tasks) != total {
		t.Fatalf("full fetch rows=%d want %d", len(body.Tasks), total)
	}
	if got, _ := body.Tasks[0]["task_id"].(string); got != "task-0519" {
		t.Fatalf("first row = %q, want newest", got)
	}
	if got, _ := body.Tasks[total-1]["task_id"].(string); got != "task-0000" {
		t.Fatalf("last row = %q, want oldest", got)
	}
	if summary, _ := body.Tasks[0]["task_summary"].(string); len(summary) != 512 {
		t.Fatalf("row text must match live projection length, got %d", len(summary))
	}

	act := f.get(t, strings.TrimSuffix(f.path, "/tasks")+"/activity")
	if act.Code != http.StatusOK {
		t.Fatalf("activity status=%d body=%s", act.Code, act.Body.String())
	}
	var activity struct {
		Task       json.RawMessage `json:"task"`
		TaskDigest struct {
			Tasks     []struct{} `json:"tasks"`
			Truncated bool       `json:"truncated"`
		} `json:"task_digest"`
	}
	if err := json.Unmarshal(act.Body.Bytes(), &activity); err != nil {
		t.Fatal(err)
	}
	var snapshot struct {
		Tasks []struct{} `json:"tasks"`
	}
	if err := json.Unmarshal(activity.Task, &snapshot); err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Tasks) >= total && !activity.TaskDigest.Truncated {
		t.Fatalf("fixture did not exceed live activity budget: snapshot=%d digest=%d truncated=%v", len(snapshot.Tasks), len(activity.TaskDigest.Tasks), activity.TaskDigest.Truncated)
	}
}

func TestChatTasksStoreBoundaries(t *testing.T) {
	t.Run("missingStoreEmpty", func(t *testing.T) {
		f := newTaskHTTPFixture(t)
		if err := os.RemoveAll(filepath.Join(f.ws.Path, ".omo")); err != nil {
			t.Fatal(err)
		}
		body := decodeChatTasks(t, f.get(t, f.path))
		if len(body.Tasks) != 0 || body.ParentSessionID != "parent" {
			t.Fatalf("absent store body = %+v", body)
		}
	})
	t.Run("inaccessibleStore", func(t *testing.T) {
		for _, kind := range []string{"symlink", "regularFile"} {
			t.Run(kind, func(t *testing.T) {
				f := newTaskHTTPFixture(t)
				if err := os.RemoveAll(f.dir); err != nil {
					t.Fatal(err)
				}
				if kind == "symlink" {
					if err := os.Symlink(t.TempDir(), f.dir); err != nil {
						t.Fatal(err)
					}
				} else if err := os.WriteFile(f.dir, []byte("not a directory"), 0600); err != nil {
					t.Fatal(err)
				}
				assertJSONNotFound(t, f.get(t, f.path))
			})
		}
	})
	t.Run("relativeCwd", func(t *testing.T) {
		f := newTaskHTTPFixture(t)
		if err := f.store.SaveChat(cursorstore.Chat{ID: "relative", WorkspaceID: f.ws.ID, CWD: "relative", DurableSessionID: "parent", Name: "relative"}); err != nil {
			t.Fatal(err)
		}
		assertJSONNotFound(t, f.get(t, "/api/workspaces/"+f.ws.ID+"/chats/relative/tasks"))
	})
}
