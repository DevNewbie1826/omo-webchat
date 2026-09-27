package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/auth"
	"github.com/DevNewbie1826/omo-webchat/internal/cursorstore"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc/omorpctest"
	"github.com/DevNewbie1826/omo-webchat/internal/session"
	"github.com/DevNewbie1826/omo-webchat/internal/wsbridge"
)

func writeHistorySessionFile(t *testing.T, dir, durableID string, entryLines ...string) string {
	t.Helper()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, durableID+".jsonl")
	lines := append([]string{fmt.Sprintf(`{"type":"session","id":%q,"version":3,"timestamp":"2026-09-27T00:00:00Z","cwd":%q}`, durableID, dir)}, entryLines...)
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func historyChainLines(count int) []string {
	lines := make([]string, 0, count)
	for i := 0; i < count; i++ {
		parent := "null"
		if i > 0 {
			parent = fmt.Sprintf("%q", fmt.Sprintf("e-%03d", i-1))
		}
		lines = append(lines, fmt.Sprintf(`{"type":"message","id":"e-%03d","parentId":%s,"message":{"role":"user","content":"m%d"}}`, i, parent, i))
	}
	return lines
}

func saveHistoryChat(t *testing.T, store *testMetadataStore, ws cursorstore.Workspace, chatID, durableID, sessionFile string) cursorstore.Chat {
	t.Helper()
	chat := cursorstore.Chat{
		ID: chatID, WorkspaceID: ws.ID, CWD: ws.Path,
		SessionFile: sessionFile, DurableSessionID: durableID,
		SessionProvenance: cursorstore.SessionProvenanceInPlace,
		Name:              "History", NameSource: cursorstore.NameSourceUser,
	}
	if err := store.SaveChat(chat); err != nil {
		t.Fatal(err)
	}
	return chat
}

func serveHistoryRequest(t *testing.T, s *Server, token, wsID, chatID, rawQuery string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet, "/api/workspaces/"+wsID+"/chats/"+chatID+"/history?"+rawQuery, nil)
	if token != "" {
		request.AddCookie(&http.Cookie{Name: auth.CookieName, Value: token})
	}
	response := httptest.NewRecorder()
	s.Handler().ServeHTTP(response, request)
	return response
}

type historyPageBody struct {
	SessionID       string            `json:"sessionId"`
	Entries         []json.RawMessage `json:"entries"`
	HistoryComplete bool              `json:"historyComplete"`
}

func decodeHistoryBody(t *testing.T, rec *httptest.ResponseRecorder) historyPageBody {
	t.Helper()
	var body historyPageBody
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("status %d, body %s: %v", rec.Code, rec.Body.String(), err)
	}
	return body
}

func historyEntryIDs(t *testing.T, entries []json.RawMessage) []string {
	t.Helper()
	ids := make([]string, 0, len(entries))
	for _, raw := range entries {
		var entry struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal(raw, &entry); err != nil {
			t.Fatalf("entry %s: %v", raw, err)
		}
		ids = append(ids, entry.ID)
	}
	return ids
}

func historyErrorBody(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	var body struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("status %d, body %s: %v", rec.Code, rec.Body.String(), err)
	}
	return body.Error
}

func TestChatHistoryServesBranchOrderedPagesWithRootCompletion(t *testing.T) {
	s, store, ws := newChatCreateTestServer(t)
	rootLine := `{"type":"message","id":"root","parentId":null,"message":{"role":"user","content":"root"}}`
	leftLine := `{"type":"message","id":"left","parentId":"root","message":{"role":"assistant","content":"left"}}`
	abandonedLine := `{"type":"message","id":"abandoned","parentId":"root","message":{"role":"user","content":"side"}}`
	leafLine := `{"type":"message","id":"leaf","parentId":"left","message":{"role":"assistant","content":"done"}}`
	path := writeHistorySessionFile(t, ws.Path, "durable-hist", rootLine, leftLine, abandonedLine, leafLine)
	chat := saveHistoryChat(t, store, ws, "chat-history", "durable-hist", path)
	token, err := s.sessions.Create(t.Context())
	if err != nil {
		t.Fatal(err)
	}

	rec := serveHistoryRequest(t, s, token, ws.ID, chat.ID, "session=durable-hist&before=leaf&limit=10")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(rec.Body.Bytes(), &raw); err != nil {
		t.Fatal(err)
	}
	if len(raw) != 3 || raw["sessionId"] == nil || raw["entries"] == nil || raw["historyComplete"] == nil {
		t.Fatalf("page keys = %v, want exactly sessionId/entries/historyComplete", raw)
	}
	body := decodeHistoryBody(t, rec)
	if body.SessionID != "durable-hist" {
		t.Fatalf("sessionId = %q, want the disk session id", body.SessionID)
	}
	if got := historyEntryIDs(t, body.Entries); fmt.Sprint(got) != fmt.Sprint([]string{"root", "left"}) {
		t.Fatalf("entry ids = %v, want active branch order [root left] ending before leaf", got)
	}
	if !body.HistoryComplete {
		t.Fatal("page reaching the branch root must carry historyComplete")
	}
	if string(body.Entries[0]) != rootLine || string(body.Entries[1]) != leftLine {
		t.Fatalf("entries not raw JSON: %s %s", body.Entries[0], body.Entries[1])
	}

	limited := serveHistoryRequest(t, s, token, ws.ID, chat.ID, "session=durable-hist&before=leaf&limit=1")
	if limited.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", limited.Code, limited.Body.String())
	}
	limitedBody := decodeHistoryBody(t, limited)
	if got := historyEntryIDs(t, limitedBody.Entries); fmt.Sprint(got) != fmt.Sprint([]string{"left"}) {
		t.Fatalf("limited ids = %v, want the newest preceding entry", got)
	}
	if limitedBody.HistoryComplete {
		t.Fatal("one entry before leaf does not reach the root")
	}

	beforeRoot := serveHistoryRequest(t, s, token, ws.ID, chat.ID, "session=durable-hist&before=root")
	if beforeRoot.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", beforeRoot.Code, beforeRoot.Body.String())
	}
	var rootRaw map[string]json.RawMessage
	if err := json.Unmarshal(beforeRoot.Body.Bytes(), &rootRaw); err != nil {
		t.Fatal(err)
	}
	if string(rootRaw["entries"]) != "[]" {
		t.Fatalf("entries before the root = %s, want an empty array", rootRaw["entries"])
	}
	rootBody := decodeHistoryBody(t, beforeRoot)
	if !rootBody.HistoryComplete {
		t.Fatal("the page before the branch root is terminal")
	}
}

func TestChatHistoryLimitClampsToOneHundred(t *testing.T) {
	s, store, ws := newChatCreateTestServer(t)
	path := writeHistorySessionFile(t, ws.Path, "durable-wide", historyChainLines(150)...)
	chat := saveHistoryChat(t, store, ws, "chat-wide", "durable-wide", path)
	token, err := s.sessions.Create(t.Context())
	if err != nil {
		t.Fatal(err)
	}

	clamped := serveHistoryRequest(t, s, token, ws.ID, chat.ID, "session=durable-wide&before=e-149&limit=1000")
	if clamped.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", clamped.Code, clamped.Body.String())
	}
	clampedBody := decodeHistoryBody(t, clamped)
	if len(clampedBody.Entries) != 100 {
		t.Fatalf("limit=1000 returned %d entries, want the 100-entry clamp", len(clampedBody.Entries))
	}
	if ids := historyEntryIDs(t, clampedBody.Entries); ids[0] != "e-049" || ids[len(ids)-1] != "e-148" {
		t.Fatalf("clamped page spans %s..%s, want e-049..e-148", ids[0], ids[len(ids)-1])
	}
	if clampedBody.HistoryComplete {
		t.Fatal("clamped page stops above the root")
	}

	defaulted := serveHistoryRequest(t, s, token, ws.ID, chat.ID, "session=durable-wide&before=e-149")
	if defaulted.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", defaulted.Code, defaulted.Body.String())
	}
	if got := len(decodeHistoryBody(t, defaulted).Entries); got != 100 {
		t.Fatalf("default limit returned %d entries, want 100", got)
	}

	floor := serveHistoryRequest(t, s, token, ws.ID, chat.ID, "session=durable-wide&before=e-149&limit=0")
	if floor.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", floor.Code, floor.Body.String())
	}
	if got := len(decodeHistoryBody(t, floor).Entries); got != 1 {
		t.Fatalf("limit=0 returned %d entries, want the clamp floor of 1", got)
	}

	if rec := serveHistoryRequest(t, s, token, ws.ID, chat.ID, "session=durable-wide&before=e-149&limit=many"); rec.Code != http.StatusBadRequest {
		t.Fatalf("non-numeric limit status = %d, body = %s", rec.Code, rec.Body.String())
	}
}

func TestChatHistoryRejectsStaleSessionCursor(t *testing.T) {
	s, store, ws := newChatCreateTestServer(t)
	path := writeHistorySessionFile(t, ws.Path, "durable-session", historyChainLines(3)...)
	chat := saveHistoryChat(t, store, ws, "chat-stale", "durable-session", path)
	token, err := s.sessions.Create(t.Context())
	if err != nil {
		t.Fatal(err)
	}

	rec := serveHistoryRequest(t, s, token, ws.ID, chat.ID, "session=other-durable&before=e-002")
	if rec.Code != http.StatusConflict || historyErrorBody(t, rec) != "history_cursor_stale" {
		t.Fatalf("wrong session status = %d, body = %s", rec.Code, rec.Body.String())
	}

	if err := store.SaveChat(cursorstore.Chat{ID: "chat-identity-less", WorkspaceID: ws.ID, CWD: ws.Path, Name: "empty", NameSource: cursorstore.NameSourceAuto}); err != nil {
		t.Fatal(err)
	}
	rec = serveHistoryRequest(t, s, token, ws.ID, "chat-identity-less", "session=durable-session&before=e-002")
	if rec.Code != http.StatusConflict || historyErrorBody(t, rec) != "history_cursor_stale" {
		t.Fatalf("identity-less chat status = %d, body = %s", rec.Code, rec.Body.String())
	}
}

func TestChatHistoryRejectsOffBranchBeforeCursor(t *testing.T) {
	s, store, ws := newChatCreateTestServer(t)
	root := `{"type":"message","id":"root","parentId":null}`
	abandoned := `{"type":"message","id":"abandoned","parentId":"root"}`
	leaf := `{"type":"message","id":"leaf","parentId":"root"}`
	path := writeHistorySessionFile(t, ws.Path, "durable-branch", root, abandoned, leaf)
	chat := saveHistoryChat(t, store, ws, "chat-branch", "durable-branch", path)
	token, err := s.sessions.Create(t.Context())
	if err != nil {
		t.Fatal(err)
	}

	for _, before := range []string{"abandoned", "never-written"} {
		rec := serveHistoryRequest(t, s, token, ws.ID, chat.ID, "session=durable-branch&before="+before)
		if rec.Code != http.StatusConflict || historyErrorBody(t, rec) != "history_cursor_stale" {
			t.Fatalf("before %q status = %d, body = %s", before, rec.Code, rec.Body.String())
		}
	}
}

func TestChatHistoryQuarantinedLiveSessionConflicts(t *testing.T) {
	s, store, ws := newChatCreateTestServer(t)
	agentDir := t.TempDir()
	t.Setenv("OMO_CODING_AGENT_DIR", agentDir)
	source := writeAdoptableDiskSession(t, agentDir, ws.Path, "durable-quarantine", "Quarantined")
	chat := cursorstore.Chat{
		ID: "chat-quarantine", WorkspaceID: ws.ID, CWD: ws.Path,
		SessionFile: source, DurableSessionID: "durable-quarantine",
		SessionProvenance: cursorstore.SessionProvenanceInPlace,
		Name:              "Quarantined", NameSource: cursorstore.NameSourceAuto,
	}
	if err := store.SaveChat(chat); err != nil {
		t.Fatal(err)
	}
	token, err := s.sessions.Create(t.Context())
	if err != nil {
		t.Fatal(err)
	}

	daemonDir, err := os.MkdirTemp("", "history-quarantine-*")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(daemonDir) })
	daemon := omorpctest.New(daemonDir)
	if err := daemon.LoadSessionFile(source); err != nil {
		t.Fatal(err)
	}
	if err := daemon.Start(); err != nil {
		t.Fatal(err)
	}
	client, err := dialHistoryTestClient(t, daemon)
	if err != nil {
		t.Fatal(err)
	}
	manager := session.NewManager(session.Config{Client: client, Store: (*wsbridge.CursorStore)(store.Store)})
	s.manager = manager
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = manager.CloseAll(ctx)
		_ = client.Close()
		daemon.Stop()
	})

	live, _, detach, err := manager.Acquire(t.Context(), adoptionChatRef{chat: chat}, nil)
	if err != nil {
		t.Fatalf("acquiring in-place session: %v", err)
	}
	defer detach()

	if err := os.Remove(source); err != nil {
		t.Fatal(err)
	}
	promptErr := live.SendPrompt(t.Context(), "drift the route", nil)
	var drift *session.ExternalWriteError
	if !errors.As(promptErr, &drift) {
		t.Fatalf("send error = %v, want external-write quarantine", promptErr)
	}
	if !live.HistoryQuarantined() {
		t.Fatal("live session not quarantined after external write")
	}

	rec := serveHistoryRequest(t, s, token, ws.ID, chat.ID, "session=durable-quarantine&before=any-entry")
	if rec.Code != http.StatusConflict || historyErrorBody(t, rec) != "history_cursor_stale" {
		t.Fatalf("quarantined status = %d, body = %s", rec.Code, rec.Body.String())
	}
}

func dialHistoryTestClient(t *testing.T, daemon *omorpctest.Daemon) (*omorpc.Client, error) {
	t.Helper()
	return omorpc.Dial(t.Context(), daemon.SocketPath())
}

func TestChatHistoryUnknownScopesAndMissingFileReadNotFound(t *testing.T) {
	s, store, ws := newChatCreateTestServer(t)
	other := cursorstore.Workspace{ID: "ws-other", Name: "other", Path: t.TempDir()}
	if err := store.SaveWorkspace(other); err != nil {
		t.Fatal(err)
	}
	path := writeHistorySessionFile(t, ws.Path, "durable-scope", historyChainLines(2)...)
	chat := saveHistoryChat(t, store, ws, "chat-scope", "durable-scope", path)
	token, err := s.sessions.Create(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	query := "session=durable-scope&before=e-001"

	if rec := serveHistoryRequest(t, s, token, "ws-missing", chat.ID, query); rec.Code != http.StatusNotFound {
		t.Fatalf("unknown workspace status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if rec := serveHistoryRequest(t, s, token, ws.ID, "chat-missing", query); rec.Code != http.StatusNotFound {
		t.Fatalf("unknown chat status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if rec := serveHistoryRequest(t, s, token, other.ID, chat.ID, query); rec.Code != http.StatusNotFound {
		t.Fatalf("cross-workspace status = %d, body = %s", rec.Code, rec.Body.String())
	}

	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if rec := serveHistoryRequest(t, s, token, ws.ID, chat.ID, query); rec.Code != http.StatusNotFound {
		t.Fatalf("missing file status = %d, body = %s", rec.Code, rec.Body.String())
	}

	if err := store.SaveChat(cursorstore.Chat{ID: "chat-relative", WorkspaceID: ws.ID, CWD: "relative", DurableSessionID: "durable-scope", Name: "relative", NameSource: cursorstore.NameSourceAuto}); err != nil {
		t.Fatal(err)
	}
	if rec := serveHistoryRequest(t, s, token, ws.ID, "chat-relative", query); rec.Code != http.StatusNotFound {
		t.Fatalf("unconfined cwd status = %d, body = %s", rec.Code, rec.Body.String())
	}
}

func TestChatHistoryRequiresSessionAndBefore(t *testing.T) {
	s, store, ws := newChatCreateTestServer(t)
	path := writeHistorySessionFile(t, ws.Path, "durable-params", historyChainLines(2)...)
	chat := saveHistoryChat(t, store, ws, "chat-params", "durable-params", path)
	token, err := s.sessions.Create(t.Context())
	if err != nil {
		t.Fatal(err)
	}

	for name, rawQuery := range map[string]string{
		"missing session": "before=e-001",
		"missing before":  "session=durable-params",
		"missing both":    "",
	} {
		rec := serveHistoryRequest(t, s, token, ws.ID, chat.ID, rawQuery)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("%s status = %d, body = %s", name, rec.Code, rec.Body.String())
		}
	}
}

func TestChatHistoryRequiresAuth(t *testing.T) {
	s, _, ws := newChatCreateTestServer(t)
	rec := serveHistoryRequest(t, s, "", ws.ID, "chat-any", "session=durable&before=e-0")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated status = %d, body = %s", rec.Code, rec.Body.String())
	}
}

func TestChatHistoryBusyWhenSaturatedAndRequestContextEnds(t *testing.T) {
	s, store, ws := newChatCreateTestServer(t)
	path := writeHistorySessionFile(t, ws.Path, "durable-busy", historyChainLines(4)...)
	chat := saveHistoryChat(t, store, ws, "chat-busy", "durable-busy", path)
	token, err := s.sessions.Create(t.Context())
	if err != nil {
		t.Fatal(err)
	}

	releases := saturateHistoryReadSlots(t)
	defer releaseHistoryReadSlots(releases)

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	request := httptest.NewRequest(http.MethodGet, "/api/workspaces/"+ws.ID+"/chats/"+chat.ID+"/history?session=durable-busy&before=e-003", nil).WithContext(ctx)
	request.AddCookie(&http.Cookie{Name: auth.CookieName, Value: token})
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, request)
	if rec.Code != http.StatusServiceUnavailable || historyErrorBody(t, rec) != "history_busy" {
		t.Fatalf("saturated status = %d, body = %s", rec.Code, rec.Body.String())
	}
}

func saturateHistoryReadSlots(t *testing.T) []func() {
	t.Helper()
	releases := make([]func(), 0, historyMaxConcurrentReads)
	for i := 0; i < historyMaxConcurrentReads; i++ {
		release, ok := acquireHistoryReadSlot(context.Background())
		if !ok {
			t.Fatalf("slot %d not acquirable on an idle limiter", i)
		}
		releases = append(releases, release)
	}
	return releases
}

func releaseHistoryReadSlots(releases []func()) {
	for _, release := range releases {
		if release != nil {
			release()
		}
	}
}

func TestHistoryReadSlotLimiterWaitsForAFreedSlotAndHonorsContextEnd(t *testing.T) {
	releases := saturateHistoryReadSlots(t)
	defer releaseHistoryReadSlots(releases)

	deadCtx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, ok := acquireHistoryReadSlot(deadCtx); ok {
		t.Fatal("acquired a slot while saturated with a dead context")
	}

	waitCtx, waitCancel := context.WithCancel(context.Background())
	acquired := make(chan bool, 1)
	go func() {
		_, ok := acquireHistoryReadSlot(waitCtx)
		acquired <- ok
	}()
	waitCancel()
	if ok := <-acquired; ok {
		t.Fatal("waiter acquired a slot after its context ended")
	}

	releases[0]()
	releases[0] = nil
	if _, ok := acquireHistoryReadSlot(context.Background()); !ok {
		t.Fatal("freed slot not reusable")
	}
}

func TestHistoryFlightsShareOneReadForIdenticalInFlightKeys(t *testing.T) {
	key := historyFlightKey{path: "/work/session.jsonl", before: "e-9", limit: 100}
	shared := historyReadResult{sessionID: "durable", entries: []json.RawMessage{json.RawMessage(`{"id":"e-8"}`)}, historyComplete: false}
	flight := &historyFlight{done: make(chan struct{})}
	historyFlights.mu.Lock()
	historyFlights.m[key] = flight
	historyFlights.mu.Unlock()
	t.Cleanup(func() {
		historyFlights.mu.Lock()
		delete(historyFlights.m, key)
		historyFlights.mu.Unlock()
	})

	var reads atomic.Int32
	read := func(context.Context) (historyReadResult, error) {
		reads.Add(1)
		return historyReadResult{sessionID: "leader-only"}, nil
	}

	const waiters = 2
	results := make(chan historyReadResult, waiters)
	errs := make(chan error, waiters)
	for i := 0; i < waiters; i++ {
		go func() {
			result, err := doHistoryRead(context.Background(), key, read)
			results <- result
			errs <- err
		}()
	}
	flight.result, flight.err = shared, nil
	close(flight.done)
	for i := 0; i < waiters; i++ {
		if err := <-errs; err != nil {
			t.Fatal(err)
		}
		if result := <-results; result.sessionID != shared.sessionID || len(result.entries) != 1 || string(result.entries[0]) != string(shared.entries[0]) || result.historyComplete != shared.historyComplete {
			t.Fatalf("waiter result = %+v, want the shared flight outcome", result)
		}
	}
	if reads.Load() != 0 {
		t.Fatalf("waiters drove %d reads, want the leader's flight to serve them", reads.Load())
	}
}

func TestHistoryFlightsLeaderRunsReadOnceAndDeregisters(t *testing.T) {
	key := historyFlightKey{path: "/work/leader.jsonl", before: "e-1", limit: 10}
	once := historyReadResult{sessionID: "durable", entries: []json.RawMessage{}, historyComplete: true}
	reads := 0
	result, err := doHistoryRead(context.Background(), key, func(context.Context) (historyReadResult, error) {
		reads++
		return once, nil
	})
	if err != nil || result.sessionID != once.sessionID || !result.historyComplete {
		t.Fatalf("leader result = %+v, err = %v", result, err)
	}
	if reads != 1 {
		t.Fatalf("reads = %d, want exactly one", reads)
	}
	historyFlights.mu.Lock()
	_, registered := historyFlights.m[key]
	historyFlights.mu.Unlock()
	if registered {
		t.Fatal("completed flight stayed registered")
	}
}

func TestHistoryFlightsRedriveWhenLeaderAbandons(t *testing.T) {
	for _, tc := range []struct {
		name string
		err  error
	}{
		{name: "canceled", err: context.Canceled},
		{name: "busy", err: errHistoryBusy},
	} {
		t.Run(tc.name, func(t *testing.T) {
			key := historyFlightKey{path: "/work/redrive-" + tc.name + ".jsonl", before: "e-2", limit: 5}
			flight := &historyFlight{done: make(chan struct{})}
			historyFlights.mu.Lock()
			historyFlights.m[key] = flight
			historyFlights.mu.Unlock()

			var reads atomic.Int32
			takeover := historyReadResult{sessionID: "durable", entries: []json.RawMessage{}, historyComplete: true}
			results := make(chan historyReadResult, 1)
			errs := make(chan error, 1)
			go func() {
				result, err := doHistoryRead(context.Background(), key, func(context.Context) (historyReadResult, error) {
					reads.Add(1)
					return takeover, nil
				})
				results <- result
				errs <- err
			}()

			historyFlights.mu.Lock()
			delete(historyFlights.m, key)
			historyFlights.mu.Unlock()
			flight.err = tc.err
			close(flight.done)

			if err := <-errs; err != nil {
				t.Fatal(err)
			}
			if result := <-results; result.sessionID != takeover.sessionID || !result.historyComplete {
				t.Fatalf("redriven result = %+v, want the takeover read", result)
			}
			if reads.Load() != 1 {
				t.Fatalf("reads = %d, want exactly one takeover read", reads.Load())
			}
		})
	}
}

func TestHistoryFlightsDeadContextNeverRedrives(t *testing.T) {
	key := historyFlightKey{path: "/work/dead-context.jsonl", before: "e-2", limit: 5}
	flight := &historyFlight{done: make(chan struct{})}
	historyFlights.mu.Lock()
	historyFlights.m[key] = flight
	historyFlights.mu.Unlock()
	t.Cleanup(func() {
		historyFlights.mu.Lock()
		delete(historyFlights.m, key)
		historyFlights.mu.Unlock()
	})
	flight.err = context.Canceled
	close(flight.done)

	deadCtx, cancel := context.WithCancel(context.Background())
	cancel()
	var reads atomic.Int32
	_, err := doHistoryRead(deadCtx, key, func(context.Context) (historyReadResult, error) {
		reads.Add(1)
		return historyReadResult{}, nil
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("dead context err = %v, want context.Canceled", err)
	}
	if reads.Load() != 0 {
		t.Fatal("a dead context must never drive a read")
	}
}

func TestChatHistoryConcurrentIdenticalRequestsShareThePage(t *testing.T) {
	s, store, ws := newChatCreateTestServer(t)
	path := writeHistorySessionFile(t, ws.Path, "durable-shared", historyChainLines(250)...)
	chat := saveHistoryChat(t, store, ws, "chat-shared", "durable-shared", path)
	token, err := s.sessions.Create(t.Context())
	if err != nil {
		t.Fatal(err)
	}

	const callers = 2
	responses := make(chan *httptest.ResponseRecorder, callers)
	var start sync.WaitGroup
	start.Add(1)
	var done sync.WaitGroup
	for i := 0; i < callers; i++ {
		done.Add(1)
		go func() {
			defer done.Done()
			start.Wait()
			responses <- serveHistoryRequest(t, s, token, ws.ID, chat.ID, "session=durable-shared&before=e-249")
		}()
	}
	start.Done()
	done.Wait()
	close(responses)

	first := <-responses
	if first.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", first.Code, first.Body.String())
	}
	if got := len(decodeHistoryBody(t, first).Entries); got != 100 {
		t.Fatalf("shared page has %d entries, want 100", got)
	}
	for rec := range responses {
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
		}
		if string(rec.Body.Bytes()) != first.Body.String() {
			t.Fatalf("concurrent identical requests returned different pages:\n%s\n%s", first.Body.String(), rec.Body.String())
		}
	}
}
