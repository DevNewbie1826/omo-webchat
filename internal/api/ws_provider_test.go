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

func TestWebSocketChatCommandsDiscoveryByProvider(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skipf("node not in PATH: %v", err)
	}
	cases := []struct {
		name            string
		provider        string
		wantCommandsRPC string
		wantResumeRPC   string
	}{
		{name: "omo", provider: "omo", wantCommandsRPC: "get_commands", wantResumeRPC: "get_entries"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			tmp := t.TempDir()
			t.Setenv("HOME", tmp)
			t.Setenv("CHAT_PI_BINARY", "node")
			t.Setenv("CHAT_PI_ARGS", mockPiPath(t))
			logFile := filepath.Join(tmp, "rpc.log")
			t.Setenv("MOCK_PI_LOG", logFile)

			ctx := context.Background()
			logger := slog.New(slog.NewTextHandler(io.Discard, nil))
			st, err := store.Load(ctx, logger)
			if err != nil {
				t.Fatalf("load store: %v", err)
			}
			ws, err := st.CreateWorkspace("demo", tmp)
			if err != nil {
				t.Fatalf("create workspace: %v", err)
			}
			chatRec, err := st.NewChat(ws.ID, tc.provider, ws.Path, "", tc.provider)
			if err != nil {
				t.Fatalf("create chat: %v", err)
			}
			sessions := auth.NewSessionStore(ctx, "pw", logger)
			apiServer := New(ctx, &config.Config{Root: tmp}, st, sessions, logger)
			t.Cleanup(apiServer.chats.CloseAll)
			server := httptest.NewServer(http.HandlerFunc(apiServer.handleWS))
			defer server.Close()
			defer server.CloseClientConnections()

			collector := &frameCollector{notify: make(chan struct{}, 256)}
			client, _, err := gws.NewClient(collector, &gws.ClientOption{Addr: "ws" + strings.TrimPrefix(server.URL, "http")})
			if err != nil {
				t.Fatalf("connect ws: %v", err)
			}
			t.Cleanup(func() { _ = client.WriteClose(1000, nil) })
			go client.ReadLoop()

			writeFrame(t, client, map[string]any{"type": "chat.create", "wsId": ws.ID, "chatId": chatRec.ID, "provider": tc.provider})
			collector.waitFor(t, "ready", 3*time.Second)
			collector.waitFor(t, "commands", 3*time.Second)
			collector.waitFor(t, "entries", 3*time.Second)

			var commands chatCommandsFrame
			for _, b := range collector.snapshot() {
				var env struct {
					Type string `json:"type"`
				}
				if json.Unmarshal(b, &env) == nil && env.Type == "commands" {
					if err := json.Unmarshal(b, &commands); err != nil {
						t.Fatalf("decode commands frame: %v", err)
					}
					break
				}
			}
			if len(commands.Commands) == 0 {
				t.Fatalf("expected commands frame to be populated; types: %s", collector.types())
			}
			for _, raw := range collector.snapshot() {
				var env struct {
					Type string `json:"type"`
				}
				if json.Unmarshal(raw, &env) == nil && env.Type == "commands" {
					if strings.Contains(string(raw), "location") {
						t.Fatalf("commands frame carries the fake location field: %s", raw)
					}
				}
			}
			var sawSlash bool
			for _, command := range commands.Commands {
				if command.Syntax == "slash" && command.Source != "" {
					sawSlash = true
				}
			}
			if !sawSlash {
				t.Fatalf("commands frame lacks a real-schema slash entry: %+v", commands.Commands)
			}

			gotLog := readLogLines(t, logFile)
			wantLog := []string{"open_session", "get_state", "get_available_models", tc.wantCommandsRPC, tc.wantResumeRPC}
			if !reflect.DeepEqual(gotLog, wantLog) {
				t.Fatalf("rpc log = %v, want %v", gotLog, wantLog)
			}
		})
	}
}

type chatCommandEntry struct {
	Name       string `json:"name"`
	Source     string `json:"source"`
	Syntax     string `json:"syntax"`
	SourceInfo *struct {
		Path   string `json:"path"`
		Source string `json:"source"`
	} `json:"sourceInfo"`
}

type chatCommandsFrame struct {
	Type      string             `json:"type"`
	SessionID string             `json:"sessionId"`
	Commands  []chatCommandEntry `json:"commands"`
}

func readLogLines(t *testing.T, path string) []string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read rpc log: %v", err)
	}
	text := strings.TrimSpace(string(b))
	if text == "" {
		return nil
	}
	return strings.Split(text, "\n")
}
