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
	"github.com/DevNewbie1826/omo-webchat/internal/config"
	"github.com/DevNewbie1826/omo-webchat/internal/store"
)

// persistChatForTest writes a chat record directly so tests can pin provider
// identities handleCreateChat itself would never accept.
func persistChatForTest(t *testing.T, st *store.Store, ws store.Workspace, name, provider, piSessionID string) store.Chat {
	t.Helper()
	record, err := st.NewChat(ws.ID, name, ws.Path, "", provider)
	if err != nil {
		t.Fatalf("persist %s chat: %v", name, err)
	}
	if piSessionID == "" {
		return record
	}
	record, err = st.UpdateChat(ws.ID, record.ID, func(c *store.Chat) {
		c.PiSessionID = piSessionID
	})
	if err != nil {
		t.Fatalf("persist %s identity: %v", name, err)
	}
	return record
}

// TestChatCreateRejectsUnsupportedPersistedProvider pins the launch gate for
// chats persisted for a runtime omo cannot resume: chat.create answers with a
// precise bad_provider error, never spawns a provider process or session, and
// leaves the persisted record verbatim while listings stay without it.
func TestChatCreateRejectsUnsupportedPersistedProvider(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skipf("node not in PATH: %v", err)
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CHAT_PI_BINARY", "node")
	t.Setenv("CHAT_PI_ARGS", mockPiPath(t))
	rpcLog := filepath.Join(home, "rpc.log")
	t.Setenv("MOCK_PI_LOG", rpcLog)

	ctx := context.Background()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	st, err := store.Load(ctx, logger)
	if err != nil {
		t.Fatalf("load store: %v", err)
	}
	ws, err := st.CreateWorkspace("demo", home)
	if err != nil {
		t.Fatalf("create workspace: %v", err)
	}
	record := persistChatForTest(t, st, ws, "omp-chat", "omp", "pi-omp-identity")

	apiServer := New(ctx, &config.Config{Root: home}, st, auth.NewSessionStore(ctx, "pw", logger), logger)
	t.Cleanup(apiServer.chats.CloseAll)
	server := httptest.NewServer(http.HandlerFunc(apiServer.handleWS))
	defer server.Close()
	defer server.CloseClientConnections()

	frames := &frameCollector{notify: make(chan struct{}, 64)}
	client, _, err := gws.NewClient(frames, &gws.ClientOption{Addr: "ws" + strings.TrimPrefix(server.URL, "http")})
	if err != nil {
		t.Fatalf("connect ws: %v", err)
	}
	defer func() { _ = client.WriteClose(1000, nil) }()
	go client.ReadLoop()

	writeFrame(t, client, map[string]any{"type": "chat.create", "wsId": ws.ID, "chatId": record.ID})
	gotErr := frames.waitForErrorCode(t, "bad_provider")
	if gotErr.Message != "unsupported chat provider" {
		t.Fatalf("bad_provider message = %q, want unsupported chat provider", gotErr.Message)
	}
	if session := apiServer.chats.Get(record.ID); session != nil {
		t.Fatalf("unsupported chat spawned session %p", session)
	}
	if raw, err := os.ReadFile(rpcLog); err == nil && strings.TrimSpace(string(raw)) != "" {
		t.Fatalf("unsupported chat talked to a provider process: %s", raw)
	} else if err != nil && !os.IsNotExist(err) {
		t.Fatalf("read rpc log: %v", err)
	}
	persisted, err := st.GetChat(ws.ID, record.ID)
	if err != nil {
		t.Fatalf("raw unsupported lookup: %v", err)
	}
	if persisted.Provider != "omp" || persisted.PiSessionID != "pi-omp-identity" {
		t.Fatalf("unsupported record mutated on rejection: %#v", persisted)
	}
	listed, err := st.GetWorkspace(ws.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(listed.Chats) != 0 {
		t.Fatalf("listing shows %d unsupported chats, want none", len(listed.Chats))
	}
}

// TestChatCreateLaunchesLegacyProviderChatsAsOmo covers the resume contract for
// legacy launchable identities: empty and senpi records launch as omo, resume
// with their exact persisted provider identity, and never persist the alias.
func TestChatCreateLaunchesLegacyProviderChatsAsOmo(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skipf("node not in PATH: %v", err)
	}
	for _, legacyProvider := range []string{"", "senpi"} {
		t.Run("provider "+legacyProvider, func(t *testing.T) {
			home := t.TempDir()
			t.Setenv("HOME", home)
			t.Setenv("CHAT_PI_BINARY", "node")
			t.Setenv("CHAT_PI_ARGS", mockPiPath(t))
			const legacyIdentity = "legacy-resume-id"
			rpcLog := filepath.Join(home, "rpc.log")
			jsonLog := filepath.Join(home, "rpc.jsonl")
			t.Setenv("MOCK_PI_LOG", rpcLog)
			t.Setenv("MOCK_PI_LOG_JSON", jsonLog)
			// The mock reports the resumed identity as its durable identity
			// (state.sessionFile), so the store keeps the exact resumed value.
			t.Setenv("MOCK_PI_RESUME_IDENTITY", legacyIdentity)

			ctx := context.Background()
			logger := slog.New(slog.NewTextHandler(io.Discard, nil))
			st, err := store.Load(ctx, logger)
			if err != nil {
				t.Fatalf("load store: %v", err)
			}
			ws, err := st.CreateWorkspace("demo", home)
			if err != nil {
				t.Fatalf("create workspace: %v", err)
			}
			record := persistChatForTest(t, st, ws, "legacy", legacyProvider, legacyIdentity)

			apiServer := New(ctx, &config.Config{Root: home}, st, auth.NewSessionStore(ctx, "pw", logger), logger)
			t.Cleanup(apiServer.chats.CloseAll)
			server := httptest.NewServer(http.HandlerFunc(apiServer.handleWS))
			defer server.Close()
			defer server.CloseClientConnections()

			frames := &frameCollector{notify: make(chan struct{}, 256)}
			client, _, err := gws.NewClient(frames, &gws.ClientOption{Addr: "ws" + strings.TrimPrefix(server.URL, "http")})
			if err != nil {
				t.Fatalf("connect ws: %v", err)
			}
			defer func() { _ = client.WriteClose(1000, nil) }()
			go client.ReadLoop()

			writeFrame(t, client, map[string]any{"type": "chat.create", "wsId": ws.ID, "chatId": record.ID})
			var ready struct {
				Type        string `json:"type"`
				PiSessionID string `json:"piSessionId"`
				Resumed     bool   `json:"resumed"`
			}
			if err := json.Unmarshal(waitForRestartFrame(t, frames, "ready", 3*time.Second), &ready); err != nil {
				t.Fatalf("decode ready: %v", err)
			}
			if !ready.Resumed {
				t.Fatal("legacy chat launched without resuming its persisted identity")
			}
			if ready.PiSessionID != legacyIdentity {
				t.Fatalf("resumed identity = %q, want %q", ready.PiSessionID, legacyIdentity)
			}
			frames.waitFor(t, "entries", 3*time.Second)

			wantOrder := []string{"open_session", "get_state", "get_available_models", "get_commands", "get_entries"}
			if got := readLogLines(t, rpcLog); !reflect.DeepEqual(got, wantOrder) {
				t.Fatalf("rpc order = %v, want legacy identity resumed before queries %v", got, wantOrder)
			}
			lines := readLogLines(t, jsonLog)
			if len(lines) == 0 {
				t.Fatal("missing JSON RPC log")
			}
			var openCommand map[string]any
			if err := json.Unmarshal([]byte(lines[0]), &openCommand); err != nil {
				t.Fatalf("decode open command: %v", err)
			}
			if openCommand["type"] != "open_session" || openCommand["sessionPath"] != legacyIdentity {
				t.Fatalf("first rpc = %#v, want open_session with sessionPath %q", openCommand, legacyIdentity)
			}

			persisted, err := st.GetChat(ws.ID, record.ID)
			if err != nil {
				t.Fatalf("raw legacy lookup: %v", err)
			}
			if persisted.Provider != legacyProvider {
				t.Fatalf("launch persisted provider alias %q; want persisted %q untouched", persisted.Provider, legacyProvider)
			}
			// The provider re-reports its live identity on get_state, so the store
			// may legitimately track a new value; what must never happen is losing
			// the resume identity entirely or persisting the provider alias.
			if persisted.PiSessionID == "" {
				t.Fatal("legacy chat lost its provider identity during launch")
			}
			listed, err := st.GetWorkspace(ws.ID)
			if err != nil {
				t.Fatal(err)
			}
			if len(listed.Chats) != 1 || listed.Chats[0].Provider != "omo" {
				t.Fatalf("listing = %#v, want the legacy chat projected as omo", listed.Chats)
			}
		})
	}
}
