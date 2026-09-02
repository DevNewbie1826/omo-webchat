package api

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/lxzan/gws"

	"github.com/DevNewbie1826/omo-webchat/internal/adoptcopy"
	"github.com/DevNewbie1826/omo-webchat/internal/auth"
	"github.com/DevNewbie1826/omo-webchat/internal/config"
	"github.com/DevNewbie1826/omo-webchat/internal/cursorstore"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc/omorpctest"
	"github.com/DevNewbie1826/omo-webchat/internal/session"
	"github.com/DevNewbie1826/omo-webchat/internal/wsbridge"
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

type adoptionWSCollector struct {
	gws.BuiltinEventHandler
	frames chan map[string]any
}

func (c *adoptionWSCollector) OnMessage(_ *gws.Conn, message *gws.Message) {
	defer message.Close()
	var frame map[string]any
	if json.Unmarshal(message.Bytes(), &frame) == nil {
		c.frames <- frame
	}
}

func (c *adoptionWSCollector) next(t *testing.T, typ string) map[string]any {
	t.Helper()
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()
	for {
		select {
		case frame := <-c.frames:
			if frame["type"] == typ {
				return frame
			}
		case <-timer.C:
			t.Fatalf("timed out waiting for %s", typ)
		}
	}
}

func TestAdoptionHTTPToBridgeOpensOnlyOwnedCopy(t *testing.T) {
	dir := t.TempDir()
	daemonDir, err := os.MkdirTemp("", "adopt-e2e-*")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(daemonDir) })
	daemon := omorpctest.New(daemonDir)
	if err := daemon.Start(); err != nil {
		t.Fatal(err)
	}
	client, err := omorpc.Dial(t.Context(), daemon.SocketPath())
	if err != nil {
		t.Fatal(err)
	}
	store, err := cursorstore.Open(filepath.Join(dir, "state-v2.json"))
	if err != nil {
		t.Fatal(err)
	}
	ws := cursorstore.Workspace{ID: "ws-adopt-e2e", Name: "work", Path: dir}
	if err := store.SaveWorkspace(ws); err != nil {
		t.Fatal(err)
	}
	manager := session.NewManager(session.Config{Client: client, Store: (*wsbridge.CursorStore)(store)})
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	sessionStore := auth.NewSessionStore(t.Context(), "pw", logger)
	var server *Server
	bridge := wsbridge.New(wsbridge.Config{
		Context: t.Context(), Manager: manager, Store: store, ServerVersion: client.ServerVersion(), Logger: logger,
		PrepareChatVersion: func(ctx context.Context, wsID, chatID string) (uint64, error) {
			return server.prepareChatVersion(ctx, wsID, chatID)
		},
		ChatVersion: func(chatID string) uint64 { return server.chatLifecycleVersion(chatID) },
	})
	server = New(t.Context(), &config.Config{Root: dir}, store, sessionStore, manager, bridge, logger)
	testServer := httptest.NewServer(server.Handler())
	t.Cleanup(func() {
		testServer.Close()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = manager.CloseAll(ctx)
		_ = client.Close()
		daemon.Stop()
	})

	token, err := sessionStore.Create(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	agentDir := t.TempDir()
	t.Setenv("OMO_CODING_AGENT_DIR", agentDir)
	source := writeAdoptableDiskSession(t, agentDir, ws.Path, "durable-e2e", "Bridge copy")
	body, err := json.Marshal(map[string]string{"id": "durable-e2e", "resumeIdentity": source})
	if err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequestWithContext(t.Context(), http.MethodPost, testServer.URL+"/api/workspaces/"+ws.ID+"/sessions/adopt", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: token})
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		raw, _ := io.ReadAll(resp.Body)
		t.Fatalf("adopt status = %d, body = %s", resp.StatusCode, raw)
	}
	var adopted chatResponse
	if err := json.NewDecoder(resp.Body).Decode(&adopted); err != nil {
		t.Fatal(err)
	}
	stored, err := store.GetChat(adopted.ID)
	if err != nil {
		t.Fatal(err)
	}

	collector := &adoptionWSCollector{frames: make(chan map[string]any, 32)}
	conn, _, err := gws.NewClient(collector, &gws.ClientOption{
		Addr:          "ws" + strings.TrimPrefix(testServer.URL, "http") + "/api/v2/ws",
		RequestHeader: http.Header{"Cookie": []string{auth.CookieName + "=" + token}},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.WriteClose(1000, nil)
	go conn.ReadLoop()
	collector.next(t, "hello")
	write := func(frame any) {
		raw, marshalErr := json.Marshal(frame)
		if marshalErr != nil {
			t.Fatal(marshalErr)
		}
		if writeErr := conn.WriteMessage(gws.OpcodeText, raw); writeErr != nil {
			t.Fatal(writeErr)
		}
	}
	write(map[string]any{"type": "hello", "version": 2})
	write(map[string]any{"type": "chat.create", "wsId": ws.ID, "chatId": adopted.ID})
	collector.next(t, "ready")

	foundOwned := false
	for _, opened := range daemon.Requests() {
		if opened["type"] != omorpc.CmdOpenSession {
			continue
		}
		path, _ := opened["sessionPath"].(string)
		if path == source {
			t.Fatalf("bridge opened original path %q", source)
		}
		if path == stored.SessionFile {
			foundOwned = true
		}
	}
	if !foundOwned {
		t.Fatalf("bridge never opened owned path %q; requests = %+v", stored.SessionFile, daemon.Requests())
	}
}

type adoptionUnsafeCursorStore struct {
	store *cursorstore.Store
}

func (s adoptionUnsafeCursorStore) CursorFor(_ context.Context, id string) (session.Cursor, error) {
	chat, err := s.store.GetChat(id)
	if err != nil {
		return session.Cursor{}, err
	}
	return session.Cursor{SessionFile: chat.SessionFile, DurableSessionID: chat.DurableSessionID, Name: chat.Name, NameSource: chat.NameSource, TitleIsPlaceholder: chat.TitleIsPlaceholder}, nil
}

func (s adoptionUnsafeCursorStore) SaveCursor(_ context.Context, id string, cur session.Cursor) error {
	chat, err := s.store.GetChat(id)
	if err != nil {
		return err
	}
	chat.SessionFile, chat.DurableSessionID = cur.SessionFile, cur.DurableSessionID
	chat.Name, chat.NameSource, chat.TitleIsPlaceholder = cur.Name, cur.NameSource, cur.TitleIsPlaceholder
	return s.store.UpdateChat(chat)
}

func (s adoptionUnsafeCursorStore) UpdateIdentity(_ context.Context, id, path, durableID string) error {
	return s.store.UpdateIdentity(id, path, durableID)
}

func (s adoptionUnsafeCursorStore) UpdateName(_ context.Context, id, name, source string) error {
	return s.store.UpdateName(id, name, source)
}

type adoptionChatRef struct{ chat cursorstore.Chat }

func (r adoptionChatRef) ChatID() string { return r.chat.ID }
func (r adoptionChatRef) CWD() string    { return r.chat.CWD }

func newAdoptionLifecycleHarness(t *testing.T, store *cursorstore.Store) (*session.Manager, *omorpctest.Daemon) {
	t.Helper()
	daemonDir, err := os.MkdirTemp("", "adopt-life-*")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(daemonDir) })
	daemon := omorpctest.New(daemonDir)
	if err := daemon.Start(); err != nil {
		t.Fatal(err)
	}
	client, err := omorpc.Dial(t.Context(), daemon.SocketPath())
	if err != nil {
		daemon.Stop()
		t.Fatal(err)
	}
	manager := session.NewManager(session.Config{Client: client, Store: adoptionUnsafeCursorStore{store: store}})
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = manager.CloseAll(ctx)
		_ = client.Close()
		daemon.Stop()
	})
	return manager, daemon
}

func TestAdoptWorkspaceSessionStopsLiveOriginalBeforeInstallingCopy(t *testing.T) {
	s, st, ws := newChatCreateTestServer(t)
	agentDir := t.TempDir()
	t.Setenv("OMO_CODING_AGENT_DIR", agentDir)
	source := writeAdoptableDiskSession(t, agentDir, ws.Path, "durable-live", "")
	chat := cursorstore.Chat{ID: "chat-live", WorkspaceID: ws.ID, CWD: ws.Path, SessionFile: source, Name: "live", NameSource: cursorstore.NameSourceAuto}
	if err := st.SaveChat(chat); err != nil {
		t.Fatal(err)
	}
	manager, daemon := newAdoptionLifecycleHarness(t, st.Store)
	s.manager = manager
	_, _, detach, err := manager.Acquire(t.Context(), adoptionChatRef{chat: chat}, nil)
	if err != nil {
		t.Fatal(err)
	}
	detach()

	response := adoptWorkspaceSession(t, s, ws.ID, map[string]string{"id": "durable-live", "resumeIdentity": source})
	if response.Code != http.StatusOK {
		t.Fatalf("status %d: %s", response.Code, response.Body.String())
	}
	if _, live := manager.Get(chat.ID); live {
		t.Fatal("original route remained live after adoption")
	}
	if got := daemon.RequestCount(omorpc.CmdCloseSession); got != 1 {
		t.Fatalf("close requests = %d, want 1", got)
	}
	stored, err := st.GetChat(chat.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.SessionFile == source || !cursorstore.IsOwnedSession(stored, st.OwnedSessionDir()) {
		t.Fatalf("stored identity was not replaced with owned copy: %+v", stored)
	}
}

func TestAdoptWorkspaceSessionSerializesWithInflightOriginalOpen(t *testing.T) {
	s, st, ws := newChatCreateTestServer(t)
	agentDir := t.TempDir()
	t.Setenv("OMO_CODING_AGENT_DIR", agentDir)
	source := writeAdoptableDiskSession(t, agentDir, ws.Path, "durable-race", "")
	chat := cursorstore.Chat{ID: "chat-race", WorkspaceID: ws.ID, CWD: ws.Path, SessionFile: source, Name: "race", NameSource: cursorstore.NameSourceAuto}
	if err := st.SaveChat(chat); err != nil {
		t.Fatal(err)
	}
	manager, daemon := newAdoptionLifecycleHarness(t, st.Store)
	s.manager = manager
	releaseOpen := daemon.BlockHandler(omorpc.CmdOpenSession)
	released := false
	defer func() {
		if !released {
			releaseOpen()
		}
	}()
	preparedGeneration := s.chatLifecycleVersion(chat.ID)
	openDone := make(chan error, 1)
	go func() {
		_, _, detach, err := manager.AcquireInitializedChecked(context.Background(), adoptionChatRef{chat: chat}, nil, nil, func() error {
			if s.chatLifecycleVersion(chat.ID) != preparedGeneration {
				return wsbridge.ErrChatDeleted
			}
			return nil
		})
		if detach != nil {
			detach()
		}
		openDone <- err
	}()
	if !daemon.AwaitRequestCount(omorpc.CmdOpenSession, 1, 5*time.Second) {
		t.Fatal("open_session did not enter provider")
	}

	invalidated := make(chan struct{}, 1)
	originalHook := afterAdoptionInvalidated
	defer func() { afterAdoptionInvalidated = originalHook }()
	afterAdoptionInvalidated = func(id string) {
		if id == chat.ID {
			invalidated <- struct{}{}
		}
	}
	adoptDone := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		adoptDone <- adoptWorkspaceSession(t, s, ws.ID, map[string]string{"id": "durable-race", "resumeIdentity": source})
	}()
	select {
	case <-invalidated:
	case <-time.After(5 * time.Second):
		t.Fatal("adoption did not invalidate the in-flight open")
	}
	releaseOpen()
	released = true
	if err := <-openDone; !errors.Is(err, wsbridge.ErrChatDeleted) {
		t.Fatalf("racing open error = %v, want lifecycle invalidation", err)
	}
	response := <-adoptDone
	if response.Code != http.StatusOK {
		t.Fatalf("status %d: %s", response.Code, response.Body.String())
	}
	if _, live := manager.Get(chat.ID); live {
		t.Fatal("route published by racing open survived adoption")
	}
	stored, err := st.GetChat(chat.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.SessionFile == source || !cursorstore.IsOwnedSession(stored, st.OwnedSessionDir()) {
		t.Fatalf("racing adoption stored unsafe identity: %+v", stored)
	}
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

func TestAdoptWorkspaceSessionCreatesChatWithCompleteIdentityInOneSave(t *testing.T) {
	s, _, ws := newChatCreateTestServer(t)
	agentDir := t.TempDir()
	t.Setenv("OMO_CODING_AGENT_DIR", agentDir)
	source := writeAdoptableDiskSession(t, agentDir, ws.Path, "durable-atomic", "")

	originalSave := saveAdoptedChat
	defer func() { saveAdoptedChat = originalSave }()
	calls := 0
	saveAdoptedChat = func(store *cursorstore.Store, chat cursorstore.Chat) error {
		calls++
		if chat.SessionFile == "" || chat.DurableSessionID != "durable-atomic" || !cursorstore.IsOwnedSession(chat, store.OwnedSessionDir()) {
			t.Fatalf("incomplete adopted chat reached save: %+v", chat)
		}
		if _, err := store.GetChat(chat.ID); !errors.Is(err, cursorstore.ErrNotFound) {
			t.Fatalf("chat was visible before complete save: %v", err)
		}
		return store.SaveChat(chat)
	}

	response := adoptWorkspaceSession(t, s, ws.ID, map[string]string{"id": "durable-atomic", "resumeIdentity": source})
	if response.Code != http.StatusCreated {
		t.Fatalf("status %d: %s", response.Code, response.Body.String())
	}
	if calls != 1 {
		t.Fatalf("chat saves = %d, want 1", calls)
	}
}

func TestAdoptWorkspaceSessionIsIdempotentAndCatalogMarksSource(t *testing.T) {
	s, st, ws := newChatCreateTestServer(t)
	agentDir := t.TempDir()
	t.Setenv("OMO_CODING_AGENT_DIR", agentDir)
	source := writeAdoptableDiskSession(t, agentDir, ws.Path, "durable-2", "Adopt once")
	body := map[string]string{"id": "durable-2", "resumeIdentity": source}

	first := adoptWorkspaceSession(t, s, ws.ID, body)
	if first.Code != http.StatusCreated {
		t.Fatalf("first status = %d, body = %s", first.Code, first.Body.String())
	}
	firstStored := st.ListChats(ws.ID)[0]
	copyFile, err := os.OpenFile(firstStored.SessionFile, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := copyFile.WriteString("{\"type\":\"message\",\"id\":\"webchat-turn\"}\n"); err != nil {
		_ = copyFile.Close()
		t.Fatal(err)
	}
	if err := copyFile.Close(); err != nil {
		t.Fatal(err)
	}
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
