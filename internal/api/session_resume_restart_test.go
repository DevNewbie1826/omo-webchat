package api

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/lxzan/gws"

	"github.com/DevNewbie1826/omo-webchat/internal/auth"
	"github.com/DevNewbie1826/omo-webchat/internal/config"
	"github.com/DevNewbie1826/omo-webchat/internal/store"
)

// TestNewChatSessionIdentitySurvivesServerRestart is the lost-memory contract:
// a provider-created identity, rather than the web chat id, is durable state.
// The restarted server hands the exact persisted identity to open_session as
// its sessionPath, and only then does the provider report the session's own
// history.
func TestNewChatSessionIdentitySurvivesServerRestart(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skipf("node not in PATH: %v", err)
	}
	for _, test := range []struct {
		provider, identity, commands, history string
	}{
		{provider: "omo", identity: "/provider/sessions/resume-omo-exact-7f3.jsonl", commands: "get_commands", history: "get_entries"},
	} {
		t.Run(test.provider, func(t *testing.T) {
			home := t.TempDir()
			t.Setenv("HOME", home)
			t.Setenv("CHAT_PI_BINARY", "node")
			resumeProvider, err := filepath.Abs(filepath.Join("testdata", "resume_pi.mjs"))
			if err != nil {
				t.Fatalf("resolve resume provider fixture: %v", err)
			}
			t.Setenv("CHAT_PI_ARGS", resumeProvider)
			// The mock persists the actual first process history here and reloads
			// it only when open_session resumes the durable identity.
			t.Setenv("MOCK_PI_RESUME_CONTRACT", filepath.Join(home, "provider-resume-contract.json"))
			// The mock reports this exact durable identity (state.sessionFile) so
			// the persisted value is deterministic across the restart.
			t.Setenv("MOCK_PI_RESUME_IDENTITY", test.identity)
			logger := slog.New(slog.NewTextHandler(io.Discard, nil))

			ctx1, cancel1 := context.WithCancel(t.Context())
			st1, err := store.Load(ctx1, logger)
			if err != nil {
				t.Fatalf("load initial store: %v", err)
			}
			workspace, err := st1.CreateWorkspace("restart-contract", home)
			if err != nil {
				t.Fatalf("create workspace: %v", err)
			}
			chatRecord, err := st1.NewChat(workspace.ID, "new-chat", workspace.Path, "", test.provider)
			if err != nil {
				t.Fatalf("add chat: %v", err)
			}
			api1, http1, client1, frames1 := startRestartContractServer(t, ctx1, home, st1, logger)
			writeFrame(t, client1, map[string]any{"type": "chat.create", "wsId": workspace.ID, "chatId": chatRecord.ID})
			frames1.waitFor(t, "state", 3*time.Second)
			writeFrame(t, client1, map[string]any{"type": "chat.send", "sessionId": chatRecord.ID, "run": map[string]any{"kind": "prompt", "message": "history survives restart"}})
			frames1.waitFor(t, "run.done", 3*time.Second)
			stored, err := st1.GetChat(workspace.ID, chatRecord.ID)
			if err != nil {
				t.Fatalf("get chat before restart: %v", err)
			}
			if stored.PiSessionID != test.identity {
				t.Fatalf("provider identity before restart = %q, want %q", stored.PiSessionID, test.identity)
			}

			_ = client1.WriteClose(1000, nil)
			http1.CloseClientConnections()
			http1.Close()
			api1.chats.CloseAll()
			cancel1()

			st2, err := store.Load(t.Context(), logger)
			if err != nil {
				t.Fatalf("reload store after shutdown: %v", err)
			}
			reloaded, err := st2.GetChat(workspace.ID, chatRecord.ID)
			if err != nil {
				t.Fatalf("get reloaded chat: %v", err)
			}
			if reloaded.PiSessionID != test.identity {
				t.Fatalf("reloaded provider identity = %q, want %q", reloaded.PiSessionID, test.identity)
			}

			restartLog := filepath.Join(home, "restart-rpc.log")
			restartJSONLog := filepath.Join(home, "restart-rpc.jsonl")
			t.Setenv("MOCK_PI_LOG", restartLog)
			t.Setenv("MOCK_PI_LOG_JSON", restartJSONLog)
			ctx2, cancel2 := context.WithCancel(t.Context())
			defer cancel2()
			api2, http2, client2, frames2 := startRestartContractServer(t, ctx2, home, st2, logger)
			defer api2.chats.CloseAll()
			defer http2.Close()
			defer http2.CloseClientConnections()
			defer func() { _ = client2.WriteClose(1000, nil) }()
			writeFrame(t, client2, map[string]any{"type": "chat.create", "wsId": workspace.ID, "chatId": chatRecord.ID})
			entriesRaw := waitForRestartFrame(t, frames2, "entries", 3*time.Second)

			wantRPCs := []string{"open_session", "get_state", "get_available_models", test.commands, test.history}
			if got := readLogLines(t, restartLog); !reflect.DeepEqual(got, wantRPCs) {
				t.Fatalf("restart RPC order = %v, want exact identity resume before queries %v", got, wantRPCs)
			}
			rpcLines := readLogLines(t, restartJSONLog)
			if len(rpcLines) == 0 {
				t.Fatal("missing restart JSON RPC log")
			}
			var openCommand map[string]any
			if err := json.Unmarshal([]byte(rpcLines[0]), &openCommand); err != nil {
				t.Fatalf("decode restart open command: %v", err)
			}
			if openCommand["type"] != "open_session" || openCommand["sessionPath"] != test.identity {
				t.Fatalf("restart open command = %#v, want open_session with sessionPath %q", openCommand, test.identity)
			}
			var entries struct {
				Entries json.RawMessage `json:"entries"`
			}
			if err := json.Unmarshal(entriesRaw, &entries); err != nil {
				t.Fatalf("decode resumed entries: %v", err)
			}
			if !strings.Contains(string(entries.Entries), "history survives restart") {
				t.Fatalf("resumed history = %s, want original prompt from provider session %q", entries.Entries, test.identity)
			}
		})
	}
}

func startRestartContractServer(t *testing.T, ctx context.Context, home string, st *store.Store, logger *slog.Logger) (*Server, *httptest.Server, *gws.Conn, *frameCollector) {
	t.Helper()
	apiServer := New(ctx, &config.Config{Root: home}, st, auth.NewSessionStore(ctx, "pw", logger), logger)
	httpServer := httptest.NewServer(http.HandlerFunc(apiServer.handleWS))
	frames := &frameCollector{notify: make(chan struct{}, 256)}
	client, _, err := gws.NewClient(frames, &gws.ClientOption{Addr: "ws" + strings.TrimPrefix(httpServer.URL, "http")})
	if err != nil {
		httpServer.Close()
		t.Fatalf("connect websocket: %v", err)
	}
	go client.ReadLoop()
	return apiServer, httpServer, client, frames
}

func waitForRestartFrame(t *testing.T, frames *frameCollector, typ string, timeout time.Duration) []byte {
	t.Helper()
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	seen := 0
	for {
		snapshot := frames.snapshot()
		for ; seen < len(snapshot); seen++ {
			var envelope struct {
				Type string `json:"type"`
			}
			if json.Unmarshal(snapshot[seen], &envelope) == nil && envelope.Type == typ {
				return snapshot[seen]
			}
		}
		select {
		case <-frames.notify:
		case <-timer.C:
			t.Fatalf("timed out waiting for %q frame; have: %s", typ, frames.types())
		}
	}
}
