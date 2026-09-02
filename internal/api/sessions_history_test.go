package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/cursorstore"
)

func writeDiskSession(t *testing.T, agentDir, cwd, id, name string, at time.Time) string {
	t.Helper()
	dir := filepath.Join(agentDir, "sessions", sessionDirNameForCwd(cwd))
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, id+".jsonl")
	body := fmt.Sprintf("{\"type\":\"session\",\"id\":%q,\"timestamp\":%q}\n", id, at.Format(time.RFC3339Nano))
	if name != "" {
		body += fmt.Sprintf("{\"type\":\"session_info\",\"name\":%q}\n", name)
	}
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}
func listWorkspaceSessions(t *testing.T, s *Server, wsID, q string) sessionHistoryPage {
	t.Helper()
	r := httptest.NewRequest(http.MethodGet, "/?"+q, nil)
	r.SetPathValue("wsId", wsID)
	w := httptest.NewRecorder()
	s.handleListWorkspaceSessions(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("status %d: %s", w.Code, w.Body.String())
	}
	var page sessionHistoryPage
	if err := json.NewDecoder(w.Body).Decode(&page); err != nil {
		t.Fatal(err)
	}
	return page
}
func TestSessionDirNameForCwdMatchesOmoLayout(t *testing.T) {
	if got := sessionDirNameForCwd("/Volumes/storage/workspace/omo-webchat"); got != "--Volumes-storage-workspace-omo-webchat--" {
		t.Fatal(got)
	}
}
func TestListWorkspaceSessionsUsesCursorRowsAndColdDiskScan(t *testing.T) {
	s, st, ws := newChatCreateTestServer(t)
	agent := t.TempDir()
	t.Setenv("OMO_CODING_AGENT_DIR", agent)
	stored := cursorstore.Chat{ID: "chat-1", WorkspaceID: ws.ID, CWD: ws.Path, SessionFile: filepath.Join(t.TempDir(), "missing.jsonl"), Name: "stored", NameSource: "auto", CreatedAt: 20}
	if err := st.SaveChat(stored); err != nil {
		t.Fatal(err)
	}
	diskPath := writeDiskSession(t, agent, ws.Path, "disk-1", "Disk title", time.UnixMilli(10))
	page := listWorkspaceSessions(t, s, ws.ID, "")
	if len(page.Items) != 2 {
		t.Fatalf("items=%+v", page.Items)
	}
	if page.Items[0].ID != "chat-1" || !page.Items[0].Dangling {
		t.Fatalf("stored=%+v", page.Items[0])
	}
	if page.Items[1].ID != "disk-1" || page.Items[1].Name != "Disk title" || page.Items[1].ResumeIdentity != diskPath {
		t.Fatalf("disk=%+v", page.Items[1])
	}
}
func TestListWorkspaceSessionsPaginatesDeterministically(t *testing.T) {
	s, st, ws := newChatCreateTestServer(t)
	for i := 0; i < 7; i++ {
		c := cursorstore.Chat{ID: fmt.Sprintf("c-%d", i), WorkspaceID: ws.ID, CWD: ws.Path, Name: "chat", NameSource: "auto", CreatedAt: int64(i)}
		if err := st.SaveChat(c); err != nil {
			t.Fatal(err)
		}
	}
	first := listWorkspaceSessions(t, s, ws.ID, "")
	if len(first.Items) != 5 || first.NextCursor == "" {
		t.Fatalf("first=%+v", first)
	}
	second := listWorkspaceSessions(t, s, ws.ID, "cursor="+first.NextCursor)
	if len(second.Items) != 2 || second.NextCursor != "" {
		t.Fatalf("second=%+v", second)
	}
}
