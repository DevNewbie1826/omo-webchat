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
)

const goalTestSessionID = "01a05dff-ce50-7e6e-afd8-584465582016"

func TestChatGoalEndpointIsProtectedCatalogScopedAndConfined(t *testing.T) {
	agentDir := t.TempDir()
	t.Setenv("OMO_CODING_AGENT_DIR", agentDir)
	server, store, ws := newChatCreateTestServer(t)
	cwd := filepath.Join(ws.Path, "goal-cwd")
	if err := os.MkdirAll(cwd, 0o700); err != nil {
		t.Fatal(err)
	}
	chat := cursorstore.Chat{ID: "chat-goal", WorkspaceID: ws.ID, CWD: cwd, DurableSessionID: goalTestSessionID, Name: "goal"}
	if err := store.SaveChat(chat); err != nil {
		t.Fatal(err)
	}
	goalDir := filepath.Join(agentDir, "sessions", sessionDirNameForCwd(cwd), "extensions", "goal")
	if err := os.MkdirAll(goalDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(goalDir, goalTestSessionID+".json"), []byte(`{
		"version": 1,
		"goal": {"threadId": "`+goalTestSessionID+`", "objective": "골 상태 실시간 웹 표시", "status": "active", "createdAt": 1788430891, "updatedAt": 1788448206}
	}`), 0o600); err != nil {
		t.Fatal(err)
	}

	path := "/api/workspaces/" + ws.ID + "/chats/" + chat.ID + "/goal"
	unauthorized := httptest.NewRecorder()
	server.Handler().ServeHTTP(unauthorized, httptest.NewRequest(http.MethodGet, path, nil))
	if unauthorized.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized status = %d", unauthorized.Code)
	}

	token, err := server.sessions.Create(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	request := func(p string) *http.Request {
		req := httptest.NewRequest(http.MethodGet, p, nil)
		req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: token})
		return req
	}
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request(path))
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	var body struct {
		Goal *struct {
			Objective          string `json:"objective"`
			Status             string `json:"status"`
			BlockedReason      string `json:"blockedReason"`
			CreatedAt          *int64 `json:"createdAt"`
			UpdatedAt          *int64 `json:"updatedAt"`
			ObjectiveTruncated bool   `json:"objectiveTruncated"`
		} `json:"goal"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Goal == nil || body.Goal.Objective != "골 상태 실시간 웹 표시" || body.Goal.Status != "active" {
		t.Fatalf("goal = %+v", body.Goal)
	}
	if body.Goal.CreatedAt == nil || *body.Goal.CreatedAt != 1788430891 {
		t.Fatalf("createdAt = %+v", body.Goal)
	}

	cross := httptest.NewRecorder()
	server.Handler().ServeHTTP(cross, request("/api/workspaces/other/chats/"+chat.ID+"/goal"))
	if cross.Code != http.StatusNotFound {
		t.Fatalf("cross-catalog status = %d", cross.Code)
	}
	// A cwd outside the workspace is rejected even though the goal file exists.
	outside := cursorstore.Chat{ID: "chat-outside", WorkspaceID: ws.ID, CWD: t.TempDir(), DurableSessionID: goalTestSessionID, Name: "outside"}
	if err := store.SaveChat(outside); err != nil {
		t.Fatal(err)
	}
	outsideRes := httptest.NewRecorder()
	server.Handler().ServeHTTP(outsideRes, request("/api/workspaces/"+ws.ID+"/chats/"+outside.ID+"/goal"))
	if outsideRes.Code != http.StatusNotFound {
		t.Fatalf("outside-workspace status = %d", outsideRes.Code)
	}
	// A chat with no durable identity yet has no goal surface: 200 with null.
	bare := cursorstore.Chat{ID: "chat-bare", WorkspaceID: ws.ID, CWD: cwd, Name: "bare"}
	if err := store.SaveChat(bare); err != nil {
		t.Fatal(err)
	}
	res := httptest.NewRecorder()
	server.Handler().ServeHTTP(res, request("/api/workspaces/"+ws.ID+"/chats/"+bare.ID+"/goal"))
	if res.Code != http.StatusOK || res.Body.String() != "{\"goal\":null}\n" {
		t.Fatalf("goal-less chat status = %d body = %s", res.Code, res.Body.String())
	}
}

func TestChatGoalEndpointTreatsCorruptAndMissingAsNoGoal(t *testing.T) {
	agentDir := t.TempDir()
	t.Setenv("OMO_CODING_AGENT_DIR", agentDir)
	server, store, ws := newChatCreateTestServer(t)
	chat := cursorstore.Chat{ID: "chat-corrupt", WorkspaceID: ws.ID, CWD: ws.Path, DurableSessionID: goalTestSessionID, Name: "corrupt"}
	if err := store.SaveChat(chat); err != nil {
		t.Fatal(err)
	}
	goalDir := filepath.Join(agentDir, "sessions", sessionDirNameForCwd(ws.Path), "extensions", "goal")
	if err := os.MkdirAll(goalDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(goalDir, goalTestSessionID+".json"), []byte(`{"goal": {`), 0o600); err != nil {
		t.Fatal(err)
	}
	token, err := server.sessions.Create(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, "/api/workspaces/"+ws.ID+"/chats/"+chat.ID+"/goal", nil)
	req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: token})
	res := httptest.NewRecorder()
	server.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK || res.Body.String() != "{\"goal\":null}\n" {
		t.Fatalf("corrupt goal status = %d body = %s", res.Code, res.Body.String())
	}
}
