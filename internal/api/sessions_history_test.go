package api

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/auth"
	"github.com/DevNewbie1826/omo-webchat/internal/config"
	"github.com/DevNewbie1826/omo-webchat/internal/cursorstore"
	"github.com/DevNewbie1826/omo-webchat/internal/store"
)

func newSessionHistoryTestServer(t *testing.T) (*Server, *store.Store, store.Workspace, string) {
	t.Helper()
	home := t.TempDir()
	agent := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("OMO_CODING_AGENT_DIR", agent)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	st, err := store.Load(context.Background(), logger)
	if err != nil {
		t.Fatalf("load store: %v", err)
	}
	ws, err := st.CreateWorkspace("demo", home)
	if err != nil {
		t.Fatalf("create workspace: %v", err)
	}
	srv := New(context.Background(), &config.Config{Root: home}, st, auth.NewSessionStore(context.Background(), "pw", logger), logger)
	return srv, st, ws, agent
}

func writeDiskSession(t *testing.T, agentDir, cwd, id, name string, mtime time.Time) string {
	t.Helper()
	dir := filepath.Join(agentDir, "sessions", sessionDirNameForCwd(cwd))
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatalf("mkdir sessions: %v", err)
	}
	stamp := mtime.UTC().Format("2006-01-02T15-04-05-000Z")
	path := filepath.Join(dir, stamp+"_"+id+".jsonl")
	body := fmt.Sprintf("{\"type\":\"session\",\"version\":3,\"id\":%q,\"timestamp\":%q,\"cwd\":%q}\n", id, mtime.UTC().Format(time.RFC3339Nano), cwd)
	if name != "" {
		body += fmt.Sprintf("{\"type\":\"session_info\",\"name\":%q}\n", name)
	}
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("write session: %v", err)
	}
	if err := os.Chtimes(path, mtime, mtime); err != nil {
		t.Fatalf("chtimes: %v", err)
	}
	return path
}

func listWorkspaceSessions(t *testing.T, srv *Server, wsID, rawQuery string) *httptest.ResponseRecorder {
	t.Helper()
	target := "/api/workspaces/" + wsID + "/sessions"
	if rawQuery != "" {
		target += "?" + rawQuery
	}
	req := httptest.NewRequest(http.MethodGet, target, nil)
	req.SetPathValue("wsId", wsID)
	rec := httptest.NewRecorder()
	srv.handleListWorkspaceSessions(rec, req)
	return rec
}

func decodeSessionHistoryPage(t *testing.T, rec *httptest.ResponseRecorder) sessionHistoryPage {
	t.Helper()
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body: %s", rec.Code, http.StatusOK, rec.Body.String())
	}
	var page sessionHistoryPage
	if err := json.NewDecoder(rec.Body).Decode(&page); err != nil {
		t.Fatalf("decode page: %v", err)
	}
	if page.Items == nil {
		t.Fatal("items is null, want an array")
	}
	return page
}

func TestSessionDirNameForCwdMatchesOmoLayout(t *testing.T) {
	tests := []struct {
		cwd  string
		want string
	}{
		{cwd: "/Volumes/storage/workspace/cli-webchat", want: "--Volumes-storage-workspace-cli-webchat--"},
		{cwd: "/Users/mirage/.omo", want: "--Users-mirage-.omo--"},
		{cwd: "/private/tmp/qa-st-wsroot", want: "--private-tmp-qa-st-wsroot--"},
	}
	for _, test := range tests {
		got := sessionDirNameForCwd(test.cwd)
		if got != test.want {
			t.Errorf("sessionDirNameForCwd(%q) = %q, want %q", test.cwd, got, test.want)
			continue
		}
		t.Logf("sessionDirNameForCwd(%q) = %q", test.cwd, got)
	}
}

func TestListWorkspaceSessionsUnionsCursorChatsWithStoredChatsWinningConflicts(t *testing.T) {
	srv, st, ws, _ := newSessionHistoryTestServer(t)
	stored, err := st.NewChat(ws.ID, "stored name", ws.Path, "", "omo")
	if err != nil {
		t.Fatal(err)
	}
	cursors, err := cursorstore.Open(filepath.Join(t.TempDir(), "v2.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := cursors.SaveWorkspace(cursorstore.Workspace{ID: ws.ID, Name: ws.Name, Path: ws.Path}); err != nil {
		t.Fatal(err)
	}
	for _, c := range []cursorstore.Chat{
		{ID: stored.ID, WorkspaceID: ws.ID, CWD: ws.Path, Name: "cursor must lose", CreatedAt: stored.CreatedAt + 1},
		{ID: "v2-only", WorkspaceID: ws.ID, CWD: ws.Path, Name: "cursor name", CreatedAt: stored.CreatedAt + 2},
	} {
		if err := cursors.SaveChat(c); err != nil {
			t.Fatal(err)
		}
	}
	srv.installV2(nil, cursors, nil)

	page := decodeSessionHistoryPage(t, listWorkspaceSessions(t, srv, ws.ID, ""))
	if len(page.Items) != 2 {
		t.Fatalf("items = %+v, want stored+cursor union", page.Items)
	}
	byID := make(map[string]sessionHistoryItem, len(page.Items))
	for _, item := range page.Items {
		byID[item.ID] = item
	}
	if got := byID[stored.ID].Name; got != "stored name" {
		t.Fatalf("overlap name = %q, want stored name", got)
	}
	if got := byID["v2-only"].Name; got != "cursor name" {
		t.Fatalf("cursor-only name = %q, want cursor name", got)
	}
}

func TestListWorkspaceSessionsEmptyCursorStorePreservesLegacyResult(t *testing.T) {
	srv, st, ws, _ := newSessionHistoryTestServer(t)
	stored, err := st.NewChat(ws.ID, "legacy", ws.Path, "", "omo")
	if err != nil {
		t.Fatal(err)
	}
	before := decodeSessionHistoryPage(t, listWorkspaceSessions(t, srv, ws.ID, ""))
	cursors, err := cursorstore.Open(filepath.Join(t.TempDir(), "v2.json"))
	if err != nil {
		t.Fatal(err)
	}
	srv.installV2(nil, cursors, nil)
	after := decodeSessionHistoryPage(t, listWorkspaceSessions(t, srv, ws.ID, ""))
	if len(after.Items) != 1 || after.Items[0] != before.Items[0] || after.Items[0].ID != stored.ID {
		t.Fatalf("with empty cursorstore = %+v, before = %+v", after, before)
	}
}

func TestListWorkspaceSessionsEmptyDirectory(t *testing.T) {
	srv, _, ws, _ := newSessionHistoryTestServer(t)

	page := decodeSessionHistoryPage(t, listWorkspaceSessions(t, srv, ws.ID, ""))
	if len(page.Items) != 0 {
		t.Fatalf("items = %+v, want empty", page.Items)
	}
	if page.NextCursor != "" {
		t.Fatalf("nextCursor = %q, want empty", page.NextCursor)
	}
}

func TestListWorkspaceSessionsPaginatesNewestFirst(t *testing.T) {
	srv, _, ws, agent := newSessionHistoryTestServer(t)
	base := time.Now().Add(-time.Hour).UTC().Truncate(time.Second)
	const total = 7
	for i := 1; i <= total; i++ {
		id := fmt.Sprintf("sess-%d", i)
		writeDiskSession(t, agent, ws.Path, id, "Session "+id, base.Add(time.Duration(i)*time.Second))
	}

	first := decodeSessionHistoryPage(t, listWorkspaceSessions(t, srv, ws.ID, ""))
	if len(first.Items) > 5 {
		t.Fatalf("first page len = %d, want at most 5", len(first.Items))
	}
	if len(first.Items) != 5 {
		t.Fatalf("first page len = %d, want 5", len(first.Items))
	}
	if first.NextCursor == "" {
		t.Fatal("first page nextCursor is empty, want a continuation token")
	}
	for i, item := range first.Items {
		wantID := fmt.Sprintf("sess-%d", total-i)
		if item.ID != wantID {
			t.Fatalf("first[%d].id = %q, want %q", i, item.ID, wantID)
		}
		if item.Name != "Session "+wantID {
			t.Fatalf("first[%d].name = %q, want %q", i, item.Name, "Session "+wantID)
		}
		if item.Source != sessionHistorySourceDiscovered {
			t.Fatalf("first[%d].source = %q, want %q", i, item.Source, sessionHistorySourceDiscovered)
		}
		if item.ResumeIdentity == "" {
			t.Fatalf("first[%d].resumeIdentity is empty", i)
		}
		if i > 0 && item.RecencyMs > first.Items[i-1].RecencyMs {
			t.Fatalf("first page is not newest-first: %+v", first.Items)
		}
	}

	q := url.Values{}
	q.Set("cursor", first.NextCursor)
	second := decodeSessionHistoryPage(t, listWorkspaceSessions(t, srv, ws.ID, q.Encode()))
	if len(second.Items) != 2 {
		t.Fatalf("second page len = %d, want 2; items=%+v", len(second.Items), second.Items)
	}
	if second.NextCursor != "" {
		t.Fatalf("second page nextCursor = %q, want empty", second.NextCursor)
	}
	if second.Items[0].ID != "sess-2" || second.Items[1].ID != "sess-1" {
		t.Fatalf("second page ids = [%s %s], want [sess-2 sess-1]", second.Items[0].ID, second.Items[1].ID)
	}
	if second.Items[0].Name != "Session sess-2" || second.Items[1].Name != "Session sess-1" {
		t.Fatalf("second page names = [%q %q], want [Session sess-2 Session sess-1]", second.Items[0].Name, second.Items[1].Name)
	}
	if second.Items[0].RecencyMs > first.Items[len(first.Items)-1].RecencyMs {
		t.Fatalf("second page is not after first: first last=%d second first=%d", first.Items[len(first.Items)-1].RecencyMs, second.Items[0].RecencyMs)
	}
}

func TestListWorkspaceSessionsClampsOversizedLimitToFive(t *testing.T) {
	srv, _, ws, agent := newSessionHistoryTestServer(t)
	base := time.Now().Add(-time.Hour).UTC().Truncate(time.Second)
	for i := 0; i < 8; i++ {
		id := fmt.Sprintf("sess-%d", i)
		writeDiskSession(t, agent, ws.Path, id, id, base.Add(time.Duration(i)*time.Second))
	}

	page := decodeSessionHistoryPage(t, listWorkspaceSessions(t, srv, ws.ID, "limit=50"))
	if len(page.Items) != sessionHistoryMaxLimit {
		t.Fatalf("oversized limit returned %d items, want %d", len(page.Items), sessionHistoryMaxLimit)
	}
	if page.NextCursor == "" {
		t.Fatal("nextCursor is empty with more entries remaining")
	}
}

func TestListWorkspaceSessionsMutationBetweenPagesDoesNotLoseEntry(t *testing.T) {
	srv, _, ws, agent := newSessionHistoryTestServer(t)
	base := time.Now().Add(-time.Hour).UTC().Truncate(time.Second)
	paths := make(map[string]string)
	for i := 1; i <= 7; i++ {
		id := fmt.Sprintf("sess-%d", i)
		paths[id] = writeDiskSession(t, agent, ws.Path, id, id, base.Add(time.Duration(i)*time.Second))
	}

	first := decodeSessionHistoryPage(t, listWorkspaceSessions(t, srv, ws.ID, "limit=5"))
	if len(first.Items) != 5 || first.NextCursor == "" {
		t.Fatalf("first page = %+v, cursor %q; want five items and a cursor", first.Items, first.NextCursor)
	}
	f, err := os.OpenFile(paths["sess-1"], os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatalf("open not-yet-listed session: %v", err)
	}
	if _, err := f.WriteString("{\"type\":\"session_info\",\"name\":\"mutated\"}\n"); err != nil {
		f.Close()
		t.Fatalf("mutate not-yet-listed session: %v", err)
	}
	if err := f.Close(); err != nil {
		t.Fatalf("close mutated session: %v", err)
	}

	q := url.Values{"cursor": {first.NextCursor}, "limit": {"5"}}
	second := decodeSessionHistoryPage(t, listWorkspaceSessions(t, srv, ws.ID, q.Encode()))
	if len(second.Items) != 2 {
		t.Fatalf("second page = %+v, want two remaining entries", second.Items)
	}
	if second.Items[0].ID != "sess-2" || second.Items[1].ID != "sess-1" {
		t.Fatalf("second page ids = [%s %s], want [sess-2 sess-1]", second.Items[0].ID, second.Items[1].ID)
	}
	if second.NextCursor != "" {
		t.Fatalf("second page nextCursor = %q, want empty", second.NextCursor)
	}
}

func TestListWorkspaceSessionsBackToBackChatsAreStrictlyNewestFirst(t *testing.T) {
	srv, st, ws, _ := newSessionHistoryTestServer(t)
	const total = 7
	created := make([]store.Chat, 0, total)
	for i := 0; i < total; i++ {
		chat, err := st.NewChat(ws.ID, fmt.Sprintf("chat-%d", i), ws.Path, "", "omo")
		if err != nil {
			t.Fatalf("create chat-%d: %v", i, err)
		}
		created = append(created, chat)
	}
	for i := 1; i < len(created); i++ {
		if created[i].CreatedAt <= created[i-1].CreatedAt {
			t.Fatalf("createdAt values are not distinct and increasing: %+v", created)
		}
	}

	var names []string
	cursor := ""
	for {
		q := url.Values{"limit": {"3"}}
		if cursor != "" {
			q.Set("cursor", cursor)
		}
		page := decodeSessionHistoryPage(t, listWorkspaceSessions(t, srv, ws.ID, q.Encode()))
		for _, item := range page.Items {
			names = append(names, item.Name)
		}
		if page.NextCursor == "" {
			break
		}
		cursor = page.NextCursor
	}
	if len(names) != total {
		t.Fatalf("paged names = %v, want %d entries", names, total)
	}
	for i, name := range names {
		want := fmt.Sprintf("chat-%d", total-1-i)
		if name != want {
			t.Fatalf("paged names = %v; index %d = %q, want %q", names, i, name, want)
		}
	}
}

func TestListWorkspaceSessionsIncludesStoredChatWithoutSessionFile(t *testing.T) {
	srv, st, ws, agent := newSessionHistoryTestServer(t)
	chat, err := st.NewChat(ws.ID, "never-prompted", ws.Path, "", "omo")
	if err != nil {
		t.Fatalf("create stored chat: %v", err)
	}
	mtime := time.Now().Add(-time.Minute).UTC().Truncate(time.Second)
	writeDiskSession(t, agent, ws.Path, "orphan-disk", "From disk", mtime)

	page := decodeSessionHistoryPage(t, listWorkspaceSessions(t, srv, ws.ID, ""))
	var stored, discovered *sessionHistoryItem
	for i := range page.Items {
		item := &page.Items[i]
		switch item.ID {
		case chat.ID:
			stored = item
		case "orphan-disk":
			discovered = item
		}
	}
	if stored == nil {
		t.Fatalf("stored chat %q missing from %+v", chat.ID, page.Items)
	}
	if stored.Name != "never-prompted" {
		t.Fatalf("stored name = %q, want never-prompted", stored.Name)
	}
	if stored.Source != sessionHistorySourceStored {
		t.Fatalf("stored source = %q, want %q", stored.Source, sessionHistorySourceStored)
	}
	if stored.RecencyMs != chat.CreatedAt {
		t.Fatalf("stored recencyMs = %d, want %d", stored.RecencyMs, chat.CreatedAt)
	}
	if discovered == nil {
		t.Fatalf("discovered session missing from %+v", page.Items)
	}
}

func TestListWorkspaceSessionsMergesStoredChatWithDiskSession(t *testing.T) {
	srv, st, ws, agent := newSessionHistoryTestServer(t)
	mtime := time.Now().Add(-2 * time.Minute).UTC().Truncate(time.Second)
	path := writeDiskSession(t, agent, ws.Path, "mapped-session", "Disk title", mtime)
	chat, err := st.NewChat(ws.ID, "UI title", ws.Path, "", "omo")
	if err != nil {
		t.Fatalf("create stored chat: %v", err)
	}
	if _, err := st.UpdateChat(ws.ID, chat.ID, func(c *store.Chat) {
		c.PiSessionID = path
	}); err != nil {
		t.Fatalf("attach pi session: %v", err)
	}

	page := decodeSessionHistoryPage(t, listWorkspaceSessions(t, srv, ws.ID, ""))
	if len(page.Items) != 1 {
		t.Fatalf("items = %+v, want a single merged entry", page.Items)
	}
	got := page.Items[0]
	if got.ID != chat.ID {
		t.Fatalf("id = %q, want stored chat %q", got.ID, chat.ID)
	}
	if got.Name != "UI title" {
		t.Fatalf("name = %q, want stored display name", got.Name)
	}
	if got.Source != sessionHistorySourceStored {
		t.Fatalf("source = %q, want %q", got.Source, sessionHistorySourceStored)
	}
}

func TestListWorkspaceSessionsSkipsOversizedLineAndContinues(t *testing.T) {
	srv, _, ws, agent := newSessionHistoryTestServer(t)
	mtime := time.Now().Add(-time.Minute).UTC().Truncate(time.Second)
	path := writeDiskSession(t, agent, ws.Path, "large-line", "Before large line", mtime)
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatalf("open session: %v", err)
	}
	oversized := `{"type":"message","payload":"` + strings.Repeat("x", sessionHistoryMaxJSONLLine) + `"}` + "\n"
	if _, err := f.WriteString(oversized + `{"type":"session_info","name":"After large line"}` + "\n"); err != nil {
		f.Close()
		t.Fatalf("append session records: %v", err)
	}
	if err := f.Close(); err != nil {
		t.Fatalf("close session: %v", err)
	}

	page := decodeSessionHistoryPage(t, listWorkspaceSessions(t, srv, ws.ID, ""))
	if len(page.Items) != 1 {
		t.Fatalf("items = %+v, want one session", page.Items)
	}
	if page.Items[0].ID != "large-line" || page.Items[0].Name != "After large line" {
		t.Fatalf("item = %+v, want oversized record skipped and following name retained", page.Items[0])
	}
}

func TestReadJSONLLineBoundsOversizedRecord(t *testing.T) {
	input := strings.Repeat("x", sessionHistoryMaxJSONLLine+1) + "\nnext\n"
	reader := bufio.NewReaderSize(strings.NewReader(input), 4096)

	line, tooLong, err := readJSONLLine(reader)
	if err != nil {
		t.Fatalf("read oversized record: %v", err)
	}
	if !tooLong || len(line) != 0 {
		t.Fatalf("oversized record = (%d bytes, tooLong %t), want (0 bytes, true)", len(line), tooLong)
	}
	line, tooLong, err = readJSONLLine(reader)
	if err != nil {
		t.Fatalf("read following record: %v", err)
	}
	if tooLong || string(line) != "next" {
		t.Fatalf("following record = (%q, tooLong %t), want (next, false)", line, tooLong)
	}
}

func TestListWorkspaceSessionsSkipsUnreadableFile(t *testing.T) {
	srv, _, ws, agent := newSessionHistoryTestServer(t)
	mtime := time.Now().Add(-time.Minute).UTC().Truncate(time.Second)
	writeDiskSession(t, agent, ws.Path, "readable", "Readable", mtime)
	dir := filepath.Join(agent, "sessions", sessionDirNameForCwd(ws.Path))
	bad := filepath.Join(dir, "unreadable.jsonl")
	if err := os.WriteFile(bad, []byte("not-a-session\n"), 0o000); err != nil {
		t.Fatalf("write unreadable: %v", err)
	}
	t.Cleanup(func() { _ = os.Chmod(bad, 0o600) })
	corrupt := filepath.Join(dir, "corrupt.jsonl")
	if err := os.WriteFile(corrupt, []byte("{not-json\n"), 0o600); err != nil {
		t.Fatalf("write corrupt: %v", err)
	}

	page := decodeSessionHistoryPage(t, listWorkspaceSessions(t, srv, ws.ID, ""))
	if len(page.Items) != 1 || page.Items[0].ID != "readable" {
		t.Fatalf("items = %+v, want only the readable session", page.Items)
	}
}

// TestListWorkspaceSessionsStoredRecencyPrefersLastUsedOverCreation pins the
// stored-row recency key: a chat's last use outranks its creation time, so a
// freshly used old chat sorts above a never-used newer chat. A row without a
// last-used stamp keeps its creation-time recency.
func TestListWorkspaceSessionsDerivesDiscoveredNameFromFirstUserMessage(t *testing.T) {
	srv, _, ws, agent := newSessionHistoryTestServer(t)
	mtime := time.Now().Add(-time.Minute).UTC().Truncate(time.Second)
	path := writeDiskSession(t, agent, ws.Path, "ghost-unnamed", "", mtime)
	const prompt = "이 프로젝트가 뭐였지?"
	appendDiskSessionLines(t, path,
		`{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"ignore me"}]}}`,
		fmt.Sprintf(`{"type":"message","message":{"role":"user","content":[{"type":"text","text":%q}]}}`, prompt),
		`{"type":"message","message":{"role":"user","content":[{"type":"text","text":"second prompt must not win"}]}}`,
	)

	page := decodeSessionHistoryPage(t, listWorkspaceSessions(t, srv, ws.ID, ""))
	if len(page.Items) != 1 {
		t.Fatalf("items = %+v, want one discovered session", page.Items)
	}
	got := page.Items[0]
	if got.ID != "ghost-unnamed" {
		t.Fatalf("id = %q, want ghost-unnamed", got.ID)
	}
	if got.Source != sessionHistorySourceDiscovered {
		t.Fatalf("source = %q, want %q", got.Source, sessionHistorySourceDiscovered)
	}
	if got.Name != prompt {
		t.Fatalf("name = %q, want derived first-user title %q", got.Name, prompt)
	}
	if got.Dangling {
		t.Fatalf("discovered row set dangling, want omitted/false; item: %+v", got)
	}
}

func TestListWorkspaceSessionsPrefersSessionInfoNameOverUserMessage(t *testing.T) {
	srv, _, ws, agent := newSessionHistoryTestServer(t)
	mtime := time.Now().Add(-time.Minute).UTC().Truncate(time.Second)
	path := writeDiskSession(t, agent, ws.Path, "named-session", "Pinned session name", mtime)
	appendDiskSessionLines(t, path,
		`{"type":"message","message":{"role":"user","content":[{"type":"text","text":"이 프로젝트가 뭐였지?"}]}}`,
	)

	page := decodeSessionHistoryPage(t, listWorkspaceSessions(t, srv, ws.ID, ""))
	if len(page.Items) != 1 {
		t.Fatalf("items = %+v, want one discovered session", page.Items)
	}
	got := page.Items[0]
	if got.ID != "named-session" {
		t.Fatalf("id = %q, want named-session", got.ID)
	}
	if got.Name != "Pinned session name" {
		t.Fatalf("name = %q, want session_info name to win over later user text", got.Name)
	}
}

func TestListWorkspaceSessionsSlashCommandFirstPromptLeavesDiscoveredNameEmpty(t *testing.T) {
	srv, _, ws, agent := newSessionHistoryTestServer(t)
	mtime := time.Now().Add(-time.Minute).UTC().Truncate(time.Second)
	path := writeDiskSession(t, agent, ws.Path, "slash-prompt", "", mtime)
	appendDiskSessionLines(t, path,
		`{"type":"message","message":{"role":"user","content":[{"type":"text","text":"/model gpt"}]}}`,
	)

	page := decodeSessionHistoryPage(t, listWorkspaceSessions(t, srv, ws.ID, ""))
	if len(page.Items) != 1 {
		t.Fatalf("items = %+v, want one discovered session", page.Items)
	}
	got := page.Items[0]
	if got.ID != "slash-prompt" {
		t.Fatalf("id = %q, want slash-prompt", got.ID)
	}
	if got.Name != "" {
		t.Fatalf("name = %q, want empty when the first user prompt is a slash command", got.Name)
	}
}

func TestListWorkspaceSessionsFindsUserTextAfterNonTextContentPart(t *testing.T) {
	srv, _, ws, agent := newSessionHistoryTestServer(t)
	mtime := time.Now().Add(-time.Minute).UTC().Truncate(time.Second)
	path := writeDiskSession(t, agent, ws.Path, "mixed-content", "", mtime)
	const prompt = "Reply with exactly: QA-OK"
	appendDiskSessionLines(t, path,
		fmt.Sprintf(`{"type":"message","message":{"role":"user","content":[{"type":"image","text":"do not use this"},{"type":"text","text":%q}]}}`, prompt),
	)

	page := decodeSessionHistoryPage(t, listWorkspaceSessions(t, srv, ws.ID, ""))
	if len(page.Items) != 1 {
		t.Fatalf("items = %+v, want one discovered session", page.Items)
	}
	got := page.Items[0]
	if got.ID != "mixed-content" {
		t.Fatalf("id = %q, want mixed-content", got.ID)
	}
	if got.Name != prompt {
		t.Fatalf("name = %q, want text part %q after a leading non-text part", got.Name, prompt)
	}
}

func TestListWorkspaceSessionsSkipsOversizedLineThenDerivesFromUserMessage(t *testing.T) {
	srv, _, ws, agent := newSessionHistoryTestServer(t)
	mtime := time.Now().Add(-time.Minute).UTC().Truncate(time.Second)
	path := writeDiskSession(t, agent, ws.Path, "large-then-user", "", mtime)
	const prompt = "오 넌 누구니"
	oversized := `{"type":"message","payload":"` + strings.Repeat("x", sessionHistoryMaxJSONLLine) + `"}`
	appendDiskSessionLines(t, path,
		oversized,
		fmt.Sprintf(`{"type":"message","message":{"role":"user","content":[{"type":"text","text":%q}]}}`, prompt),
	)

	page := decodeSessionHistoryPage(t, listWorkspaceSessions(t, srv, ws.ID, ""))
	if len(page.Items) != 1 {
		t.Fatalf("items = %+v, want one discovered session", page.Items)
	}
	got := page.Items[0]
	if got.ID != "large-then-user" || got.Name != prompt {
		t.Fatalf("item = %+v, want oversized record skipped and following user text retained", got)
	}
}

func appendDiskSessionLines(t *testing.T, path string, lines ...string) {
	t.Helper()
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatalf("open session: %v", err)
	}
	body := strings.Join(lines, "\n") + "\n"
	if _, err := f.WriteString(body); err != nil {
		f.Close()
		t.Fatalf("append session records: %v", err)
	}
	if err := f.Close(); err != nil {
		t.Fatalf("close session: %v", err)
	}
}

func TestListWorkspaceSessionsStoredRecencyPrefersLastUsedOverCreation(t *testing.T) {
	srv, st, ws, _ := newSessionHistoryTestServer(t)
	oldChat, err := st.NewChat(ws.ID, "old-but-used", ws.Path, "", "omo")
	if err != nil {
		t.Fatalf("create old chat: %v", err)
	}
	newChat, err := st.NewChat(ws.ID, "new-but-idle", ws.Path, "", "omo")
	if err != nil {
		t.Fatalf("create new chat: %v", err)
	}
	// The older chat was opened after the newer chat was created: use time,
	// not creation time, must decide the order.
	touched := newChat.CreatedAt + 5_000
	if _, err := st.UpdateChat(ws.ID, oldChat.ID, func(c *store.Chat) {
		c.LastUsedAt = touched
	}); err != nil {
		t.Fatalf("touch old chat: %v", err)
	}

	page := decodeSessionHistoryPage(t, listWorkspaceSessions(t, srv, ws.ID, ""))
	if len(page.Items) != 2 {
		t.Fatalf("items = %+v, want the two stored chats", page.Items)
	}
	if page.Items[0].ID != oldChat.ID || page.Items[1].ID != newChat.ID {
		t.Fatalf("order = [%s %s], want last-used old chat above newer-created chat", page.Items[0].ID, page.Items[1].ID)
	}
	if page.Items[0].RecencyMs != touched {
		t.Fatalf("used chat recencyMs = %d, want lastUsedAt %d", page.Items[0].RecencyMs, touched)
	}
	if page.Items[1].RecencyMs != newChat.CreatedAt {
		t.Fatalf("idle chat recencyMs = %d, want createdAt %d", page.Items[1].RecencyMs, newChat.CreatedAt)
	}
}
