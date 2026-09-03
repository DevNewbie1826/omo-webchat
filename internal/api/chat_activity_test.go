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
	"github.com/DevNewbie1826/omo-webchat/internal/session"
)

func TestChatActivityEndpointIsProtectedCatalogScopedAndStageEightShaped(t *testing.T) {
	server, store, ws := newChatCreateTestServer(t)
	chat := cursorstore.Chat{
		ID: "chat-history", WorkspaceID: ws.ID, CWD: ws.Path, DurableSessionID: "durable-history",
		SessionFile: filepath.Join(ws.Path, "session.jsonl"), SessionProvenance: cursorstore.SessionProvenanceInPlace,
		Name: "History", NameSource: cursorstore.NameSourceUser,
	}
	if err := store.SaveChat(chat); err != nil {
		t.Fatal(err)
	}
	taskDir := filepath.Join(ws.Path, ".omo", "senpi-task", "tasks")
	if err := os.MkdirAll(taskDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(taskDir, "st-history.json"), []byte(`{
		"task_id":"st-history","status":"completed","parent_session_id":"durable-history",
		"name":"Historical agent","created_at":"2026-09-03T12:00:00Z","updated_at":"2026-09-03T12:01:00Z"
	}`), 0o600); err != nil {
		t.Fatal(err)
	}

	path := "/api/workspaces/" + ws.ID + "/chats/" + chat.ID + "/activity"
	unauthorized := httptest.NewRecorder()
	server.Handler().ServeHTTP(unauthorized, httptest.NewRequest(http.MethodGet, path, nil))
	if unauthorized.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized status = %d", unauthorized.Code)
	}

	token, err := server.sessions.Create(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodGet, path, nil)
	request.AddCookie(&http.Cookie{Name: auth.CookieName, Value: token})
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	var rawBody map[string]json.RawMessage
	if err := json.Unmarshal(response.Body.Bytes(), &rawBody); err != nil {
		t.Fatal(err)
	}
	if _, duplicated := rawBody["history"]; duplicated {
		t.Fatalf("response duplicated snapshots under history: %s", response.Body.String())
	}
	var body struct {
		Task       json.RawMessage    `json:"task"`
		Dag        json.RawMessage    `json:"dag"`
		TaskDigest session.TaskDigest `json:"task_digest"`
		DagDigest  session.DagDigest  `json:"dag_digest"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.TaskDigest.Tasks) != 1 || body.TaskDigest.Tasks[0].TaskID != "st-history" || body.TaskDigest.Tasks[0].Status != "completed" {
		t.Fatalf("task digest = %+v", body.TaskDigest)
	}
	if body.DagDigest.Runs == nil {
		t.Fatalf("dag digest must preserve stage-8 empty-array shape: %+v", body.DagDigest)
	}

	wrongWorkspace := httptest.NewRequest(http.MethodGet, "/api/workspaces/other/chats/"+chat.ID+"/activity", nil)
	wrongWorkspace.AddCookie(&http.Cookie{Name: auth.CookieName, Value: token})
	wrongResponse := httptest.NewRecorder()
	server.Handler().ServeHTTP(wrongResponse, wrongWorkspace)
	if wrongResponse.Code != http.StatusNotFound {
		t.Fatalf("cross-catalog status = %d", wrongResponse.Code)
	}
}

func authenticatedActivityRequest(t *testing.T, server *Server, token, wsID, chatID string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/workspaces/"+wsID+"/chats/"+chatID+"/activity", nil)
	req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: token})
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, req)
	return response
}

func TestChatActivityLargeShelfReturnsBoundedSingleSnapshots(t *testing.T) {
	server, store, ws := newChatCreateTestServer(t)
	chat := cursorstore.Chat{ID: "large-shelf", WorkspaceID: ws.ID, CWD: ws.Path, DurableSessionID: "parent", Name: "large"}
	if err := store.SaveChat(chat); err != nil {
		t.Fatal(err)
	}
	taskDir := filepath.Join(ws.Path, ".omo", "senpi-task", "tasks")
	if err := os.MkdirAll(taskDir, 0o700); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 120; i++ {
		payload := fmt.Sprintf(`{"task_id":"task-%03d","status":"completed","parent_session_id":"parent","final_response":%q}`, i, strings.Repeat("x", 1024))
		if err := os.WriteFile(filepath.Join(taskDir, fmt.Sprintf("%03d.json", i)), []byte(payload), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	token, err := server.sessions.Create(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	response := authenticatedActivityRequest(t, server, token, ws.ID, chat.ID)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	if response.Body.Len() >= 64<<10 {
		t.Fatalf("bounded history response = %d bytes", response.Body.Len())
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(response.Body.Bytes(), &raw); err != nil {
		t.Fatal(err)
	}
	if _, exists := raw["history"]; exists {
		t.Fatalf("snapshots serialized twice: %s", response.Body.String())
	}
	var body chatActivityResponse
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if !body.TaskOversized || len(body.Task) != 4 || string(body.Task) != "null" {
		t.Fatalf("task snapshot = %s oversized=%v", body.Task, body.TaskOversized)
	}
	if body.TaskDigest == nil || len(body.TaskDigest.Tasks) != 120 {
		t.Fatalf("task digest = %+v", body.TaskDigest)
	}
}

func TestChatActivityRejectsUnconfinedCatalogPaths(t *testing.T) {
	server, store, ws := newChatCreateTestServer(t)
	token, err := server.sessions.Create(t.Context())
	if err != nil {
		t.Fatal(err)
	}

	t.Run("relative cwd", func(t *testing.T) {
		chat := cursorstore.Chat{ID: "relative", WorkspaceID: ws.ID, CWD: "relative", DurableSessionID: "parent", Name: "relative"}
		if err := store.SaveChat(chat); err != nil {
			t.Fatal(err)
		}
		if response := authenticatedActivityRequest(t, server, token, ws.ID, chat.ID); response.Code != http.StatusNotFound {
			t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
		}
	})

	t.Run("store symlink escapes workspace", func(t *testing.T) {
		cwd := filepath.Join(ws.Path, "symlink-cwd")
		external := t.TempDir()
		if err := os.MkdirAll(filepath.Join(cwd, ".omo"), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(external, filepath.Join(cwd, ".omo", "senpi-task")); err != nil {
			t.Fatal(err)
		}
		chat := cursorstore.Chat{ID: "symlink-store", WorkspaceID: ws.ID, CWD: cwd, DurableSessionID: "parent", Name: "symlink"}
		if err := store.SaveChat(chat); err != nil {
			t.Fatal(err)
		}
		if response := authenticatedActivityRequest(t, server, token, ws.ID, chat.ID); response.Code != http.StatusNotFound {
			t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
		}
	})
}

func TestChatActivityTreatsGlobMetacharactersLiterally(t *testing.T) {
	server, store, ws := newChatCreateTestServer(t)
	cwd := filepath.Join(ws.Path, "literal[abc]*?")
	taskDir := filepath.Join(cwd, ".omo", "senpi-task", "tasks")
	if err := os.MkdirAll(taskDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(taskDir, "task.json"), []byte(`{"task_id":"literal","status":"completed","parent_session_id":"parent"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	chat := cursorstore.Chat{ID: "literal-glob", WorkspaceID: ws.ID, CWD: cwd, DurableSessionID: "parent", Name: "literal"}
	if err := store.SaveChat(chat); err != nil {
		t.Fatal(err)
	}
	token, err := server.sessions.Create(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	response := authenticatedActivityRequest(t, server, token, ws.ID, chat.ID)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	var body chatActivityResponse
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.TaskDigest == nil || len(body.TaskDigest.Tasks) != 1 || body.TaskDigest.Tasks[0].TaskID != "literal" {
		t.Fatalf("digest = %+v", body.TaskDigest)
	}
}
