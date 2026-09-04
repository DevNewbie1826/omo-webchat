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

// stubSessionClock pins the catalog clock for the duration of the test.
func stubSessionClock(t *testing.T, at time.Time) {
	t.Helper()
	previous := now
	now = func() time.Time { return at }
	t.Cleanup(func() { now = previous })
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

func TestListWorkspaceSessionsUsesCursorRowsAndColdDiskScan(t *testing.T) {
	s, st, ws := newChatCreateTestServer(t)
	agent := t.TempDir()
	t.Setenv("OMO_CODING_AGENT_DIR", agent)
	stored := cursorstore.Chat{ID: "chat-1", WorkspaceID: ws.ID, CWD: ws.Path, SessionFile: filepath.Join(t.TempDir(), "missing.jsonl"), Name: "stored", NameSource: "auto", CreatedAt: 20}
	if err := st.SaveChat(stored); err != nil {
		t.Fatal(err)
	}
	diskPath := writeDiskSession(t, agent, ws.Path, "disk-1", "Disk title", time.UnixMilli(10))
	// The file is created fresh by the helper but represents an old session;
	// backdate its mtime so it is not mistaken for a lazy first persist.
	aged := time.Now().Add(-2 * DiscoveredStabilityWindow)
	if err := os.Chtimes(diskPath, aged, aged); err != nil {
		t.Fatal(err)
	}
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
	if items := mergeSessionHistory([]cursorstore.Chat{unmatched}, []diskSession{session}); len(items) != 2 || items[1].Source != sessionHistorySourceDiscovered {
		t.Fatalf("unmatched merged items = %+v, want stored and discovered rows", items)
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

func TestMergeSessionHistoryGatesFreshDiscoveredRowsWhileStoredChatDangling(t *testing.T) {
	fixedNow := time.Unix(1_800_000_000, 0)
	stubSessionClock(t, fixedNow)
	owned := filepath.Join(t.TempDir(), "owned.jsonl")
	if err := os.WriteFile(owned, []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	danglingChat := cursorstore.Chat{ID: "chat-dangling", SessionFile: filepath.Join(t.TempDir(), "pending.jsonl")}
	settledChat := cursorstore.Chat{ID: "chat-settled", SessionFile: owned}
	young := diskSession{ID: "disk-young", Path: "/catalog/young.jsonl", Name: "Fresh", ModTime: fixedNow.Add(-time.Second)}
	boundary := diskSession{ID: "disk-boundary", Path: "/catalog/boundary.jsonl", Name: "Boundary", ModTime: fixedNow.Add(-DiscoveredStabilityWindow)}
	old := diskSession{ID: "disk-old", Path: "/catalog/old.jsonl", Name: "Old", ModTime: fixedNow.Add(-DiscoveredStabilityWindow - time.Second)}

	tests := []struct {
		name           string
		chats          []cursorstore.Chat
		disk           []diskSession
		wantDiscovered bool
	}{
		{name: "dangling stored chat hides young disk session", chats: []cursorstore.Chat{danglingChat}, disk: []diskSession{young}, wantDiscovered: false},
		{name: "dangling stored chat shows disk session at window boundary", chats: []cursorstore.Chat{danglingChat}, disk: []diskSession{boundary}, wantDiscovered: true},
		{name: "dangling stored chat shows disk session aged past window", chats: []cursorstore.Chat{danglingChat}, disk: []diskSession{old}, wantDiscovered: true},
		{name: "settled stored chat shows young disk session", chats: []cursorstore.Chat{settledChat}, disk: []diskSession{young}, wantDiscovered: true},
		{name: "no stored chat shows young disk session", chats: nil, disk: []diskSession{young}, wantDiscovered: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			items := mergeSessionHistory(tt.chats, tt.disk)
			discovered := 0
			for _, item := range items {
				if item.Source == sessionHistorySourceDiscovered {
					discovered++
				}
			}
			if (discovered > 0) != tt.wantDiscovered || discovered > 1 {
				t.Fatalf("discovered rows = %d, wantDiscovered = %v: %+v", discovered, tt.wantDiscovered, items)
			}
		})
	}

	t.Run("aging past the window exposes the session without sleeping", func(t *testing.T) {
		now = func() time.Time { return fixedNow.Add(2 * DiscoveredStabilityWindow) }
		items := mergeSessionHistory([]cursorstore.Chat{danglingChat}, []diskSession{young})
		if len(items) != 2 || items[0].Source != sessionHistorySourceStored || items[1].Source != sessionHistorySourceDiscovered {
			t.Fatalf("aged items = %+v, want stored row and discovered row", items)
		}
	})
}

func TestListWorkspaceSessionsGatesFreshDiskSessionWhileStoredChatDangling(t *testing.T) {
	s, st, ws := newChatCreateTestServer(t)
	agent := t.TempDir()
	t.Setenv("OMO_CODING_AGENT_DIR", agent)
	stored := cursorstore.Chat{ID: "chat-1", WorkspaceID: ws.ID, CWD: ws.Path, SessionFile: filepath.Join(t.TempDir(), "pending.jsonl"), Name: "stored", NameSource: "auto", CreatedAt: 20}
	if err := st.SaveChat(stored); err != nil {
		t.Fatal(err)
	}
	diskPath := writeDiskSession(t, agent, ws.Path, "disk-1", "Disk title", time.UnixMilli(10))

	page := listWorkspaceSessions(t, s, ws.ID, "")
	if len(page.Items) != 1 || page.Items[0].ID != "chat-1" || !page.Items[0].Dangling {
		t.Fatalf("young disk session must stay hidden while the stored chat dangles: %+v", page.Items)
	}

	aged := time.Now().Add(-2 * DiscoveredStabilityWindow)
	if err := os.Chtimes(diskPath, aged, aged); err != nil {
		t.Fatal(err)
	}
	page = listWorkspaceSessions(t, s, ws.ID, "")
	if len(page.Items) != 2 || page.Items[1].ID != "disk-1" || page.Items[1].Source != sessionHistorySourceDiscovered {
		t.Fatalf("aged disk session must be discovered: %+v", page.Items)
	}
}

func TestListWorkspaceSessionsShowsFreshDiskSessionWithoutDanglingStoredChat(t *testing.T) {
	s, st, ws := newChatCreateTestServer(t)
	agent := t.TempDir()
	t.Setenv("OMO_CODING_AGENT_DIR", agent)
	owned := filepath.Join(t.TempDir(), "owned.jsonl")
	if err := os.WriteFile(owned, []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	settled := cursorstore.Chat{ID: "chat-settled", WorkspaceID: ws.ID, CWD: ws.Path, SessionFile: owned, Name: "settled", NameSource: "auto", CreatedAt: 20}
	if err := st.SaveChat(settled); err != nil {
		t.Fatal(err)
	}
	writeDiskSession(t, agent, ws.Path, "disk-fresh", "Fresh disk", time.Now())

	page := listWorkspaceSessions(t, s, ws.ID, "")
	if len(page.Items) != 2 {
		t.Fatalf("items = %+v, want settled stored row and fresh discovered row", page.Items)
	}
	var fresh *sessionHistoryItem
	for i := range page.Items {
		if page.Items[i].ID == "disk-fresh" {
			fresh = &page.Items[i]
		}
	}
	if fresh == nil || fresh.Source != sessionHistorySourceDiscovered {
		t.Fatalf("fresh disk row missing or wrong source: %+v", page.Items)
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

func TestMergeSessionHistoryKeepsReplacementSessionWithConflictingDurableID(t *testing.T) {
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
	if len(items) != 2 {
		t.Fatalf("items = %d, want 2 (stored row + discovered replacement): %+v", len(items), items)
	}
	for _, item := range items {
		if item.Source == sessionHistorySourceDiscovered && item.ID != "durable-new" {
			t.Fatalf("discovered row id = %q, want durable-new", item.ID)
		}
	}
}
