package api

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
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

	"github.com/DevNewbie1826/omo-webchat/internal/auth"
	"github.com/DevNewbie1826/omo-webchat/internal/config"
	"github.com/DevNewbie1826/omo-webchat/internal/store"
)

// The provider fixture executed as a child process by
// TestChatProviderStderrUsesStateDir. It announces itself on stderr with a
// unique marker, then serves the minimal multi-session RPC the create flow
// needs (every id-carrying command gets a success response; open_session
// additionally carries a routing handle). Using the test binary itself keeps
// the fixture dependency-free: no node, no skip.
const (
	providerStderrHelperEnv = "OMO_PROVIDER_STDERR_HELPER"
	providerStderrMarker    = "omo-provider-stderr-state-dir-marker"
)

func (f *frameCollector) snapshotRaw() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return string(bytes.Join(f.frames, []byte("\n")))
}

func TestChatProviderStderrHelperProcess(t *testing.T) {
	if os.Getenv(providerStderrHelperEnv) != "1" {
		return
	}
	// The stderr marker is the assertion payload: it must land in the state
	// directory's rotating capture file.
	if _, err := os.Stderr.WriteString(providerStderrMarker + "\n"); err != nil {
		os.Exit(3)
	}
	reader := bufio.NewReader(os.Stdin)
	writer := bufio.NewWriter(os.Stdout)
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			os.Exit(0)
		}
		var cmd struct {
			ID   string `json:"id"`
			Type string `json:"type"`
		}
		if json.Unmarshal([]byte(line), &cmd) != nil || cmd.ID == "" {
			continue
		}
		resp := map[string]any{
			"type":    "response",
			"command": cmd.Type,
			"success": true,
			"id":      cmd.ID,
		}
		if cmd.Type == "open_session" {
			resp["sessionId"] = "helper-route"
			resp["data"] = map[string]any{
				"sessionId": "helper-route",
				"state":     map[string]any{"sessionId": "helper-route"},
			}
		}
		b, merr := json.Marshal(resp)
		if merr != nil {
			os.Exit(3)
		}
		if _, werr := writer.Write(b); werr != nil {
			os.Exit(0)
		}
		if werr := writer.WriteByte('\n'); werr != nil || writer.Flush() != nil {
			os.Exit(0)
		}
	}
}

// TestChatProviderStderrUsesStateDir proves the whole stderr wiring end to
// end: chat.create resolves the provider stderr path from the state
// directory (XDG_STATE_HOME), startSharedProvider forwards it into the
// Process, and the real provider process's stderr lands in the rotating
// capture file on disk. No skip: the provider is this test binary re-executed
// as a helper process.
func TestChatProviderStderrUsesStateDir(t *testing.T) {
	stateHome := t.TempDir()
	t.Setenv("XDG_STATE_HOME", stateHome)
	t.Setenv(providerStderrHelperEnv, "1")
	home := t.TempDir()
	t.Setenv("HOME", home)

	exe, err := os.Executable()
	if err != nil {
		t.Fatalf("resolve test binary: %v", err)
	}
	t.Setenv("CHAT_PI_BINARY", exe)
	t.Setenv("CHAT_PI_ARGS", "-test.run=TestChatProviderStderrHelperProcess,--")

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
	record := persistChatForTest(t, st, ws, "stderr-capture", "", "")

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
	// Bounded wait for the ready frame; on timeout, dump every frame received
	// so the failure is diagnosable.
	deadline := time.Now().Add(15 * time.Second)
	for {
		for _, b := range frames.snapshot() {
			var env struct {
				Type string `json:"type"`
			}
			if json.Unmarshal(b, &env) == nil && env.Type == "ready" {
				goto ready
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("chat.create never became ready; frames received: %s", frames.snapshotRaw())
		}
		time.Sleep(25 * time.Millisecond)
	}
ready:

	// The provider's stderr must have been captured into the state
	// directory's rotating file pair — read from the real file on disk.
	stderrLog := filepath.Join(stateHome, "omo-webchat", "omo-provider.stderr.log")
	fileDeadline := time.Now().Add(10 * time.Second)
	for {
		b, rerr := os.ReadFile(stderrLog)
		if rerr == nil && strings.Contains(string(b), providerStderrMarker) {
			break
		}
		if time.Now().After(fileDeadline) {
			t.Fatalf("provider stderr %s never contained the marker (read err=%v)", stderrLog, rerr)
		}
		time.Sleep(25 * time.Millisecond)
	}
}
