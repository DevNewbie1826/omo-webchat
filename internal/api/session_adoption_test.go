package api

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/DevNewbie1826/omo-webchat/internal/adoptcopy"
)

func writeAdoptableDiskSession(t *testing.T, agentDir, cwd, id, name string) string {
	t.Helper()
	dir := filepath.Join(agentDir, "sessions", sessionDirNameForCwd(cwd))
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, id+".jsonl")
	body := fmt.Sprintf("{\"type\":\"session\",\"id\":%q,\"version\":3,\"timestamp\":\"2026-09-02T00:00:00Z\",\"cwd\":%q}\n", id, cwd)
	if name != "" {
		body += fmt.Sprintf("{\"type\":\"session_info\",\"id\":\"info\",\"parentId\":null,\"name\":%q}\n", name)
	}
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func adoptWorkspaceSession(t *testing.T, s *Server, wsID string, body any) *httptest.ResponseRecorder {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest(http.MethodPost, "/api/workspaces/"+wsID+"/sessions/adopt", bytes.NewReader(raw))
	r.SetPathValue("wsId", wsID)
	w := httptest.NewRecorder()
	s.handleAdoptWorkspaceSession(w, r)
	return w
}

func TestAdoptWorkspaceSessionCreatesOwnedChatWithoutTouchingOriginal(t *testing.T) {
	s, st, ws := newChatCreateTestServer(t)
	agentDir := t.TempDir()
	t.Setenv("OMO_CODING_AGENT_DIR", agentDir)
	source := writeAdoptableDiskSession(t, agentDir, ws.Path, "durable-1", "Source title")
	beforeBytes, err := os.ReadFile(source)
	if err != nil {
		t.Fatal(err)
	}
	beforeInfo, err := os.Stat(source)
	if err != nil {
		t.Fatal(err)
	}
	beforeHash := sha256.Sum256(beforeBytes)

	response := adoptWorkspaceSession(t, s, ws.ID, map[string]string{
		"id": "durable-1", "name": "Source title", "resumeIdentity": source,
	})
	if response.Code != http.StatusCreated {
		t.Fatalf("status %d: %s", response.Code, response.Body.String())
	}
	var projected chatResponse
	if err := json.NewDecoder(response.Body).Decode(&projected); err != nil {
		t.Fatal(err)
	}
	chat, err := st.GetChat(projected.ID)
	if err != nil {
		t.Fatal(err)
	}
	if chat.DurableSessionID != "durable-1" {
		t.Fatalf("durable id = %q", chat.DurableSessionID)
	}
	if filepath.Dir(chat.SessionFile) != filepath.Join(st.StateDir(), "adopted") || chat.SessionFile == source {
		t.Fatalf("session file = %q, want owned adopted copy", chat.SessionFile)
	}
	copyBytes, err := os.ReadFile(chat.SessionFile)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(copyBytes, beforeBytes) {
		t.Fatal("owned copy differs from original")
	}
	afterBytes, err := os.ReadFile(source)
	if err != nil {
		t.Fatal(err)
	}
	afterInfo, err := os.Stat(source)
	if err != nil {
		t.Fatal(err)
	}
	if sha256.Sum256(afterBytes) != beforeHash || !afterInfo.ModTime().Equal(beforeInfo.ModTime()) {
		t.Fatal("adoption changed original hash or mtime")
	}
}

func TestAdoptWorkspaceSessionIsIdempotentAndCatalogMarksSource(t *testing.T) {
	s, st, ws := newChatCreateTestServer(t)
	agentDir := t.TempDir()
	t.Setenv("OMO_CODING_AGENT_DIR", agentDir)
	source := writeAdoptableDiskSession(t, agentDir, ws.Path, "durable-2", "Adopt once")
	body := map[string]string{"id": "durable-2", "resumeIdentity": source}

	first := adoptWorkspaceSession(t, s, ws.ID, body)
	second := adoptWorkspaceSession(t, s, ws.ID, body)
	if first.Code != http.StatusCreated || second.Code != http.StatusOK {
		t.Fatalf("statuses = %d, %d; bodies = %s / %s", first.Code, second.Code, first.Body.String(), second.Body.String())
	}
	var firstChat, secondChat chatResponse
	if err := json.NewDecoder(first.Body).Decode(&firstChat); err != nil {
		t.Fatal(err)
	}
	if err := json.NewDecoder(second.Body).Decode(&secondChat); err != nil {
		t.Fatal(err)
	}
	if firstChat.ID != secondChat.ID || len(st.ListChats(ws.ID)) != 1 {
		t.Fatalf("chat ids = %q, %q; chats = %+v", firstChat.ID, secondChat.ID, st.ListChats(ws.ID))
	}
	entries, err := os.ReadDir(filepath.Join(st.StateDir(), "adopted"))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("adopted entries = %v", entries)
	}

	page := listWorkspaceSessions(t, s, ws.ID, "")
	var stored, sourceRow *sessionHistoryItem
	for i := range page.Items {
		switch page.Items[i].Source {
		case sessionHistorySourceStored:
			stored = &page.Items[i]
		case sessionHistorySourceAlreadyAdopted:
			sourceRow = &page.Items[i]
		}
	}
	if stored == nil || stored.Dangling || sourceRow == nil || sourceRow.ID != "durable-2" || sourceRow.ResumeIdentity != source {
		t.Fatalf("catalog = %+v", page.Items)
	}

	chat, err := st.GetChat(firstChat.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(chat.SessionFile); err != nil {
		t.Fatal(err)
	}
	page = listWorkspaceSessions(t, s, ws.ID, "")
	for _, item := range page.Items {
		if item.Source == sessionHistorySourceStored && item.ID == chat.ID && !item.Dangling {
			t.Fatalf("missing adopted copy was not marked dangling: %+v", item)
		}
	}
}

func TestConcurrentWorkspaceSessionAdoptionsCreateOneChat(t *testing.T) {
	s, st, ws := newChatCreateTestServer(t)
	agentDir := t.TempDir()
	t.Setenv("OMO_CODING_AGENT_DIR", agentDir)
	source := writeAdoptableDiskSession(t, agentDir, ws.Path, "durable-concurrent", "")

	const workers = 8
	start := make(chan struct{})
	responses := make(chan *httptest.ResponseRecorder, workers)
	for i := 0; i < workers; i++ {
		go func() {
			<-start
			responses <- adoptWorkspaceSession(t, s, ws.ID, map[string]string{"resumeIdentity": source})
		}()
	}
	close(start)

	ids := make(map[string]bool)
	created := 0
	for i := 0; i < workers; i++ {
		response := <-responses
		if response.Code == http.StatusCreated {
			created++
		} else if response.Code != http.StatusOK {
			t.Fatalf("status %d: %s", response.Code, response.Body.String())
		}
		var chat chatResponse
		if err := json.NewDecoder(response.Body).Decode(&chat); err != nil {
			t.Fatal(err)
		}
		ids[chat.ID] = true
	}
	if created != 1 || len(ids) != 1 || len(st.ListChats(ws.ID)) != 1 {
		t.Fatalf("created=%d ids=%v chats=%+v", created, ids, st.ListChats(ws.ID))
	}
	entries, err := os.ReadDir(filepath.Join(st.StateDir(), "adopted"))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("adopted entries = %v", entries)
	}
}

func TestAdoptWorkspaceSessionSourceFailuresHaveTyped4xxCodes(t *testing.T) {
	tests := []struct {
		name       string
		mutate     func(*testing.T, string)
		wantStatus int
		wantCode   adoptcopy.Kind
	}{
		{
			name: "oversized",
			mutate: func(t *testing.T, path string) {
				if err := os.Truncate(path, adoptcopy.MaxSourceBytes+1); err != nil {
					t.Fatal(err)
				}
			},
			wantStatus: http.StatusRequestEntityTooLarge,
			wantCode:   adoptcopy.KindTooLarge,
		},
		{
			name: "torn complete record",
			mutate: func(t *testing.T, path string) {
				file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
				if err != nil {
					t.Fatal(err)
				}
				if _, err := file.WriteString("{\"type\":\"message\",\"id\":\"torn\"\n"); err != nil {
					file.Close()
					t.Fatal(err)
				}
				if err := file.Close(); err != nil {
					t.Fatal(err)
				}
			},
			wantStatus: http.StatusUnprocessableEntity,
			wantCode:   adoptcopy.KindInvalidSource,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s, _, ws := newChatCreateTestServer(t)
			agentDir := t.TempDir()
			t.Setenv("OMO_CODING_AGENT_DIR", agentDir)
			source := writeAdoptableDiskSession(t, agentDir, ws.Path, "durable-error", "")
			tt.mutate(t, source)

			response := adoptWorkspaceSession(t, s, ws.ID, map[string]string{"resumeIdentity": source})
			if response.Code != tt.wantStatus {
				t.Fatalf("status %d: %s", response.Code, response.Body.String())
			}
			var payload adoptionErrorResponse
			if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
				t.Fatal(err)
			}
			if payload.Code != tt.wantCode {
				t.Fatalf("code = %q, want %q", payload.Code, tt.wantCode)
			}
		})
	}
}

func TestAdoptedChatRemainsUsableWhenSourceDisappears(t *testing.T) {
	s, st, ws := newChatCreateTestServer(t)
	agentDir := t.TempDir()
	t.Setenv("OMO_CODING_AGENT_DIR", agentDir)
	source := writeAdoptableDiskSession(t, agentDir, ws.Path, "durable-3", "")
	response := adoptWorkspaceSession(t, s, ws.ID, map[string]string{"id": "durable-3"})
	if response.Code != http.StatusCreated {
		t.Fatalf("status %d: %s", response.Code, response.Body.String())
	}
	chat := st.ListChats(ws.ID)[0]
	if err := os.Remove(source); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(chat.SessionFile); err != nil {
		t.Fatalf("owned copy disappeared with source: %v", err)
	}
	page := listWorkspaceSessions(t, s, ws.ID, "")
	if len(page.Items) != 1 || page.Items[0].ID != chat.ID || page.Items[0].Dangling {
		t.Fatalf("catalog after source removal = %+v", page.Items)
	}
}
