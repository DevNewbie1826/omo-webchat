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
	body := fmt.Sprintf("{\"type\":\"session\",\"id\":%q,\"timestamp\":%q,\"cwd\":%q}\n", id, at.Format(time.RFC3339Nano), cwd)
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
func TestListDiskSessionsRejectsCollidingDirectoryFromAnotherWorkspace(t *testing.T) {
	agent := t.TempDir()
	t.Setenv("OMO_CODING_AGENT_DIR", agent)
	base := t.TempDir()
	workspaceA := filepath.Join(base, "a-b", "c")
	workspaceB := filepath.Join(base, "a", "b-c")
	if err := os.MkdirAll(workspaceA, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(workspaceB, 0o700); err != nil {
		t.Fatal(err)
	}
	if sessionDirNameForCwd(workspaceA) != sessionDirNameForCwd(workspaceB) {
		t.Fatal("test paths do not reproduce the non-injective directory encoding")
	}
	writeDiskSession(t, agent, workspaceB, "foreign", "Foreign", time.Now())
	if got := listDiskSessions(workspaceA); len(got) != 0 {
		t.Fatalf("foreign workspace sessions leaked through colliding directory: %+v", got)
	}
}

func TestMergeSessionHistoryRequiresOwnedProvenanceAndExactIdentity(t *testing.T) {
	ownedDir := filepath.Join(t.TempDir(), "adopted")
	session := diskSession{ID: "durable", Path: "/catalog/shared.jsonl"}
	tests := []struct {
		name string
		chat cursorstore.Chat
		want string
	}{
		{
			name: "legacy exact durable id is not ownership",
			chat: cursorstore.Chat{DurableSessionID: session.ID, SessionFile: session.Path},
			want: sessionHistorySourceDiscovered,
		},
		{
			name: "owned copy with basename only does not match",
			chat: cursorstore.Chat{SessionFile: filepath.Join(ownedDir, filepath.Base(session.Path)), SessionProvenance: cursorstore.SessionProvenanceAdopted},
			want: sessionHistorySourceDiscovered,
		},
		{
			name: "owned copy with exact durable id marks source",
			chat: cursorstore.Chat{DurableSessionID: session.ID, SessionFile: filepath.Join(ownedDir, "owned.jsonl"), SessionProvenance: cursorstore.SessionProvenanceAdopted},
			want: sessionHistorySourceAlreadyAdopted,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			items := mergeSessionHistory([]cursorstore.Chat{tt.chat}, []diskSession{session}, ownedDir)
			if len(items) != 2 || items[1].Source != tt.want {
				t.Fatalf("merged items = %+v, want disk source %q", items, tt.want)
			}
		})
	}
}

func TestListWorkspaceSessionsNormalizesMixedResolutionAcrossPages(t *testing.T) {
	s, st, ws := newChatCreateTestServer(t)
	fixtures := []cursorstore.Chat{
		{ID: "seconds-newest", CreatedAt: 1_700_000_500},
		{ID: "millis-2", CreatedAt: 1_700_000_400_000},
		{ID: "seconds-3", CreatedAt: 1_700_000_300},
		{ID: "millis-4", CreatedAt: 1_700_000_200_000},
		{ID: "seconds-5", CreatedAt: 1_700_000_100},
		{ID: "millis-oldest", CreatedAt: 1_700_000_000_000},
	}
	for _, chat := range fixtures {
		chat.WorkspaceID, chat.CWD, chat.Name, chat.NameSource = ws.ID, ws.Path, chat.ID, cursorstore.NameSourceAuto
		if err := st.SaveChat(chat); err != nil {
			t.Fatal(err)
		}
	}

	first := listWorkspaceSessions(t, s, ws.ID, "")
	if len(first.Items) != 5 || first.NextCursor == "" {
		t.Fatalf("first page = %+v", first)
	}
	for i, want := range []string{"seconds-newest", "millis-2", "seconds-3", "millis-4", "seconds-5"} {
		if first.Items[i].ID != want {
			t.Fatalf("first page item %d = %s, want %s", i, first.Items[i].ID, want)
		}
	}
	if first.Items[0].RecencyMs != 1_700_000_500_000 || first.Items[4].RecencyMs != 1_700_000_100_000 {
		t.Fatalf("normalized recencies = %d ... %d", first.Items[0].RecencyMs, first.Items[4].RecencyMs)
	}
	second := listWorkspaceSessions(t, s, ws.ID, "cursor="+first.NextCursor)
	if len(second.Items) != 1 || second.Items[0].ID != "millis-oldest" || second.NextCursor != "" {
		t.Fatalf("second page = %+v", second)
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
