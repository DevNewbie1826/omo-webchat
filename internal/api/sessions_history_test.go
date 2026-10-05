package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/cursorstore"
)

// stubSessionClock pins the enrollment clock for the duration of the test.
func stubSessionClock(t *testing.T, at time.Time) {
	t.Helper()
	previous := now
	now = func() time.Time { return at }
	t.Cleanup(func() {
		now = previous
	})
}

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
	if err := os.Chtimes(path, at, at); err != nil {
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
func TestListWorkspaceSessionsDoesNotMigrateLegacyCursor(t *testing.T) {
	s, st, ws := newChatCreateTestServer(t)
	agent := t.TempDir()
	t.Setenv("OMO_CODING_AGENT_DIR", agent)
	source := writeDiskSession(t, agent, ws.Path, "legacy-durable", "Legacy", time.Now())
	chat := cursorstore.Chat{ID: "legacy-chat", WorkspaceID: ws.ID, CWD: ws.Path, SessionFile: source, DurableSessionID: "legacy-durable", Name: "legacy", NameSource: cursorstore.NameSourceAuto}
	if err := st.SaveChat(chat); err != nil {
		t.Fatal(err)
	}
	statePath := filepath.Join(st.StateDir(), "state-v2.json")
	before, err := os.ReadFile(statePath)
	if err != nil {
		t.Fatal(err)
	}

	page := listWorkspaceSessions(t, s, ws.ID, "")
	if len(page.Items) == 0 {
		t.Fatal("legacy chat missing from catalog")
	}
	after, err := os.ReadFile(statePath)
	if err != nil {
		t.Fatal(err)
	}
	if string(after) != string(before) {
		t.Fatal("sessions GET mutated cursor state")
	}
	stored, err := st.GetChat(chat.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.SessionFile != source || stored.SessionProvenance != "" {
		t.Fatalf("sessions GET migrated legacy cursor: %+v", stored)
	}
	if _, err := os.Stat(st.OwnedSessionDir()); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("sessions GET created owned session directory: %v", err)
	}
}

func TestListWorkspaceSessionsUsesOnlyCursorRows(t *testing.T) {
	s, st, ws := newChatCreateTestServer(t)
	agent := t.TempDir()
	t.Setenv("OMO_CODING_AGENT_DIR", agent)
	stored := cursorstore.Chat{ID: "chat-1", WorkspaceID: ws.ID, CWD: ws.Path, SessionFile: filepath.Join(t.TempDir(), "missing.jsonl"), Name: "stored", NameSource: "auto", CreatedAt: 20}
	if err := st.SaveChat(stored); err != nil {
		t.Fatal(err)
	}
	writeDiskSession(t, agent, ws.Path, "disk-1", "Disk title", time.UnixMilli(10))
	page := listWorkspaceSessions(t, s, ws.ID, "")
	if len(page.Items) != 1 {
		t.Fatalf("items=%+v", page.Items)
	}
	if page.Items[0].ID != "chat-1" || !page.Items[0].Dangling {
		t.Fatalf("stored=%+v", page.Items[0])
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
	got, scanned := listDiskSessions(workspaceA)
	if !scanned || len(got) != 0 {
		t.Fatalf("foreign workspace sessions leaked through colliding directory: %+v (scanned=%v)", got, scanned)
	}
}

func TestMergeSessionHistorySuppressesMatchingIdentityForEveryProvenance(t *testing.T) {
	ownedDir := filepath.Join(t.TempDir(), "adopted")
	session := diskSession{ID: "durable", Path: "/catalog/shared.jsonl"}
	tests := []struct {
		name string
		chat cursorstore.Chat
	}{
		{name: "native durable id", chat: cursorstore.Chat{DurableSessionID: session.ID, SessionProvenance: cursorstore.SessionProvenanceNative}},
		{name: "in-place path", chat: cursorstore.Chat{SessionFile: session.Path, SessionProvenance: cursorstore.SessionProvenanceInPlace}},
		{name: "adopted durable id", chat: cursorstore.Chat{DurableSessionID: session.ID, SessionFile: filepath.Join(ownedDir, "owned.jsonl"), SessionProvenance: cursorstore.SessionProvenanceAdopted}},
		{name: "legacy path", chat: cursorstore.Chat{SessionFile: session.Path}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			items := mergeSessionHistory([]cursorstore.Chat{tt.chat}, []diskSession{session})
			if len(items) != 1 || items[0].Source != sessionHistorySourceStored {
				t.Fatalf("merged items = %+v, want only stored row", items)
			}
		})
	}

	unmatched := cursorstore.Chat{SessionFile: filepath.Join(ownedDir, filepath.Base(session.Path)), SessionProvenance: cursorstore.SessionProvenanceAdopted}
	if items := mergeSessionHistory([]cursorstore.Chat{unmatched}, []diskSession{session}); len(items) != 1 || items[0].Source != sessionHistorySourceStored {
		t.Fatalf("unmatched merged items = %+v, want only stored row", items)
	}
}

func TestListWorkspaceSessionsReturnsOneRowForNativeDiskSession(t *testing.T) {
	s, st, ws := newChatCreateTestServer(t)
	agent := t.TempDir()
	t.Setenv("OMO_CODING_AGENT_DIR", agent)
	source := writeDiskSession(t, agent, ws.Path, "native-durable", "Native title", time.Now())
	chat := cursorstore.Chat{ID: "native-chat", WorkspaceID: ws.ID, CWD: ws.Path, SessionFile: source, DurableSessionID: "native-durable", SessionProvenance: cursorstore.SessionProvenanceNative, Name: "Native title", NameSource: cursorstore.NameSourceAuto}
	if err := st.SaveChat(chat); err != nil {
		t.Fatal(err)
	}

	page := listWorkspaceSessions(t, s, ws.ID, "")
	if len(page.Items) != 1 || page.Items[0].ID != chat.ID || page.Items[0].Source != sessionHistorySourceStored {
		t.Fatalf("catalog items = %+v, want one stored native row", page.Items)
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

func TestTakeoverIdentityTransitionMergesDiskSessionIntoStoredRow(t *testing.T) {
	s, st, ws := newChatCreateTestServer(t)
	agent := t.TempDir()
	t.Setenv("OMO_CODING_AGENT_DIR", agent)
	chat := cursorstore.Chat{ID: "chat-takeover", WorkspaceID: ws.ID, CWD: ws.Path, SessionFile: filepath.Join(t.TempDir(), "pending.jsonl"), DurableSessionID: "durable-stale", SessionProvenance: cursorstore.SessionProvenanceNative, Name: "Takeover", NameSource: cursorstore.NameSourceAuto}
	if err := st.SaveChat(chat); err != nil {
		t.Fatal(err)
	}
	source := writeDiskSession(t, agent, ws.Path, "durable-takeover", "Taken over", time.Now())

	// Simulate the in-place takeover: the stored chat's identity is updated to
	// point at the disk session, the same store mutation the open handler's
	// install step performs.
	if err := st.UpdateInPlaceIdentity(chat.ID, source, "durable-takeover"); err != nil {
		t.Fatal(err)
	}

	page := listWorkspaceSessions(t, s, ws.ID, "")
	if len(page.Items) != 1 {
		t.Fatalf("catalog items = %+v, want exactly one merged row", page.Items)
	}
	if item := page.Items[0]; item.ID != chat.ID || item.Source != sessionHistorySourceStored || item.Dangling {
		t.Fatalf("merged row = %+v, want non-dangling stored row", item)
	}
}

func TestAdoptionIdentityTransitionMergesDiskSessionIntoStoredRow(t *testing.T) {
	s, st, ws := newChatCreateTestServer(t)
	agent := t.TempDir()
	t.Setenv("OMO_CODING_AGENT_DIR", agent)
	chat := cursorstore.Chat{ID: "chat-adoption", WorkspaceID: ws.ID, CWD: ws.Path, SessionFile: filepath.Join(t.TempDir(), "pending.jsonl"), DurableSessionID: "durable-stale", SessionProvenance: cursorstore.SessionProvenanceNative, Name: "Adoption", NameSource: cursorstore.NameSourceAuto}
	if err := st.SaveChat(chat); err != nil {
		t.Fatal(err)
	}
	source := writeDiskSession(t, agent, ws.Path, "durable-adopted", "Adopted", time.Now())
	if err := os.MkdirAll(st.OwnedSessionDir(), 0o700); err != nil {
		t.Fatal(err)
	}
	ownedCopy := filepath.Join(st.OwnedSessionDir(), "durable-adopted.jsonl")
	body, err := os.ReadFile(source)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(ownedCopy, body, 0o600); err != nil {
		t.Fatal(err)
	}

	// Simulate the adoption transition: the stored chat is repointed at the
	// verified owned copy of the disk session.
	if err := st.UpdateOwnedIdentity(chat.ID, ownedCopy, "durable-adopted"); err != nil {
		t.Fatal(err)
	}

	page := listWorkspaceSessions(t, s, ws.ID, "")
	if len(page.Items) != 1 {
		t.Fatalf("catalog items = %+v, want exactly one merged row", page.Items)
	}
	if item := page.Items[0]; item.ID != chat.ID || item.Source != sessionHistorySourceStored || item.Dangling {
		t.Fatalf("merged row = %+v, want non-dangling stored row", item)
	}
}

func TestMergeSessionHistoryDoesNotExposeReplacementWithConflictingDurableID(t *testing.T) {
	chats := []cursorstore.Chat{{
		ID: "chat-1", WorkspaceID: "ws-1", CWD: "/w",
		SessionFile:       "/sessions/replacement.jsonl",
		DurableSessionID:  "durable-old",
		SessionProvenance: cursorstore.SessionProvenanceNative,
	}}
	disk := []diskSession{{
		ID: "durable-new", Path: "/sessions/replacement.jsonl", Name: "replacement",
	}}
	items := mergeSessionHistory(chats, disk)
	if len(items) != 1 {
		t.Fatalf("items = %d, want 1 stored row: %+v", len(items), items)
	}
	for _, item := range items {
		if item.Source != sessionHistorySourceStored || item.ID != "chat-1" {
			t.Fatalf("unexpected row = %+v, want stored chat-1", item)
		}
	}
}

func TestMergeSessionHistoryMarksLiveMissingFilePreparing(t *testing.T) {
	chat := cursorstore.Chat{
		ID:          "chat-live",
		CWD:         t.TempDir(),
		SessionFile: filepath.Join(t.TempDir(), "pending.jsonl"),
		Name:        "live",
	}
	live := map[string]struct{}{chat.ID: {}}
	items := mergeSessionHistoryLive([]cursorstore.Chat{chat}, nil, live)
	if len(items) != 1 {
		t.Fatalf("items = %+v, want one stored row", items)
	}
	if item := items[0]; item.Dangling || !item.Preparing || item.Source != sessionHistorySourceStored {
		t.Fatalf("row = %+v, want preparing stored row (dangling=false preparing=true)", item)
	}
}

func TestMergeSessionHistoryMarksMissingFileDanglingWhenNotLive(t *testing.T) {
	chat := cursorstore.Chat{
		ID:          "chat-gone",
		CWD:         t.TempDir(),
		SessionFile: filepath.Join(t.TempDir(), "missing.jsonl"),
		Name:        "gone",
	}
	live := map[string]struct{}{chat.ID: {}}
	items := mergeSessionHistoryLive([]cursorstore.Chat{chat}, nil, live)
	if len(items) != 1 {
		t.Fatalf("items = %+v, want one stored row", items)
	}
	if item := items[0]; item.Dangling || !item.Preparing || item.Source != sessionHistorySourceStored {
		t.Fatalf("row = %+v, want preparing stored row (dangling=false preparing=true)", item)
	}
	delete(live, chat.ID)
	items = mergeSessionHistoryLive([]cursorstore.Chat{chat}, nil, live)
	if len(items) != 1 {
		t.Fatalf("items = %+v, want one stored row", items)
	}
	if item := items[0]; !item.Dangling || item.Preparing || item.Source != sessionHistorySourceStored {
		t.Fatalf("row = %+v, want dangling stored row (dangling=true preparing=false)", item)
	}
}

func TestMergeSessionHistoryMarksDeletedLiveFilePreparing(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "session.jsonl")
	if err := os.WriteFile(path, []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	chat := cursorstore.Chat{
		ID:          "chat-deleted-while-live",
		CWD:         dir,
		SessionFile: path,
		Name:        "deleted-live",
	}
	live := map[string]struct{}{chat.ID: {}}
	present := mergeSessionHistoryLive([]cursorstore.Chat{chat}, nil, live)
	if len(present) != 1 {
		t.Fatalf("items = %+v, want one stored row", present)
	}
	if item := present[0]; item.Dangling || item.Preparing || item.Source != sessionHistorySourceStored {
		t.Fatalf("row = %+v, want settled stored row while the file is present", item)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	// A live session is resumable by definition: the conversation lives in
	// the running engine, which writes the session file on the next persist.
	// A missing file under a live chat therefore means pending persistence,
	// never "the original is gone".
	gone := mergeSessionHistoryLive([]cursorstore.Chat{chat}, nil, live)
	if len(gone) != 1 {
		t.Fatalf("items = %+v, want one stored row", gone)
	}
	if item := gone[0]; item.Dangling || !item.Preparing || item.Source != sessionHistorySourceStored {
		t.Fatalf("row = %+v, want preparing stored row after deletion while live", item)
	}
}
