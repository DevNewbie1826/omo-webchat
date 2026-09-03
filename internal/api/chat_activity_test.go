package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
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
	var body struct {
		History struct {
			Task json.RawMessage `json:"task"`
			Dag  json.RawMessage `json:"dag"`
		} `json:"history"`
		Task       json.RawMessage    `json:"task"`
		Dag        json.RawMessage    `json:"dag"`
		TaskDigest session.TaskDigest `json:"task_digest"`
		DagDigest  session.DagDigest  `json:"dag_digest"`
	}
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if string(body.History.Task) != string(body.Task) || string(body.History.Dag) != string(body.Dag) {
		t.Fatalf("history and stage-8 aliases differ: %+v", body)
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
