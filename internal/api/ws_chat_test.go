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
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lxzan/gws"

	"github.com/DevNewbie1826/omo-webchat/internal/auth"
	"github.com/DevNewbie1826/omo-webchat/internal/config"
	"github.com/DevNewbie1826/omo-webchat/internal/store"
)

type frameCollector struct {
	gws.BuiltinEventHandler
	mu     sync.Mutex
	frames [][]byte
	notify chan struct{}
}

func (f *frameCollector) OnMessage(_ *gws.Conn, message *gws.Message) {
	defer func() { _ = message.Close() }()
	f.mu.Lock()
	f.frames = append(f.frames, append([]byte(nil), message.Bytes()...))
	f.mu.Unlock()
	select {
	case f.notify <- struct{}{}:
	default:
	}
}

func (f *frameCollector) snapshot() [][]byte {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([][]byte, len(f.frames))
	for i, fr := range f.frames {
		out[i] = append([]byte(nil), fr...)
	}
	return out
}

func (f *frameCollector) types() string {
	var sb strings.Builder
	for _, b := range f.snapshot() {
		var env struct {
			Type string `json:"type"`
		}
		_ = json.Unmarshal(b, &env)
		sb.WriteString(env.Type)
		sb.WriteByte(' ')
	}
	return sb.String()
}

func (f *frameCollector) waitFor(t *testing.T, typ string, timeout time.Duration) {
	t.Helper()
	deadline := time.After(timeout)
	for {
		for _, b := range f.snapshot() {
			var env struct {
				Type string `json:"type"`
			}
			if json.Unmarshal(b, &env) == nil && env.Type == typ {
				return
			}
		}
		select {
		case <-f.notify:
		case <-deadline:
			t.Fatalf("timed out waiting for %q frame; have: %s", typ, f.types())
		}
	}
}

func (f *frameCollector) waitForAfter(t *testing.T, typ string, start int, timeout time.Duration) int {
	t.Helper()
	deadline := time.After(timeout)
	for {
		frames := f.snapshot()
		for index := start; index < len(frames); index++ {
			var env struct {
				Type string `json:"type"`
			}
			if json.Unmarshal(frames[index], &env) == nil && env.Type == typ {
				return index + 1
			}
		}
		select {
		case <-f.notify:
		case <-deadline:
			t.Fatalf("timed out waiting for %q after frame %d; have: %s", typ, start, f.types())
		}
	}
}

func (f *frameCollector) hasType(typ string) bool {
	for _, b := range f.snapshot() {
		var env struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(b, &env) == nil && env.Type == typ {
			return true
		}
	}
	return false
}

func mockPiPath(t *testing.T) string {
	t.Helper()
	wd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(wd, "..", "..", "test", "mock-pi", "mock-pi.mjs")
	if _, err := os.Stat(p); err != nil {
		t.Skipf("mock-pi not found: %v", err)
	}
	return p
}

func writeFrame(t *testing.T, client *gws.Conn, v any) {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if err := client.WriteMessage(gws.OpcodeText, b); err != nil {
		t.Fatalf("write: %v", err)
	}
}

func TestWebSocketChatDisconnect(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skipf("node not in PATH: %v", err)
	}
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)
	t.Setenv("CHAT_PI_BINARY", "node")
	t.Setenv("CHAT_PI_ARGS", mockPiPath(t))

	ctx := context.Background()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	st, err := store.Load(ctx, logger)
	if err != nil {
		t.Fatalf("load store: %v", err)
	}
	ws, err := st.CreateWorkspace("disconnect-demo", tmp)
	if err != nil {
		t.Fatalf("create workspace: %v", err)
	}
	chat, err := st.NewChat(ws.ID, "disconnect-qa", ws.Path, "", "omo")
	if err != nil {
		t.Fatalf("create chat: %v", err)
	}
	sessions := auth.NewSessionStore(ctx, "pw", logger)
	apiServer := New(ctx, &config.Config{Root: tmp, Provider: "omo"}, st, sessions, logger)
	server := httptest.NewServer(http.HandlerFunc(apiServer.handleWS))
	defer server.Close()
	defer server.CloseClientConnections()

	collector := &frameCollector{notify: make(chan struct{}, 64)}
	wsConn, _, err := gws.NewClient(collector, &gws.ClientOption{Addr: "ws" + strings.TrimPrefix(server.URL, "http")})
	if err != nil {
		t.Fatalf("new ws client: %v", err)
	}
	defer wsConn.WriteClose(1000, nil)
	go wsConn.ReadLoop()
	writeFrame(t, wsConn, map[string]any{"type": "chat.create", "wsId": ws.ID, "chatId": chat.ID})
	collector.waitFor(t, "ready", 3*time.Second)
	collector.waitFor(t, "commands", 3*time.Second)
	if got := apiServer.chats.Get(chat.ID); got == nil {
		t.Fatal("session not registered after create")
	}
	writeFrame(t, wsConn, map[string]any{"type": "chat.disconnect", "sessionId": chat.ID})
	deadline := time.After(3 * time.Second)
	for {
		if apiServer.chats.Get(chat.ID) == nil {
			break
		}
		select {
		case <-deadline:
			t.Fatal("chat.disconnect did not end the chat session")
		case <-time.After(50 * time.Millisecond):
		}
	}
	if _, err := st.GetChat(ws.ID, chat.ID); err != nil {
		t.Fatalf("chat record was deleted by disconnect: %v", err)
	}

	// chat.disconnect ends exactly one chat session: the shared multi-session
	// provider process stays up, so a second chat on the same manager still
	// attaches and streams a full turn afterwards.
	survivor, err := st.NewChat(ws.ID, "disconnect-survivor", ws.Path, "", "omo")
	if err != nil {
		t.Fatalf("create survivor chat: %v", err)
	}
	survivorFrames := &frameCollector{notify: make(chan struct{}, 64)}
	survivorConn, _, err := gws.NewClient(survivorFrames, &gws.ClientOption{Addr: "ws" + strings.TrimPrefix(server.URL, "http")})
	if err != nil {
		t.Fatalf("new survivor ws client: %v", err)
	}
	defer func() { _ = survivorConn.WriteClose(1000, nil) }()
	go survivorConn.ReadLoop()
	writeFrame(t, survivorConn, map[string]any{"type": "chat.create", "wsId": ws.ID, "chatId": survivor.ID})
	survivorFrames.waitFor(t, "ready", 3*time.Second)
	writeFrame(t, survivorConn, map[string]any{
		"type":      "chat.send",
		"sessionId": survivor.ID,
		"run":       map[string]any{"kind": "prompt", "message": "still streaming"},
	})
	survivorFrames.waitFor(t, "run.done", 5*time.Second)
	if got := apiServer.chats.Get(chat.ID); got != nil {
		t.Fatalf("disconnected chat came back: %p", got)
	}
}

func TestWebSocketChatRoundTrip(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skipf("node not in PATH: %v", err)
	}
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)
	t.Setenv("CHAT_PI_BINARY", "node")
	t.Setenv("CHAT_PI_ARGS", mockPiPath(t))

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
	legacyChat, err := st.NewChat(ws.ID, "legacy", ws.Path, "", "")
	if err != nil {
		t.Fatalf("create legacy chat: %v", err)
	}
	sessions := auth.NewSessionStore(ctx, "pw", logger)
	apiServer := New(ctx, &config.Config{Root: tmp, Provider: "omo"}, st, sessions, logger)
	server := httptest.NewServer(http.HandlerFunc(apiServer.handleWS))
	defer server.Close()
	defer server.CloseClientConnections()

	collector := &frameCollector{notify: make(chan struct{}, 256)}
	client, _, err := gws.NewClient(collector, &gws.ClientOption{
		Addr: "ws" + strings.TrimPrefix(server.URL, "http"),
	})
	if err != nil {
		t.Fatalf("connect ws: %v", err)
	}
	t.Cleanup(func() { _ = client.WriteClose(1000, nil) })
	go client.ReadLoop()

	writeFrame(t, client, map[string]any{"type": "chat.create", "wsId": ws.ID, "chatId": legacyChat.ID, "provider": "omo"})
	collector.waitFor(t, "ready", 3*time.Second)
	collector.waitFor(t, "commands", 3*time.Second)
	launched, err := st.GetChat(ws.ID, legacyChat.ID)
	if err != nil {
		t.Fatalf("get legacy chat: %v", err)
	}
	if launched.Provider != "" {
		t.Fatalf("legacy provider = %q, want empty identity preserved; the alias is a launch-time projection only", launched.Provider)
	}
	if launched.PiSessionID == "" {
		t.Fatal("legacy chat launched without a provider identity")
	}
	original := apiServer.chats.Get(legacyChat.ID)
	secondChat, err := st.NewChat(ws.ID, "second", ws.Path, "", "omo")
	if err != nil {
		t.Fatalf("create second chat: %v", err)
	}
	writeFrame(t, client, map[string]any{"type": "chat.create", "wsId": ws.ID, "chatId": secondChat.ID})
	frameMark := collector.waitForAfter(t, "ready", 1, 3*time.Second)
	collector.waitForAfter(t, "commands", frameMark, 3*time.Second)
	if got := apiServer.chats.Get(legacyChat.ID); got != original {
		t.Fatalf("original session replaced: got %p, want %p", got, original)
	}
	if got := apiServer.chats.Get(secondChat.ID); got == nil {
		t.Fatal("second chat did not acquire a detached runtime")
	}

	writeFrame(t, client, map[string]any{
		"type":      "chat.send",
		"sessionId": secondChat.ID,
		"run":       map[string]any{"kind": "prompt", "message": "hello"},
	})
	collector.waitFor(t, "run.done", 5*time.Second)

	if !collector.hasType("messageDelta") || !collector.hasType("message") {
		t.Fatalf("expected messageDelta + message frames; have: %s", collector.types())
	}
}
