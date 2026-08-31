package api

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/lxzan/gws"

	"github.com/DevNewbie1826/omo-webchat/internal/auth"
	"github.com/DevNewbie1826/omo-webchat/internal/chat"
	"github.com/DevNewbie1826/omo-webchat/internal/config"
	"github.com/DevNewbie1826/omo-webchat/internal/store"
)

type providerWSHarness struct {
	store     *store.Store
	workspace store.Workspace
	chat      store.Chat
	server    *Server
	client    *gws.Conn
	frames    *frameCollector
}

func newProviderWSHarness(t *testing.T, provider, persistedIdentity string, env map[string]string) *providerWSHarness {
	t.Helper()
	if _, err := exec.LookPath("node"); err != nil {
		t.Skipf("node not in PATH: %v", err)
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CHAT_PI_BINARY", "node")
	t.Setenv("CHAT_PI_ARGS", mockPiPath(t))
	for key, value := range env {
		t.Setenv(key, value)
	}

	ctx := context.Background()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	st, err := store.Load(ctx, logger)
	if err != nil {
		t.Fatalf("load store: %v", err)
	}
	workspace, err := st.CreateWorkspace("demo", home)
	if err != nil {
		t.Fatalf("create workspace: %v", err)
	}
	chatRecord, err := st.NewChat(workspace.ID, provider, workspace.Path, "", provider)
	if err != nil {
		t.Fatalf("create chat: %v", err)
	}
	if persistedIdentity != "" {
		chatRecord, err = st.UpdateChat(workspace.ID, chatRecord.ID, func(record *store.Chat) {
			record.PiSessionID = persistedIdentity
		})
		if err != nil {
			t.Fatalf("persist resume identity: %v", err)
		}
	}

	apiServer := New(ctx, &config.Config{Root: home}, st, auth.NewSessionStore(ctx, "pw", logger), logger)
	httpServer := httptest.NewServer(http.HandlerFunc(apiServer.handleWS))
	t.Cleanup(httpServer.Close)
	t.Cleanup(httpServer.CloseClientConnections)
	frames := &frameCollector{notify: make(chan struct{}, 256)}
	client, _, err := gws.NewClient(frames, &gws.ClientOption{Addr: "ws" + strings.TrimPrefix(httpServer.URL, "http")})
	if err != nil {
		t.Fatalf("connect ws: %v", err)
	}
	t.Cleanup(func() { _ = client.WriteClose(1000, nil) })
	go client.ReadLoop()
	return &providerWSHarness{store: st, workspace: workspace, chat: chatRecord, server: apiServer, client: client, frames: frames}
}

func (h *providerWSHarness) create(t *testing.T) {
	t.Helper()
	writeFrame(t, h.client, map[string]any{
		"type":     "chat.create",
		"wsId":     h.workspace.ID,
		"chatId":   h.chat.ID,
		"provider": "stale-client-provider",
	})
}

func failOpenPiPath(t *testing.T) string {
	t.Helper()
	wd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(wd, "testdata", "failing_open_pi.mjs")
	if _, err := os.Stat(p); err != nil {
		t.Skipf("failing_open_pi fixture not found: %v", err)
	}
	return p
}

func TestWebSocketPersistsProviderResumeIdentityAcrossReload(t *testing.T) {
	tests := []struct {
		provider string
		want     string
	}{
		{provider: "omo", want: "mock-omo-session"},
	}
	for _, test := range tests {
		t.Run(test.provider, func(t *testing.T) {
			// The mock reports its durable identity as state.sessionFile, so the
			// persisted value is deterministic.
			harness := newProviderWSHarness(t, test.provider, "", map[string]string{
				"MOCK_PI_RESUME_IDENTITY": test.want,
			})
			harness.create(t)
			harness.frames.waitFor(t, "state", 3*time.Second)

			persisted, err := harness.store.GetChat(harness.workspace.ID, harness.chat.ID)
			if err != nil {
				t.Fatalf("get persisted chat: %v", err)
			}
			if persisted.PiSessionID != test.want {
				t.Fatalf("persisted identity = %q, want %q", persisted.PiSessionID, test.want)
			}

			logger := slog.New(slog.NewTextHandler(io.Discard, nil))
			reloaded, err := store.Load(context.Background(), logger)
			if err != nil {
				t.Fatalf("reload store: %v", err)
			}
			persisted, err = reloaded.GetChat(harness.workspace.ID, harness.chat.ID)
			if err != nil {
				t.Fatalf("get reloaded chat: %v", err)
			}
			if persisted.PiSessionID != test.want {
				t.Fatalf("reloaded identity = %q, want %q", persisted.PiSessionID, test.want)
			}
		})
	}
}

// TestWebSocketReconnectResumesIdentityBeforeQueries pins the reconnect
// ordering contract: the persisted durable identity is handed to open_session
// as sessionPath before any bootstrap query, so the provider restores the
// session's history before get_entries asks for it.
func TestWebSocketReconnectResumesIdentityBeforeQueries(t *testing.T) {
	tests := []struct {
		provider string
		identity string
	}{
		{provider: "omo", identity: "omo-resume-id"},
	}
	for _, test := range tests {
		t.Run(test.provider, func(t *testing.T) {
			logFile := filepath.Join(t.TempDir(), "rpc.log")
			jsonLogFile := filepath.Join(t.TempDir(), "rpc.jsonl")
			harness := newProviderWSHarness(t, test.provider, test.identity, map[string]string{
				"MOCK_PI_LOG":      logFile,
				"MOCK_PI_LOG_JSON": jsonLogFile,
			})
			harness.create(t)
			harness.frames.waitFor(t, "entries", 3*time.Second)

			wantCommands := "get_commands"
			wantHistory := "get_entries"
			wantOrder := []string{"open_session", "get_state", "get_available_models", wantCommands, wantHistory}
			if got := readLogLines(t, logFile); !reflect.DeepEqual(got, wantOrder) {
				t.Fatalf("rpc order = %v, want %v", got, wantOrder)
			}
			lines := readLogLines(t, jsonLogFile)
			if len(lines) == 0 {
				t.Fatal("missing JSON RPC log")
			}
			var command map[string]any
			if err := json.Unmarshal([]byte(lines[0]), &command); err != nil {
				t.Fatalf("decode open command: %v", err)
			}
			if command["type"] != "open_session" {
				t.Fatalf("first rpc = %#v, want open_session", command)
			}
			if command["sessionPath"] != test.identity {
				t.Fatalf("open sessionPath = %#v, want %q", command["sessionPath"], test.identity)
			}
		})
	}
}

// TestWebSocketPersistedResumeFailureInitializesFreshWithoutRebinding pins
// the stale-identity contract: a persisted sessionPath the provider cannot
// resume is reported as resume_failed and a fresh cwd-backed session
// initializes — the chat must never brick on a dead identity — but the
// stored binding is preserved verbatim: a failed resume (or a transient
// session_path_in_use race) can no longer silently rebind the chat away
// from its original session file.
func TestWebSocketPersistedResumeFailureInitializesFreshWithoutRebinding(t *testing.T) {
	staleIdentity := filepath.Join(t.TempDir(), "missing", "session.jsonl")
	logFile := filepath.Join(t.TempDir(), "rpc.log")
	jsonLogFile := filepath.Join(t.TempDir(), "rpc.jsonl")
	harness := newProviderWSHarness(t, "omo", staleIdentity, map[string]string{
		"CHAT_PI_ARGS":     failOpenPiPath(t),
		"MOCK_PI_LOG":      logFile,
		"MOCK_PI_LOG_JSON": jsonLogFile,
	})
	harness.create(t)
	harness.frames.waitFor(t, "entries", 5*time.Second)

	var gotError chat.ErrorFrame
	var rawErrorFrame map[string]any
	for _, raw := range harness.frames.snapshot() {
		var envelope struct {
			Type string `json:"type"`
		}
		_ = json.Unmarshal(raw, &envelope)
		if envelope.Type == "error" {
			_ = json.Unmarshal(raw, &gotError)
			_ = json.Unmarshal(raw, &rawErrorFrame)
			break
		}
	}
	if gotError.Code != "resume_failed" || gotError.Command != "" {
		t.Fatalf("error = %+v, want resume_failed without provider_error command", gotError)
	}

	persisted, err := harness.store.GetChat(harness.workspace.ID, harness.chat.ID)
	if err != nil {
		t.Fatalf("get persisted chat: %v", err)
	}
	if persisted.PiSessionID != staleIdentity {
		t.Fatalf("stored identity = %q, want the original binding preserved (never wiped or replaced by the fresh session)", persisted.PiSessionID)
	}

	wantOrder := []string{"open_session", "open_session", "get_state", "get_available_models", "get_commands", "get_entries"}
	if got := readLogLines(t, logFile); !reflect.DeepEqual(got, wantOrder) {
		t.Fatalf("rpc order after failed resume = %v, want doomed resume attempt then fresh initialization %v", got, wantOrder)
	}
	lines := readLogLines(t, jsonLogFile)
	var opens []map[string]any
	for _, line := range lines {
		var cmd map[string]any
		if err := json.Unmarshal([]byte(line), &cmd); err != nil {
			t.Fatalf("decode rpc command %s: %v", line, err)
		}
		if cmd["type"] == "open_session" {
			opens = append(opens, cmd)
		}
	}
	if len(opens) != 2 {
		t.Fatalf("open_session commands = %d (log %v), want the doomed resume attempt plus one fresh open", len(opens), lines)
	}
	if opens[0]["sessionPath"] != staleIdentity {
		t.Fatalf("resume open sessionPath = %#v, want the stale persisted identity (the provider owns validity)", opens[0]["sessionPath"])
	}
	if _, carried := opens[1]["sessionPath"]; carried {
		t.Fatalf("fresh open = %#v, want a cwd-backed open without sessionPath", opens[1])
	}

	// The same raw error frame must also carry the dangling-recovery signal
	// for the client: the stored path is a dangling absolute path, so
	// dangling=true, the stored identity is echoed verbatim, and no branch
	// candidates are attached (none are wired). Decoded as raw JSON so this
	// compiles before the fields exist on ErrorFrame; a missing field is an
	// assertion failure, never a compile error.
	if flag, isBool := rawErrorFrame["dangling"].(bool); !isBool || !flag {
		t.Fatalf("error frame dangling = %#v, want true for missing path %q; frame: %v", rawErrorFrame["dangling"], staleIdentity, rawErrorFrame)
	}
	if got, _ := rawErrorFrame["storedIdentity"].(string); got != staleIdentity {
		t.Fatalf("error frame storedIdentity = %#v, want %q", rawErrorFrame["storedIdentity"], staleIdentity)
	}
	if rawCandidates, present := rawErrorFrame["branchCandidates"]; present {
		if candidates, ok := rawCandidates.([]any); !ok || len(candidates) != 0 {
			t.Fatalf("error frame branchCandidates = %#v, want absent or empty", rawCandidates)
		}
	}
}

// TestOldSocketCloseDoesNotStopNewSession pins the stale-socket contract: a
// chat.close from a handler bound to the previous generation of a chat only
// detaches that socket and never stops the chat's live session.
func TestOldSocketCloseDoesNotStopNewSession(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skipf("node not in PATH: %v", err)
	}
	manager := chat.NewManager()
	t.Cleanup(manager.CloseAll)
	server := &Server{chats: manager}
	opts := chat.SessionOptions{ID: "chat-1", Binary: node, Args: []string{mockPiPath(t)}, Env: os.Environ()}
	oldSession, started, err := manager.Acquire(context.Background(), opts)
	if err != nil {
		t.Fatalf("start old session: %v", err)
	}
	if !started {
		t.Fatal("first acquire did not start the session")
	}
	// The old generation ends and the client reconnects: the manager opens a
	// fresh logical session for the same chat id on its shared provider.
	if err := oldSession.Close(); err != nil {
		t.Fatalf("close old session: %v", err)
	}
	newSession, started, err := manager.Acquire(context.Background(), opts)
	if err != nil {
		t.Fatalf("start new session: %v", err)
	}
	if !started {
		t.Fatal("reconnect did not start a new session")
	}
	if newSession == oldSession {
		t.Fatal("reconnect reused the closed session")
	}

	detachCalls := 0
	oldHandler := &connHandler{
		srv:     server,
		chatID:  opts.ID,
		session: oldSession,
		detach:  func() { detachCalls++ },
	}
	server.routeMessage(oldHandler, []byte(`{"type":"chat.close","sessionId":"chat-1"}`))

	if detachCalls != 1 {
		t.Fatalf("stale socket detach calls = %d, want 1", detachCalls)
	}
	if got := manager.Get(opts.ID); got != newSession {
		t.Fatalf("current session after stale close = %p, want %p", got, newSession)
	}
	if err := newSession.QueryState(); err != nil {
		t.Fatalf("new session was stopped by stale socket: %v", err)
	}
}
