package wsbridge

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lxzan/gws"

	"github.com/DevNewbie1826/omo-webchat/internal/auth"
	"github.com/DevNewbie1826/omo-webchat/internal/cursorstore"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc/omorpctest"
	"github.com/DevNewbie1826/omo-webchat/internal/session"
	"github.com/DevNewbie1826/omo-webchat/internal/wscontract"
)

type collector struct {
	gws.BuiltinEventHandler
	mu     sync.Mutex
	frames []json.RawMessage
	notify chan struct{}
}

func (c *collector) OnMessage(_ *gws.Conn, m *gws.Message) {
	defer m.Close()
	c.mu.Lock()
	c.frames = append(c.frames, append(json.RawMessage(nil), m.Bytes()...))
	c.mu.Unlock()
	select {
	case c.notify <- struct{}{}:
	default:
	}
}
func (c *collector) next(t *testing.T, typ string) map[string]any {
	t.Helper()
	deadline := time.NewTimer(5 * time.Second)
	defer deadline.Stop()
	for {
		c.mu.Lock()
		for i, b := range c.frames {
			var f map[string]any
			_ = json.Unmarshal(b, &f)
			if f["type"] == typ {
				c.frames = append(c.frames[:i], c.frames[i+1:]...)
				c.mu.Unlock()
				return f
			}
		}
		c.mu.Unlock()
		select {
		case <-c.notify:
		case <-deadline.C:
			t.Fatalf("timed out waiting for %s", typ)
		}
	}
}
func TestContextUsageWithPercentFillsProviderOmission(t *testing.T) {
	got := contextUsageWithPercent(json.RawMessage(`{"used":150,"total":200000}`))
	var usage map[string]float64
	if err := json.Unmarshal(got, &usage); err != nil {
		t.Fatal(err)
	}
	if usage["percent"] != 0.075 {
		t.Fatalf("normalized context usage = %s", got)
	}
}

func TestContextUsageWithPercentHandlesZeroDenominator(t *testing.T) {
	got := contextUsageWithPercent(json.RawMessage(`{"tokens":0,"contextWindow":0}`))
	var usage map[string]float64
	if err := json.Unmarshal(got, &usage); err != nil {
		t.Fatal(err)
	}
	percent, ok := usage["percent"]
	if !ok || percent != 0 || usage["tokens"] != 0 || usage["contextWindow"] != 0 {
		t.Fatalf("normalized zero context usage = %s", got)
	}
	frame, err := json.Marshal(map[string]any{"type": "stats", "sessionId": "chat-1", "contextUsage": got})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := wscontract.ParseServerFrame(frame); err != nil {
		t.Fatalf("generated Go parser rejected normalized stats: %v", err)
	}
	// The lib raw-JSON contract test covers acceptance by the generated TS parser.
}

func TestHelloWriteFailureShutdownRemovesConnectionRegistry(t *testing.T) {
	h := New(Config{Context: context.Background()})
	sock := &gws.Conn{}
	ctx, cancel := context.WithCancel(context.Background())
	c := &connection{bridge: h, socket: sock, ctx: ctx, cancel: cancel}
	h.conns.Store(sock, c)
	c.shutdown()
	if _, ok := h.conns.Load(sock); ok {
		t.Fatal("failed hello left connection registered")
	}
}

func TestBridgeEndToEndResumeReplayAndErrors(t *testing.T) {
	dir, err := os.MkdirTemp("", "wsbridge-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	d := omorpctest.New(dir)
	if err := d.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(d.Stop)
	client, err := omorpc.Dial(t.Context(), d.SocketPath())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close() })
	store, err := cursorstore.Open(filepath.Join(dir, "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SaveWorkspace(cursorstore.Workspace{ID: "ws-1", Name: "work", Path: dir}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveChat(cursorstore.Chat{ID: "chat-1", WorkspaceID: "ws-1", CWD: dir, Name: "chat", NameSource: cursorstore.NameSourceAuto}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveChat(cursorstore.Chat{ID: "unsupported", WorkspaceID: "ws-1", CWD: dir, Provider: "omp", Name: "legacy", NameSource: cursorstore.NameSourceAuto}); err != nil {
		t.Fatal(err)
	}
	mgr := session.NewManager(session.Config{Client: client, Store: (*CursorStore)(store)})
	t.Cleanup(func() { _ = mgr.CloseAll(context.Background()) })
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	sessions := auth.NewSessionStore(t.Context(), "pw", logger)
	token, err := sessions.Create(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	h := sessions.Middleware(New(Config{Manager: mgr, Store: store, ServerVersion: client.ServerVersion(), Logger: logger}))
	ts := httptest.NewServer(h)
	defer ts.Close()

	if resp, err := http.Get(ts.URL); err != nil {
		t.Fatal(err)
	} else {
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("unauthenticated status=%d", resp.StatusCode)
		}
	}
	connectRaw := func() (*gws.Conn, *collector) {
		c := &collector{notify: make(chan struct{}, 64)}
		conn, _, err := gws.NewClient(c, &gws.ClientOption{Addr: "ws" + strings.TrimPrefix(ts.URL, "http"), RequestHeader: http.Header{"Cookie": []string{auth.CookieName + "=" + token}}})
		if err != nil {
			t.Fatal(err)
		}
		go conn.ReadLoop()
		c.next(t, "hello")
		return conn, c
	}
	connect := func() (*gws.Conn, *collector) {
		conn, c := connectRaw()
		writeClient(t, conn, map[string]any{"type": "hello", "version": 2})
		return conn, c
	}

	preHello, preHelloFrames := connectRaw()
	writeClient(t, preHello, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": "chat-1"})
	if got := preHelloFrames.next(t, "error"); got["code"] != "bad_frame" {
		t.Fatalf("pre-hello frame accepted: %v", got)
	}
	writeClient(t, preHello, map[string]any{"type": "ping"})
	if got := preHelloFrames.next(t, "error"); got["code"] != "bad_frame" {
		t.Fatalf("pre-hello ping accepted: %v", got)
	}
	writeClient(t, preHello, map[string]any{"type": "hello", "version": 99})
	if got := preHelloFrames.next(t, "error"); got["code"] != "bad_frame" {
		t.Fatalf("version mismatch accepted silently: %v", got)
	}
	_ = preHello.WriteClose(1000, nil)

	conn, c := connect()
	writeClient(t, conn, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": "unsupported"})
	if got := c.next(t, "error"); got["code"] != "unsupported_provider" {
		t.Fatalf("unsupported provider create = %v", got)
	}
	if got := mgr.LiveSummaries(); len(got) != 0 {
		t.Fatalf("unsupported provider launched sessions: %+v", got)
	}
	if got := d.RequestCount(omorpc.CmdOpenSession); got != 0 {
		t.Fatalf("unsupported provider opened daemon sessions: %d", got)
	}
	writeClient(t, conn, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": "chat-1"})
	ready := c.next(t, "ready")
	if ready["resumed"] != false {
		t.Fatalf("initial ready=%v", ready)
	}
	chat, err := store.GetChat("chat-1")
	if err != nil || chat.SessionFile == "" {
		t.Fatalf("cursor not persisted: %+v, %v", chat, err)
	}
	d.SetPromptScript(chat.SessionFile,
		map[string]any{"type": omorpctest.EventAgentStart},
		map[string]any{"type": "message_update", "message": map[string]any{"role": "assistant", "content": []any{map[string]any{"type": "text", "text": "hello"}}}, "assistantMessageEvent": map[string]any{"type": "text_delta", "contentIndex": 0, "delta": "hello", "partial": map[string]any{"type": "text", "text": "hello"}}},
		map[string]any{"type": "tool_execution_update", "toolCallId": "call-1", "toolName": "bash", "args": map[string]any{"command": "pwd"}, "partialResult": map[string]any{"content": []any{map[string]any{"type": "text", "text": "/tmp"}}}},
		map[string]any{"type": "message_end", "message": map[string]any{"role": "assistant", "content": []any{map[string]any{"type": "text", "text": "hello"}}, "model": "mock-model"}},
		map[string]any{"type": "message_end", "message": map[string]any{"role": "custom", "customType": "hook", "content": "canonical hook output", "timestamp": 1735689600.25}},
		map[string]any{"type": "extension_event", "name": "omo.task.updated", "data": map[string]any{"tasks": []any{}}},
		map[string]any{"type": omorpctest.EventAgentSettled, "reason": "end_turn"},
	)
	writeClient(t, conn, map[string]any{"type": "chat.send", "sessionId": "chat-1", "run": map[string]any{"kind": "prompt", "message": "hi"}})
	c.next(t, "run.started")
	delta := c.next(t, "messageDelta")
	if got := delta["delta"].(map[string]any); got["kind"] != "text_delta" || got["delta"] != "hello" {
		t.Fatalf("canonical delta not normalized: %v", delta)
	}
	tool := c.next(t, "tool")
	if _, ok := tool["partial"].(map[string]any); !ok || tool["partialResult"] != nil {
		t.Fatalf("canonical tool update not normalized: %v", tool)
	}
	message := c.next(t, "message")
	completed := message["message"].(map[string]any)
	if _, ok := completed["blocks"].([]any); !ok || completed["content"] != nil {
		t.Fatalf("canonical message not normalized: %v", message)
	}
	custom := c.next(t, "message")["message"].(map[string]any)
	if custom["content"] != "canonical hook output" || custom["timestamp"] != 1735689600.25 {
		t.Fatalf("canonical string message lost content/timestamp: %v", custom)
	}
	c.next(t, "extensionEvent")
	c.next(t, "run.done")
	writeClient(t, conn, map[string]any{"type": "chat.send", "sessionId": "chat-1", "run": map[string]any{"kind": "followUp", "message": "later"}})
	if got := c.next(t, "error"); got["code"] != "prompt_in_flight" {
		t.Fatalf("followUp was not dispatched: %v", got)
	}

	d.SetPromptScript(chat.SessionFile,
		map[string]any{"type": "extension_ui_request", "id": "approval-native", "method": "input"},
		map[string]any{"type": omorpctest.EventAgentSettled, "reason": "end_turn"},
	)
	writeClient(t, conn, map[string]any{"type": "chat.send", "sessionId": "chat-1", "run": map[string]any{"kind": "prompt", "message": "approve"}})
	c.next(t, "approval")
	writeClient(t, conn, map[string]any{"type": "approval.respond", "sessionId": "chat-1", "id": "approval-native", "requestId": "browser-7", "value": `{"allow":true}`})
	if ack := c.next(t, "ack"); ack["requestId"] != "browser-7" || ack["id"] != "approval-native" {
		t.Fatalf("approval correlation=%v", ack)
	}
	if !d.AwaitRequestCount(omorpc.CmdExtensionUIResponse, 1, 5*time.Second) {
		t.Fatal("approval response not sent")
	}
	if value := d.LastRequest(omorpc.CmdExtensionUIResponse)["value"]; value != `{"allow":true}` {
		t.Fatalf("approval value retyped: %#v", value)
	}
	c.next(t, "run.done")
	_ = conn.WriteClose(1000, nil)

	conn2, c2 := connect()
	defer conn2.WriteClose(1000, nil)
	writeClient(t, conn2, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": "chat-1"})
	ready = c2.next(t, "ready")
	if ready["resumed"] != true {
		t.Fatalf("reattach ready=%v", ready)
	}
	if got := c2.next(t, "extensionEvent"); got["name"] != "omo.task.updated" {
		t.Fatalf("snapshot=%v", got)
	}
	if got := c2.next(t, "entries"); got["final"] != true {
		t.Fatalf("reattach history=%v", got)
	}
	writeClient(t, conn2, map[string]any{"type": "activity.refresh", "sessionId": "chat-1"})
	c2.next(t, "extensionEvent")
	writeClient(t, conn2, map[string]any{"type": "chat.close", "sessionId": "chat-1"})
	writeClient(t, conn2, map[string]any{"type": "ping"})
	c2.next(t, "pong") // normal detach must not cancel the WebSocket
	writeClient(t, conn2, map[string]any{"type": "future.command"})
	if got := c2.next(t, "error"); got["code"] != "unknown_type" {
		t.Fatalf("unknown error=%v", got)
	}
	if err := conn2.WriteMessage(gws.OpcodeText, []byte("{")); err != nil {
		t.Fatal(err)
	}
	if got := c2.next(t, "error"); got["code"] != "bad_frame" {
		t.Fatalf("bad error=%v", got)
	}
}

func writeClient(t *testing.T, c *gws.Conn, v any) {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	if err = c.WriteMessage(gws.OpcodeText, b); err != nil {
		t.Fatal(err)
	}
}
