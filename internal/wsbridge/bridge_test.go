package wsbridge

import (
	"context"
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
	"sync"
	"sync/atomic"
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

type signalLogHandler struct{ records chan struct{} }

func (h *signalLogHandler) Enabled(context.Context, slog.Level) bool { return true }
func (h *signalLogHandler) Handle(context.Context, slog.Record) error {
	select {
	case h.records <- struct{}{}:
	default:
	}
	return nil
}
func (h *signalLogHandler) WithAttrs([]slog.Attr) slog.Handler { return h }
func (h *signalLogHandler) WithGroup(string) slog.Handler      { return h }

type cancelSignalSubscriber struct {
	frames    chan session.Frame
	cancelled chan struct{}
	once      sync.Once
}

func (s *cancelSignalSubscriber) Deliver(frame session.Frame) {
	select {
	case s.frames <- frame:
	case <-s.cancelled:
	}
}
func (s *cancelSignalSubscriber) Cancel() error {
	s.once.Do(func() { close(s.cancelled) })
	return nil
}

type decodedFrame struct {
	raw   json.RawMessage
	typ   string
	final bool
	err   error
}

type collector struct {
	gws.BuiltinEventHandler
	mu           sync.Mutex
	frames       []json.RawMessage
	decoded      []decodedFrame
	notify       chan struct{}
	timeout      time.Duration
	closed       chan struct{}
	closeOnce    sync.Once
	streamClosed bool
	generation   uint64
}

func decodeFrameMeta(raw json.RawMessage) decodedFrame {
	frame := decodedFrame{raw: raw}
	var head struct {
		Type  string `json:"type"`
		Final bool   `json:"final"`
	}
	frame.err = json.Unmarshal(raw, &head)
	frame.typ = head.Type
	frame.final = head.Final
	return frame
}

func (c *collector) wake() {
	if c.notify == nil {
		return
	}
	select {
	case c.notify <- struct{}{}:
	default:
	}
}

func (c *collector) OnMessage(_ *gws.Conn, m *gws.Message) {
	raw := append(json.RawMessage(nil), m.Bytes()...)
	m.Close()
	decoded := decodeFrameMeta(raw)
	c.mu.Lock()
	c.frames = append(c.frames, raw)
	c.decoded = append(c.decoded, decoded)
	c.generation++
	c.mu.Unlock()
	c.wake()
}

func (c *collector) OnClose(_ *gws.Conn, _ error) {
	c.closeOnce.Do(func() {
		c.mu.Lock()
		c.streamClosed = true
		c.generation++
		if c.closed == nil {
			c.closed = make(chan struct{})
		}
		close(c.closed)
		c.mu.Unlock()
		c.wake()
	})
}

func (c *collector) takeDecoded(start int) ([]decodedFrame, bool, uint64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	var batch []decodedFrame
	if start < len(c.decoded) {
		batch = append([]decodedFrame(nil), c.decoded[start:]...)
	}
	return batch, c.streamClosed, c.generation
}

func (c *collector) waitAfter(gen uint64, timeout time.Duration) error {
	if timeout <= 0 {
		return errHistoryTerminalTimeout
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	for {
		c.mu.Lock()
		if c.generation != gen || c.streamClosed {
			c.mu.Unlock()
			return nil
		}
		notify := c.notify
		var closed <-chan struct{}
		if c.closed != nil {
			closed = c.closed
		}
		c.mu.Unlock()
		select {
		case <-notify:
		case <-closed:
			return nil
		case <-timer.C:
			c.mu.Lock()
			changed := c.generation != gen || c.streamClosed
			c.mu.Unlock()
			if changed {
				return nil
			}
			return errHistoryTerminalTimeout
		}
	}
}

func (c *collector) next(t *testing.T, typ string) map[string]any {
	t.Helper()
	timeout := c.timeout
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	return c.nextWithin(t, typ, timeout)
}

func (c *collector) nextWithin(t *testing.T, typ string, timeout time.Duration) map[string]any {
	t.Helper()
	if timeout <= 0 {
		t.Fatalf("deadline elapsed waiting for %s", typ)
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	for {
		c.mu.Lock()
		var raw json.RawMessage
		found := false
		for i, decoded := range c.decoded {
			if decoded.err != nil || decoded.typ != typ {
				continue
			}
			raw = decoded.raw
			c.frames = append(c.frames[:i], c.frames[i+1:]...)
			c.decoded = append(c.decoded[:i], c.decoded[i+1:]...)
			found = true
			break
		}
		c.mu.Unlock()
		if found {
			var f map[string]any
			if err := json.Unmarshal(raw, &f); err != nil {
				t.Fatalf("decode %s frame: %v", typ, err)
			}
			return f
		}
		select {
		case <-c.notify:
		case <-timer.C:
			c.mu.Lock()
			pending := append([]json.RawMessage(nil), c.frames...)
			c.mu.Unlock()
			t.Fatalf("timed out waiting for %s; pending frames: %s", typ, pending)
		}
	}
}

func nextSuccessfulSendAcks(t *testing.T, frames *collector, requestID string) {
	t.Helper()
	ack := frames.next(t, "ack")
	if ack["command"] != "chat.send" || ack["requestId"] != requestID || ack["phase"] != nil {
		t.Fatalf("send admission ack = %v, want one unphased ack for %q", ack, requestID)
	}
}

func TestRouteContextBudgetsLongRunningFramesSeparately(t *testing.T) {
	c := &connection{ctx: context.Background()}
	longRunning := []struct {
		name string
		raw  string
	}{
		{name: "prompt", raw: `{"type":"chat.send","sessionId":"chat-1","run":{"kind":"prompt","message":"hello"}}`},
		{name: "steer", raw: `{"type":"chat.send","sessionId":"chat-1","run":{"kind":"steer","message":"hello"}}`},
		{name: "follow_up", raw: `{"type":"chat.send","sessionId":"chat-1","run":{"kind":"follow_up","message":"hello"}}`},
		{name: "compact", raw: `{"type":"chat.compact","sessionId":"chat-1"}`},
	}
	for _, tc := range longRunning {
		t.Run(tc.name, func(t *testing.T) {
			frame, err := wscontract.ParseClientFrame([]byte(tc.raw))
			if err != nil {
				t.Fatalf("parse frame: %v", err)
			}
			ctx, cancel := c.routeContext(frame)
			defer cancel()
			if deadline, ok := ctx.Deadline(); ok {
				t.Fatalf("long-running route has deadline %v", deadline)
			}
		})
	}

	createFrame, err := wscontract.ParseClientFrame([]byte(`{"type":"chat.create","wsId":"ws-1","chatId":"chat-1"}`))
	if err != nil {
		t.Fatalf("parse create: %v", err)
	}
	started := time.Now()
	createCtx, createCancel := c.routeContext(createFrame)
	defer createCancel()
	createDeadline, ok := createCtx.Deadline()
	if !ok {
		t.Fatal("create route has no deadline")
	}
	if got := createDeadline.Sub(started); got < openFrameTimeout-time.Second || got > openFrameTimeout+time.Second {
		t.Fatalf("create route budget = %v, want %v", got, openFrameTimeout)
	}

	frame, err := wscontract.ParseClientFrame([]byte(`{"type":"ping"}`))
	if err != nil {
		t.Fatalf("parse ping: %v", err)
	}
	started = time.Now()
	ctx, cancel := c.routeContext(frame)
	defer cancel()
	deadline, ok := ctx.Deadline()
	if !ok {
		t.Fatal("cheap route has no deadline")
	}
	if got := deadline.Sub(started); got < controlFrameTimeout-time.Second || got > controlFrameTimeout+time.Second {
		t.Fatalf("cheap route budget = %v, want %v", got, controlFrameTimeout)
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
	h := sessions.Middleware(New(Config{
		Manager: mgr, Store: store, ServerVersion: client.ServerVersion(), Logger: logger,
		PrepareChatVersion: func(_ context.Context, _ string, chatID string) (uint64, error) {
			if chatID == "deleted" {
				return 0, ErrChatDeleted
			}
			return 0, nil
		},
		ChatVersion: func(string) uint64 { return 0 },
	}))
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
	writeClient(t, conn, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": "deleted"})
	if got := c.next(t, "error"); got["code"] != "no_chat" {
		t.Fatalf("deleted chat create = %v", got)
	}
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

	connB, cB := connect()
	writeClient(t, connB, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": "chat-1"})
	if secondReady := cB.next(t, "ready"); secondReady["sessionId"] != "chat-1" {
		t.Fatalf("live reattach ready=%v", secondReady)
	}
	afterReattach, err := store.GetChat("chat-1")
	if err != nil {
		t.Fatal(err)
	}
	if afterReattach.SessionFile != chat.SessionFile || afterReattach.SessionProvenance != chat.SessionProvenance {
		t.Fatalf("live reattach migrated active route: before=%+v after=%+v", chat, afterReattach)
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
	writeClient(t, connB, map[string]any{"type": "chat.send", "sessionId": "chat-1", "run": map[string]any{"kind": "prompt", "message": "hi"}})
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
	if secondDone := cB.next(t, "run.done"); secondDone["sessionId"] != "chat-1" {
		t.Fatalf("second socket did not receive completed turn: %v", secondDone)
	}
	_ = connB.WriteClose(1000, nil)
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
	for {
		got := c2.next(t, "entries")
		if got["final"] == true {
			break
		}
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

type inPlaceBridgeHarness struct {
	daemon      *omorpctest.Daemon
	store       *cursorstore.Store
	manager     *session.Manager
	bridge      *Handler
	server      *httptest.Server
	path        string
	chatVersion atomic.Uint64
}

func newInPlaceBridgeHarness(t *testing.T, chatID string) *inPlaceBridgeHarness {
	return newInPlaceBridgeHarnessWithHistory(t, chatID, 1)
}

func newInPlaceBridgeHarnessWithHistory(t *testing.T, chatID string, entries int) *inPlaceBridgeHarness {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, chatID+".jsonl")
	var body strings.Builder
	fmt.Fprintf(&body, "{\"type\":\"session\",\"id\":\"durable-%s\",\"version\":3,\"timestamp\":\"2026-09-03T00:00:00Z\",\"cwd\":%s}\n", chatID, mustJSON(t, dir))
	parent := ""
	for i := 0; i < entries; i++ {
		id := "root"
		if i != 0 {
			id = fmt.Sprintf("entry-%d", i)
		}
		parentJSON := "null"
		if parent != "" {
			parentJSON = string(mustJSON(t, parent))
		}
		fmt.Fprintf(&body, "{\"type\":\"message\",\"id\":%s,\"parentId\":%s,\"message\":{\"role\":\"user\",\"content\":\"before\"}}\n", mustJSON(t, id), parentJSON)
		parent = id
	}
	if err := os.WriteFile(path, []byte(body.String()), 0o600); err != nil {
		t.Fatal(err)
	}
	daemonDir, err := os.MkdirTemp("", "wsbridge-inplace-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(daemonDir) })
	d := omorpctest.New(daemonDir)
	if err := d.LoadSessionFile(path); err != nil {
		t.Fatal(err)
	}
	if err := d.Start(); err != nil {
		t.Fatal(err)
	}
	client, err := omorpc.Dial(t.Context(), d.SocketPath())
	if err != nil {
		t.Fatal(err)
	}
	store, err := cursorstore.Open(filepath.Join(dir, "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SaveWorkspace(cursorstore.Workspace{ID: "ws-1", Name: "work", Path: dir}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveChat(cursorstore.Chat{
		ID: chatID, WorkspaceID: "ws-1", CWD: dir, Name: chatID,
		SessionFile: path, DurableSessionID: "durable-" + chatID,
		SessionProvenance: cursorstore.SessionProvenanceInPlace,
	}); err != nil {
		t.Fatal(err)
	}
	manager := session.NewManager(session.Config{Client: client, Store: (*CursorStore)(store), RetryBackoff: time.Millisecond})
	harness := &inPlaceBridgeHarness{daemon: d, store: store, manager: manager, path: path}
	bridge := New(Config{
		Manager: manager, Store: store,
		PrepareChatVersion: func(context.Context, string, string) (uint64, error) { return harness.chatVersion.Load(), nil },
		ChatVersion:        func(string) uint64 { return harness.chatVersion.Load() },
	})
	harness.bridge = bridge
	server := httptest.NewServer(bridge)
	harness.server = server
	t.Cleanup(func() {
		server.Close()
		_ = manager.CloseAll(context.Background())
		_ = client.Close()
		d.Stop()
	})
	return harness
}

func (h *inPlaceBridgeHarness) soleServerConnection(t *testing.T) *connection {
	t.Helper()
	var found *connection
	h.bridge.conns.Range(func(_, value any) bool {
		if found != nil {
			t.Fatal("expected exactly one server connection")
		}
		found = value.(*connection)
		return true
	})
	if found == nil {
		t.Fatal("server connection was not registered")
	}
	return found
}

func (h *inPlaceBridgeHarness) soleServerConnectionDone(t *testing.T) <-chan struct{} {
	return h.soleServerConnection(t).ctx.Done()
}

func (h *inPlaceBridgeHarness) connect(t *testing.T) (*gws.Conn, *collector) {
	t.Helper()
	frames := &collector{notify: make(chan struct{}, 64)}
	conn, _, err := gws.NewClient(frames, &gws.ClientOption{Addr: "ws" + strings.TrimPrefix(h.server.URL, "http")})
	if err != nil {
		t.Fatal(err)
	}
	go conn.ReadLoop()
	frames.next(t, "hello")
	writeClient(t, conn, map[string]any{"type": "hello", "version": 2})
	t.Cleanup(func() { _ = conn.WriteClose(1000, nil) })
	return conn, frames
}

func TestChatCreateFailureUsesStableUserMessage(t *testing.T) {
	h := newInPlaceBridgeHarness(t, "create-failure-message")
	h.daemon.FailNext(omorpc.CmdOpenSession, omorpc.ErrCodeInvalidPath)
	conn, frames := h.connect(t)
	writeClient(t, conn, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": "create-failure-message"})
	got := frames.next(t, "error")
	if got["code"] != "start_failed" || got["message"] != "could not open the session; please retry" {
		t.Fatalf("create failure = %#v", got)
	}
}

func TestChatCreateOpenFailedPreservesOriginalErrorText(t *testing.T) {
	const original = "open_failed: QA_CONTEXT_LIMIT 311799 > 272000"
	h := newInPlaceBridgeHarness(t, "create-open-failed-detail")
	h.daemon.FailNext(omorpc.CmdOpenSession, original)
	conn, frames := h.connect(t)
	writeClient(t, conn, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": "create-open-failed-detail"})
	got := frames.next(t, "error")
	if got["code"] != "start_failed" || got["message"] != original {
		t.Fatalf("open_failed create = %#v", got)
	}
}

func TestChatCreateOpenFailedPreservesNoncanonicalWireSpelling(t *testing.T) {
	tests := []struct {
		name string
		wire string
	}{
		{name: "no-space", wire: "open_failed:no-space detail"},
		{name: "multiple-leading-space", wire: "open_failed:  multiple-space detail"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			chatID := "create-open-failed-wire-" + test.name
			h := newInPlaceBridgeHarness(t, chatID)
			h.daemon.FailNext(omorpc.CmdOpenSession, test.wire)
			conn, frames := h.connect(t)
			writeClient(t, conn, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": chatID})
			got := frames.next(t, "error")
			if got["code"] != "start_failed" || got["message"] != test.wire {
				t.Fatalf("noncanonical open_failed = %#v", got)
			}
		})
	}
}

func TestChatCreateOpenFailedWhitespaceFallsBackToGeneric(t *testing.T) {
	tests := []struct {
		name string
		wire string
	}{
		{name: "empty-suffix", wire: "open_failed:"},
		{name: "spaces", wire: "open_failed:   "},
		{name: "tab", wire: "open_failed:\t"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			chatID := "create-open-failed-ws-" + test.name
			h := newInPlaceBridgeHarness(t, chatID)
			h.daemon.FailNext(omorpc.CmdOpenSession, test.wire)
			conn, frames := h.connect(t)
			writeClient(t, conn, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": chatID})
			got := frames.next(t, "error")
			if got["code"] != "start_failed" || got["message"] != "could not open the session; please retry" {
				t.Fatalf("whitespace open_failed = %#v", got)
			}
		})
	}
}

func TestChatCreateOpenFailedPreservesMultilineMarkupLikeText(t *testing.T) {
	token := strings.Repeat("T", 600)
	original := "open_failed: QA_CONTEXT_LIMIT 311799 > 272000\n" + token + "\n<img src=x onerror=alert(1)>"
	h := newInPlaceBridgeHarness(t, "create-open-failed-long")
	h.daemon.FailNext(omorpc.CmdOpenSession, original)
	conn, frames := h.connect(t)
	writeClient(t, conn, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": "create-open-failed-long"})
	got := frames.next(t, "error")
	if got["code"] != "start_failed" || got["message"] != original {
		t.Fatalf("multiline open_failed = %#v", got)
	}
}

func TestChatCreateArbitraryProviderErrorKeepsGenericMessage(t *testing.T) {
	h := newInPlaceBridgeHarness(t, "create-arbitrary-error")
	h.daemon.FailNext(omorpc.CmdOpenSession, "sensitive internal boom")
	conn, frames := h.connect(t)
	writeClient(t, conn, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": "create-arbitrary-error"})
	got := frames.next(t, "error")
	if got["code"] != "start_failed" || got["message"] != "could not open the session; please retry" {
		t.Fatalf("arbitrary create error = %#v", got)
	}
}

func TestChatCreatePreparationFailuresUseStableUserMessage(t *testing.T) {
	for _, guarded := range []bool{true, false} {
		name := "prepare"
		if guarded {
			name = "prepare-version"
		}
		t.Run(name, func(t *testing.T) {
			h := newInPlaceBridgeHarness(t, "preparation-failure-"+name)
			h.bridge.cfg.Logger = slog.New(slog.NewTextHandler(io.Discard, nil))
			if guarded {
				h.bridge.cfg.PrepareChatVersion = func(context.Context, string, string) (uint64, error) {
					return 0, errors.New("sensitive preparation detail")
				}
			} else {
				h.bridge.cfg.PrepareChatVersion = nil
				h.bridge.cfg.ChatVersion = nil
				h.bridge.cfg.PrepareChat = func(context.Context, string, string) error {
					return errors.New("sensitive preparation detail")
				}
			}

			conn, frames := h.connect(t)
			writeClient(t, conn, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": "preparation-failure-" + name})
			got := frames.next(t, "error")
			if got["code"] != "no_chat" || got["message"] != "could not prepare the session; please retry" {
				t.Fatalf("preparation failure = %#v", got)
			}
		})
	}
}

func TestResumeFailureInfoSanitizesProviderDetails(t *testing.T) {
	for _, err := range []error{
		errors.New("sensitive provider detail"),
		&session.ResumeError{Info: session.ErrorInfo{Code: "resume_failed", Message: "sensitive provider detail"}},
	} {
		got := resumeFailureInfo(err)
		if got.Code != "resume_failed" || got.Message != "could not resume the session; please retry" {
			t.Fatalf("resume failure = %#v", got)
		}
	}
}

func TestBlockedQueryDoesNotDeliverAcrossBindingGeneration(t *testing.T) {
	h := newInPlaceBridgeHarness(t, "blocked-query-binding")
	conn, frames := h.connect(t)
	// Install the gate before initialization can issue get_commands; both the
	// initialization query and the explicit query are then deterministically
	// inside the blocked generation.
	release := h.daemon.BlockHandler(omorpc.CmdGetCommands)
	defer release()
	writeClient(t, conn, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": "blocked-query-binding"})
	frames.next(t, "ready")
	serverConn := h.soleServerConnection(t)
	_, sess := serverConn.binding()
	if sess == nil {
		t.Fatal("server connection was not bound")
	}

	returned := make(chan struct{})
	go func() {
		serverConn.queryCommands(context.Background(), sess)
		close(returned)
	}()
	if !h.daemon.AwaitRequestCount(omorpc.CmdGetCommands, 2, 5*time.Second) {
		t.Fatal("blocked query did not reach provider")
	}
	serverConn.stateMu.Lock()
	serverConn.chatID = "replacement-chat"
	serverConn.bindingGeneration++
	serverConn.stateMu.Unlock()
	release()
	select {
	case <-returned:
	case <-time.After(5 * time.Second):
		t.Fatal("blocked query did not return")
	}
	// Pong is ordered after the direct query goroutine has returned and proves
	// the client reader has consumed every preceding socket write.
	writeClient(t, conn, map[string]any{"type": "ping"})
	frames.next(t, "pong")
	frames.mu.Lock()
	defer frames.mu.Unlock()
	for _, raw := range frames.frames {
		var frame map[string]any
		_ = json.Unmarshal(raw, &frame)
		if frame["type"] == "commands" {
			t.Fatalf("stale query crossed binding generation: %s", raw)
		}
	}
}

func TestCheckedBindingActivatesBeforeHistoryHydration(t *testing.T) {
	h := newInPlaceBridgeHarnessWithHistory(t, "checked-large-history", (preActivationBufferCapacity+1)*100)
	conn, frames := h.connect(t)
	release := h.daemon.BlockHandler(omorpc.CmdGetEntries)
	defer release()
	writeClient(t, conn, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": "checked-large-history", "recovery": true})
	if !h.daemon.AwaitRequestCount(omorpc.CmdGetEntries, 1, 5*time.Second) {
		t.Fatal("checked acquisition did not reach history hydration")
	}
	if ready := frames.next(t, "ready"); ready["sessionId"] != "checked-large-history" {
		t.Fatalf("binding was not activated before hydration: %#v", ready)
	}
	chatID, sess := h.soleServerConnection(t).binding()
	if chatID != "checked-large-history" || sess == nil {
		t.Fatalf("validated route was not published before hydration: chat=%q session=%p", chatID, sess)
	}
	release()
	for {
		if got := frames.next(t, "entries"); got["final"] == true {
			break
		}
	}
	writeClient(t, conn, map[string]any{"type": "ping"})
	frames.next(t, "pong")
	select {
	case <-h.soleServerConnectionDone(t):
		t.Fatal("large checked hydration overflowed the pre-activation buffer")
	default:
	}
}

func TestBlockedPromptDoesNotBlockFollowUpOrAbort(t *testing.T) {
	h := newInPlaceBridgeHarness(t, "blocked-prompt")
	releasePrompt := h.daemon.BlockHandler(omorpc.CmdPrompt)
	defer releasePrompt()

	conn, frames := h.connect(t)
	writeClient(t, conn, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": "blocked-prompt"})
	frames.next(t, "ready")

	writeClient(t, conn, map[string]any{
		"type": "chat.send", "sessionId": "blocked-prompt",
		"run": map[string]any{"kind": "prompt", "message": "start"},
	})
	if !h.daemon.AwaitRequestCount(omorpc.CmdPrompt, 1, 5*time.Second) {
		t.Fatal("prompt was not forwarded")
	}

	writeClient(t, conn, map[string]any{
		"type": "chat.send", "sessionId": "blocked-prompt",
		"run": map[string]any{
			"kind": "follow_up", "message": "",
			"images": []any{map[string]any{"data": "aW1hZ2U=", "mimeType": "image/png"}},
		},
	})
	if !h.daemon.AwaitRequestCount(omorpc.CmdFollowUp, 1, 5*time.Second) {
		t.Fatal("follow-up was not forwarded while prompt response was blocked")
	}
	followUp := h.daemon.LastRequest(omorpc.CmdFollowUp)
	images, ok := followUp["images"].([]any)
	if !ok || len(images) != 1 {
		t.Fatalf("follow-up images = %#v", followUp["images"])
	}
	image, ok := images[0].(map[string]any)
	if !ok || image["data"] != "aW1hZ2U=" || image["mimeType"] != "image/png" {
		t.Fatalf("follow-up image = %#v", images[0])
	}

	writeClient(t, conn, map[string]any{"type": "chat.abort", "sessionId": "blocked-prompt"})
	if !h.daemon.AwaitRequestCount(omorpc.CmdAbort, 1, 5*time.Second) {
		t.Fatal("abort was not forwarded while prompt response was blocked")
	}
}

func TestChatSendAdmissionAckAndDetachedFailuresCarryRequestID(t *testing.T) {
	h := newInPlaceBridgeHarness(t, "send-identity")
	conn, frames := h.connect(t)
	writeClient(t, conn, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": "send-identity"})
	frames.next(t, "ready")

	h.daemon.FailNext(omorpc.CmdPrompt, omorpc.ErrCodeTooManySessions)
	writeClient(t, conn, map[string]any{
		"type": "chat.send", "sessionId": "send-identity", "requestId": "prompt-1",
		"run": map[string]any{"kind": "prompt", "message": "fail"},
	})
	if ack := frames.next(t, "ack"); ack["command"] != "chat.send" || ack["requestId"] != "prompt-1" {
		t.Fatalf("prompt admission ack = %v", ack)
	} else if _, present := ack["phase"]; present {
		t.Fatalf("prompt admission ack gained phase: %v", ack)
	}
	if failure := frames.next(t, "error"); failure["command"] != "chat.send" || failure["requestId"] != "prompt-1" || failure["code"] != "provider_error" {
		t.Fatalf("prompt completion error = %v", failure)
	}

	h.daemon.SetPromptScript(h.path,
		map[string]any{"type": omorpctest.EventAgentStart},
		map[string]any{"type": omorpctest.EventAgentSettled, "reason": "end_turn"},
	)
	releaseRun := h.daemon.HoldPrompt(h.path)
	defer releaseRun()
	writeClient(t, conn, map[string]any{
		"type": "chat.send", "sessionId": "send-identity", "requestId": "prompt-2",
		"run": map[string]any{"kind": "prompt", "message": "run"},
	})
	nextSuccessfulSendAcks(t, frames, "prompt-2")

	h.daemon.FailNext(omorpc.CmdFollowUp, omorpc.ErrCodeTooManySessions)
	writeClient(t, conn, map[string]any{
		"type": "chat.send", "sessionId": "send-identity", "requestId": "follow-1",
		"run": map[string]any{"kind": "follow_up", "message": "later"},
	})
	if ack := frames.next(t, "ack"); ack["command"] != "chat.send" || ack["requestId"] != "follow-1" {
		t.Fatalf("follow-up admission ack = %v", ack)
	}
	if failure := frames.next(t, "error"); failure["command"] != "chat.send" || failure["requestId"] != "follow-1" || failure["code"] != "provider_error" {
		t.Fatalf("follow-up completion error = %v", failure)
	}
}

func TestChatSendResumesIdleUnloadedSessionBeforeOriginalPrompt(t *testing.T) {
	h := newInPlaceBridgeHarness(t, "send-idle-resume")
	conn, frames := h.connect(t)
	writeClient(t, conn, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": "send-idle-resume"})
	frames.next(t, "ready")
	writeClient(t, conn, map[string]any{"type": "ping"})
	frames.next(t, "pong")

	h.daemon.UnloadSession(h.path)
	frames.next(t, "error") // observed unload transition
	h.daemon.SetPromptScript(h.path,
		map[string]any{"type": omorpctest.EventAgentStart},
		map[string]any{"type": omorpctest.EventAgentSettled, "reason": "end_turn"},
	)
	writeClient(t, conn, map[string]any{
		"type": "chat.send", "sessionId": "send-idle-resume", "requestId": "resume-prompt",
		"run": map[string]any{"kind": "prompt", "message": "after idle"},
	})
	nextSuccessfulSendAcks(t, frames, "resume-prompt")
	if !h.daemon.AwaitRequestCount(omorpc.CmdPrompt, 1, 5*time.Second) {
		t.Fatal("resumed prompt was not forwarded")
	}
	requests := h.daemon.Requests()
	openIndex, promptIndex := -1, -1
	for i, request := range requests {
		switch request["type"] {
		case omorpc.CmdOpenSession:
			if i > openIndex {
				openIndex = i
			}
		case omorpc.CmdPrompt:
			promptIndex = i
		}
	}
	if openIndex < 0 || promptIndex <= openIndex {
		t.Fatalf("request order open=%d prompt=%d", openIndex, promptIndex)
	}

	reconnected, replay := h.connect(t)
	writeClient(t, reconnected, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": "send-idle-resume"})
	replay.next(t, "ready")
	writeClient(t, reconnected, map[string]any{"type": "ping"})
	replay.next(t, "pong")
}

func TestAdmissionTimeFollowUpRecoveryRemainsGatedWhenIdle(t *testing.T) {
	h := newInPlaceBridgeHarness(t, "idle-follow-up-recovery")
	conn, frames := h.connect(t)
	writeClient(t, conn, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": "idle-follow-up-recovery"})
	frames.next(t, "ready")
	writeClient(t, conn, map[string]any{"type": "ping"})
	frames.next(t, "pong")

	h.daemon.UnloadSession(h.path)
	frames.next(t, "error")
	writeClient(t, conn, map[string]any{
		"type": "chat.send", "sessionId": "idle-follow-up-recovery", "requestId": "idle-follow-up",
		"run": map[string]any{"kind": "follow_up", "message": "must remain gated"},
	})
	failure := frames.next(t, "error")
	if failure["code"] != "prompt_in_flight" || failure["command"] != "chat.send" || failure["requestId"] != "idle-follow-up" {
		t.Fatalf("idle recovered follow-up = %#v", failure)
	}
	if got := h.daemon.RequestCount(omorpc.CmdFollowUp); got != 0 {
		t.Fatalf("idle recovered follow-up reached provider %d times", got)
	}
}

func TestChatSendResumeFailuresKeepTypedCorrelationAndDoNotRetry(t *testing.T) {
	tests := []struct {
		name      string
		wantCode  string
		wantOpens int
		prepare   func(*testing.T, *inPlaceBridgeHarness)
	}{
		{
			name: "cursor unusable", wantCode: "resume_failed", wantOpens: 1,
			prepare: func(_ *testing.T, h *inPlaceBridgeHarness) {
				h.daemon.FailNext(omorpc.CmdOpenSession, omorpc.ErrCodeInvalidPath)
			},
		},
		{
			name: "adoption required", wantCode: "adoption_required", wantOpens: 0,
			prepare: func(t *testing.T, h *inPlaceBridgeHarness) {
				record, err := h.store.GetChat("resume-failure-adoption-required")
				if err != nil {
					t.Fatal(err)
				}
				record.SessionProvenance = ""
				if err := h.store.UpdateChat(record); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(h.path, []byte("not a session\n"), 0o600); err != nil {
					t.Fatal(err)
				}
			},
		},
		{
			name: "session active", wantCode: "session-active", wantOpens: 3,
			prepare: func(_ *testing.T, h *inPlaceBridgeHarness) {
				h.daemon.FailOpenPath(h.path, omorpc.ErrCodeSessionPathInUse, 3)
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			chatID := "resume-failure-" + strings.ReplaceAll(test.name, " ", "-")
			h := newInPlaceBridgeHarness(t, chatID)
			conn, frames := h.connect(t)
			writeClient(t, conn, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": chatID})
			frames.next(t, "ready")
			writeClient(t, conn, map[string]any{"type": "ping"})
			frames.next(t, "pong")
			h.daemon.UnloadSession(h.path)
			frames.next(t, "error")
			beforeOpens := h.daemon.RequestCount(omorpc.CmdOpenSession)
			test.prepare(t, h)

			requestID := "request-" + strings.ReplaceAll(test.name, " ", "-")
			writeClient(t, conn, map[string]any{
				"type": "chat.send", "sessionId": chatID, "requestId": requestID,
				"run": map[string]any{"kind": "prompt", "message": "do not retry"},
			})
			failure := frames.next(t, "error")
			if failure["code"] != test.wantCode || failure["command"] != "chat.send" || failure["requestId"] != requestID {
				t.Fatalf("resume failure = %#v", failure)
			}
			if got := h.daemon.RequestCount(omorpc.CmdPrompt); got != 0 {
				t.Fatalf("failed resume forwarded %d prompts", got)
			}
			if got := h.daemon.RequestCount(omorpc.CmdOpenSession) - beforeOpens; got != test.wantOpens {
				t.Fatalf("resume attempts = %d, want %d", got, test.wantOpens)
			}
		})
	}
}

func TestChatSendWaitsForFencedRouteCleanupBeforeReopening(t *testing.T) {
	h := newInPlaceBridgeHarness(t, "send-fenced-reopen")
	resumeLog := &signalLogHandler{records: make(chan struct{}, 1)}
	h.bridge.cfg.Logger = slog.New(resumeLog)
	conn, frames := h.connect(t)
	writeClient(t, conn, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": "send-fenced-reopen"})
	frames.next(t, "ready")
	serverConn := h.soleServerConnection(t)
	_, stale := serverConn.binding()
	if stale == nil {
		t.Fatal("server connection was not bound")
	}

	transition := &cancelSignalSubscriber{frames: make(chan session.Frame, 64), cancelled: make(chan struct{})}
	_, _, transitionDetach, err := h.manager.Acquire(t.Context(), chatRef{id: "send-fenced-reopen", cwd: filepath.Dir(h.path)}, transition)
	if err != nil {
		t.Fatal(err)
	}
	defer transitionDetach()
	select {
	case frame := <-transition.frames:
		if frame.Kind != session.FrameReady {
			t.Fatalf("transition subscriber initial frame = %#v, want ready", frame)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("transition subscriber did not attach")
	}
	serverConn.stateMu.Lock()
	staleDetach := serverConn.detach
	serverConn.detach = nil
	serverConn.stateMu.Unlock()
	staleDetach()

	root := filepath.Dir(h.daemon.SocketPath())
	h.daemon.Stop()
	replacement := omorpctest.New(root)
	if err := replacement.LoadSessionFile(h.path); err != nil {
		t.Fatal(err)
	}
	if err := replacement.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(replacement.Stop)
	transitionTimer := time.NewTimer(5 * time.Second)
	defer transitionTimer.Stop()
	for {
		select {
		case frame := <-transition.frames:
			if frame.Kind == session.FrameError {
				goto invalidated
			}
		case <-transitionTimer.C:
			t.Fatal("provider replacement did not invalidate the stale route")
		}
	}

invalidated:

	releaseClose := replacement.BlockHandler(omorpc.CmdCloseSession)
	defer releaseClose()
	closeResult := make(chan error, 1)
	go func() { closeResult <- stale.Close() }()
	if !replacement.AwaitRequestCount(omorpc.CmdCloseSession, 1, 5*time.Second) {
		t.Fatal("fallback cleanup did not reach replacement daemon")
	}

	replacement.SetPromptScript(h.path,
		map[string]any{"type": omorpctest.EventAgentStart},
		map[string]any{"type": omorpctest.EventAgentSettled, "reason": "end_turn"},
	)
	writeClient(t, conn, map[string]any{
		"type": "chat.send", "sessionId": "send-fenced-reopen", "requestId": "fenced-reopen",
		"run": map[string]any{"kind": "prompt", "message": "retry after cleanup"},
	})
	if !replacement.AwaitRequestCount(omorpc.CmdOpenSession, 1, 5*time.Second) {
		t.Fatal("fenced open was not attempted")
	}
	select {
	case <-resumeLog.records:
	case <-time.After(5 * time.Second):
		t.Fatal("fenced rejection was not observed")
	}
	releaseClose()
	select {
	case err := <-closeResult:
		if err != nil {
			t.Fatalf("fallback cleanup: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("fallback cleanup did not settle")
	}

	nextSuccessfulSendAcks(t, frames, "fenced-reopen")
	if !replacement.AwaitRequestCount(omorpc.CmdPrompt, 1, 5*time.Second) {
		t.Fatal("prompt did not complete after fenced reopen")
	}
	if got := replacement.RequestCount(omorpc.CmdOpenSession); got != 2 {
		t.Fatalf("reopen attempts = %d, want one rejected and one successful", got)
	}
	if got := replacement.RequestCount(omorpc.CmdPrompt); got != 1 {
		t.Fatalf("prompt attempts = %d, want exactly 1", got)
	}
	writeClient(t, conn, map[string]any{"type": "ping"})
	frames.next(t, "pong")
	frames.mu.Lock()
	defer frames.mu.Unlock()
	for _, raw := range frames.frames {
		var frame map[string]any
		_ = json.Unmarshal(raw, &frame)
		if frame["type"] == "error" {
			t.Fatalf("fenced reopen reached client socket: %s", raw)
		}
	}
}

func TestChatSendSilentEvictionReopensAndRetriesWithoutSocketError(t *testing.T) {
	h := newInPlaceBridgeHarness(t, "send-silent-eviction")
	conn, frames := h.connect(t)
	writeClient(t, conn, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": "send-silent-eviction"})
	frames.next(t, "ready")
	writeClient(t, conn, map[string]any{"type": "ping"})
	frames.next(t, "pong")

	beforeOpens := h.daemon.RequestCount(omorpc.CmdOpenSession)
	beforeEntries := h.daemon.RequestCount(omorpc.CmdGetEntries)
	beforePrompts := h.daemon.RequestCount(omorpc.CmdPrompt)
	h.daemon.SetPromptScript(h.path,
		map[string]any{"type": omorpctest.EventAgentStart},
		map[string]any{"type": omorpctest.EventAgentSettled, "reason": "end_turn"},
	)
	h.daemon.EvictUsedSessionOnNextRoutingCommand()
	writeClient(t, conn, map[string]any{
		"type": "chat.send", "sessionId": "send-silent-eviction", "requestId": "silent-eviction-prompt",
		"run": map[string]any{"kind": "prompt", "message": "retry after eviction"},
	})
	nextSuccessfulSendAcks(t, frames, "silent-eviction-prompt")
	if !h.daemon.AwaitRequestCount(omorpc.CmdPrompt, beforePrompts+2, 5*time.Second) {
		t.Fatal("prompt was not retried after silent eviction")
	}

	writeClient(t, conn, map[string]any{"type": "ping"})
	frames.next(t, "pong")
	if got := h.daemon.RequestCount(omorpc.CmdOpenSession) - beforeOpens; got != 1 {
		t.Fatalf("reopen attempts = %d, want exactly 1", got)
	}
	if got := h.daemon.RequestCount(omorpc.CmdGetEntries) - beforeEntries; got != 1 {
		t.Fatalf("history replays = %d, want exactly 1", got)
	}
	if got := h.daemon.RequestCount(omorpc.CmdPrompt) - beforePrompts; got != 2 {
		t.Fatalf("prompt attempts = %d, want initial plus one retry", got)
	}
	frames.mu.Lock()
	defer frames.mu.Unlock()
	for _, raw := range frames.frames {
		var frame map[string]any
		_ = json.Unmarshal(raw, &frame)
		if frame["type"] == "error" {
			t.Fatalf("silent eviction reached client socket: %s", raw)
		}
	}
}

func TestChatSendDetachedResumableCompletionResumesAndRetriesOnce(t *testing.T) {
	h := newInPlaceBridgeHarness(t, "send-detached-resume")
	conn, frames := h.connect(t)
	writeClient(t, conn, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": "send-detached-resume"})
	frames.next(t, "ready")
	writeClient(t, conn, map[string]any{"type": "ping"})
	frames.next(t, "pong")

	releasePrompt := h.daemon.BlockHandler(omorpc.CmdPrompt)
	h.daemon.SetPromptScript(h.path,
		map[string]any{"type": omorpctest.EventAgentStart},
		map[string]any{"type": omorpctest.EventAgentSettled, "reason": "end_turn"},
	)
	writeClient(t, conn, map[string]any{
		"type": "chat.send", "sessionId": "send-detached-resume", "requestId": "detached-resume",
		"run": map[string]any{"kind": "prompt", "message": "retry me"},
	})
	if ack := frames.next(t, "ack"); ack["requestId"] != "detached-resume" || ack["phase"] != nil {
		t.Fatalf("initial admission = %#v", ack)
	}
	if !h.daemon.AwaitRequestCount(omorpc.CmdPrompt, 1, 5*time.Second) {
		t.Fatal("initial prompt was not observed")
	}
	h.daemon.UnloadSession(h.path)
	frames.next(t, "error")
	releasePrompt()

	if !h.daemon.AwaitRequestCount(omorpc.CmdPrompt, 2, 5*time.Second) {
		t.Fatal("original prompt was not retried after resume")
	}
	if got := h.daemon.RequestCount(omorpc.CmdPrompt); got != 2 {
		t.Fatalf("prompt attempts = %d, want exactly 2", got)
	}
	if got := h.daemon.RequestCount(omorpc.CmdOpenSession); got != 2 {
		t.Fatalf("open attempts = %d, want initial plus one resume", got)
	}
}

func TestDetachedInRunSendResumesAndRetriesWithOriginalAdmission(t *testing.T) {
	for _, tc := range []struct {
		name    string
		kind    string
		command string
	}{
		{name: "steer", kind: "steer", command: omorpc.CmdSteer},
		{name: "follow-up", kind: "follow_up", command: omorpc.CmdFollowUp},
	} {
		t.Run(tc.name, func(t *testing.T) {
			chatID := "send-detached-" + tc.name + "-resume"
			h := newInPlaceBridgeHarness(t, chatID)
			conn, frames := h.connect(t)
			writeClient(t, conn, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": chatID})
			frames.next(t, "ready")
			h.daemon.EmitSession(h.path, map[string]any{"type": omorpctest.EventAgentStart})
			frames.next(t, "run.started")

			releaseRaw := h.daemon.BlockHandler(tc.command)
			var releaseOnce sync.Once
			release := func() { releaseOnce.Do(releaseRaw) }
			defer release()
			requestID := "retry-" + tc.name
			writeClient(t, conn, map[string]any{
				"type": "chat.send", "sessionId": chatID, "requestId": requestID,
				"run": map[string]any{"kind": tc.kind, "message": "retry in run"},
			})
			if ack := frames.next(t, "ack"); ack["requestId"] != requestID || ack["phase"] != nil {
				t.Fatalf("initial admission = %#v", ack)
			}
			if !h.daemon.AwaitRequestCount(tc.command, 1, 5*time.Second) {
				t.Fatalf("initial %s was not observed", tc.name)
			}
			h.daemon.UnloadSession(h.path)
			frames.next(t, "error")
			release()

			if !h.daemon.AwaitRequestCount(tc.command, 2, 5*time.Second) {
				t.Fatalf("%s was not retried", tc.name)
			}
			if got := h.daemon.RequestCount(tc.command); got != 2 {
				t.Fatalf("%s attempts = %d, want exactly 2", tc.name, got)
			}
		})
	}
}

func TestResumeAndOriginalRetryStayAheadOfWaitingSend(t *testing.T) {
	h := newInPlaceBridgeHarness(t, "send-resume-serialized")
	firstConn, first := h.connect(t)
	writeClient(t, firstConn, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": "send-resume-serialized"})
	first.next(t, "ready")
	writeClient(t, firstConn, map[string]any{"type": "ping"})
	first.next(t, "pong")
	h.daemon.UnloadSession(h.path)
	first.next(t, "error")
	beforeOpen := h.daemon.RequestCount(omorpc.CmdOpenSession)
	releaseOpenRaw := h.daemon.BlockHandler(omorpc.CmdOpenSession)
	var releaseOpenOnce sync.Once
	releaseOpen := func() { releaseOpenOnce.Do(releaseOpenRaw) }
	defer releaseOpen()
	writeClient(t, firstConn, map[string]any{
		"type": "chat.send", "sessionId": "send-resume-serialized", "requestId": "original",
		"run": map[string]any{"kind": "prompt", "message": "original retry"},
	})
	if !h.daemon.AwaitRequestCount(omorpc.CmdOpenSession, beforeOpen+1, 5*time.Second) {
		t.Fatal("original send did not enter blocked resume")
	}
	writeClient(t, firstConn, map[string]any{
		"type": "chat.send", "sessionId": "send-resume-serialized", "requestId": "later",
		"run": map[string]any{"kind": "prompt", "message": "later send"},
	})
	releaseOpen()
	if !h.daemon.AwaitRequestCount(omorpc.CmdPrompt, 1, 5*time.Second) {
		t.Fatal("original retry did not reach provider")
	}
	if got := h.daemon.LastRequest(omorpc.CmdPrompt)["message"]; got != "original retry" {
		t.Fatalf("first prompt after resume = %q, want original retry", got)
	}
	for {
		outcome := first.next(t, "error")
		if outcome["requestId"] == "later" {
			if outcome["command"] != "chat.send" || outcome["code"] != "prompt_in_flight" {
				t.Fatalf("queued same-socket send outcome = %#v", outcome)
			}
			break
		}
	}
}

func TestQueuedControlsRefreshRecoveredBindingAfterAdmissionWait(t *testing.T) {
	h := newInPlaceBridgeHarness(t, "queued-control-refresh")
	conn, frames := h.connect(t)
	writeClient(t, conn, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": "queued-control-refresh"})
	frames.next(t, "ready")
	writeClient(t, conn, map[string]any{"type": "ping"})
	frames.next(t, "pong")
	h.daemon.UnloadSession(h.path)
	frames.next(t, "error")

	beforeOpen := h.daemon.RequestCount(omorpc.CmdOpenSession)
	beforeCommands := h.daemon.RequestCount(omorpc.CmdGetCommands)
	releaseOpenRaw := h.daemon.BlockHandler(omorpc.CmdOpenSession)
	var releaseOpenOnce sync.Once
	releaseOpen := func() { releaseOpenOnce.Do(releaseOpenRaw) }
	defer releaseOpen()
	writeClient(t, conn, map[string]any{
		"type": "chat.send", "sessionId": "queued-control-refresh", "requestId": "trigger-recovery",
		"run": map[string]any{"kind": "prompt", "message": "resume"},
	})
	if !h.daemon.AwaitRequestCount(omorpc.CmdOpenSession, beforeOpen+1, 5*time.Second) {
		t.Fatal("recovery did not enter blocked open")
	}

	serverConn := h.soleServerConnection(t)
	abortDone := make(chan struct{})
	commandsDone := make(chan struct{})
	go func() {
		serverConn.routeFrame(context.Background(), &wscontract.ChatAbortFrame{Type: "chat.abort", SessionID: "queued-control-refresh"}, "chat.abort")
		close(abortDone)
	}()
	go func() {
		serverConn.routeFrame(context.Background(), &wscontract.ChatCommandsFrame{Type: "chat.commands", SessionID: "queued-control-refresh"}, "chat.commands")
		close(commandsDone)
	}()
	releaseOpen()
	select {
	case <-abortDone:
	case <-time.After(5 * time.Second):
		t.Fatal("queued abort did not finish")
	}
	select {
	case <-commandsDone:
	case <-time.After(5 * time.Second):
		t.Fatal("queued query did not finish")
	}
	if !h.daemon.AwaitRequestCount(omorpc.CmdAbort, 1, 5*time.Second) {
		t.Fatal("queued abort did not reach the recovered route")
	}
	if !h.daemon.AwaitRequestCount(omorpc.CmdGetCommands, beforeCommands+2, 5*time.Second) {
		t.Fatal("queued query did not reach the recovered route")
	}
}

func TestPostHydrationMetadataChangeSettlesRecoveredSend(t *testing.T) {
	h := newInPlaceBridgeHarness(t, "hydration-revalidation")
	conn, frames := h.connect(t)
	writeClient(t, conn, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": "hydration-revalidation"})
	frames.next(t, "ready")
	writeClient(t, conn, map[string]any{"type": "ping"})
	frames.next(t, "pong")
	h.daemon.UnloadSession(h.path)
	frames.next(t, "error")

	beforeEntries := h.daemon.RequestCount(omorpc.CmdGetEntries)
	releaseEntriesRaw := h.daemon.BlockHandler(omorpc.CmdGetEntries)
	var releaseEntriesOnce sync.Once
	releaseEntries := func() { releaseEntriesOnce.Do(releaseEntriesRaw) }
	defer releaseEntries()
	writeClient(t, conn, map[string]any{
		"type": "chat.send", "sessionId": "hydration-revalidation", "requestId": "metadata-changed",
		"run": map[string]any{"kind": "prompt", "message": "must settle"},
	})
	if !h.daemon.AwaitRequestCount(omorpc.CmdGetEntries, beforeEntries+1, 5*time.Second) {
		t.Fatal("recovery did not enter blocked hydration")
	}
	h.chatVersion.Add(1)
	releaseEntries()
	failure := frames.next(t, "error")
	if failure["code"] != "resume_failed" || failure["command"] != "chat.send" || failure["requestId"] != "metadata-changed" {
		t.Fatalf("post-hydration recovery failure = %#v", failure)
	}
	if got := h.daemon.RequestCount(omorpc.CmdPrompt); got != 0 {
		t.Fatalf("post-hydration metadata change forwarded %d prompts", got)
	}
}

func TestPostHydrationQuarantineSettlesRecoveredSend(t *testing.T) {
	h := newInPlaceBridgeHarness(t, "hydration-quarantine")
	conn, frames := h.connect(t)
	writeClient(t, conn, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": "hydration-quarantine"})
	frames.next(t, "ready")
	writeClient(t, conn, map[string]any{"type": "ping"})
	frames.next(t, "pong")
	h.daemon.UnloadSession(h.path)
	frames.next(t, "error")

	beforeEntries := h.daemon.RequestCount(omorpc.CmdGetEntries)
	releaseEntriesRaw := h.daemon.BlockHandler(omorpc.CmdGetEntries)
	var releaseEntriesOnce sync.Once
	releaseEntries := func() { releaseEntriesOnce.Do(releaseEntriesRaw) }
	defer releaseEntries()
	writeClient(t, conn, map[string]any{
		"type": "chat.send", "sessionId": "hydration-quarantine", "requestId": "quarantined-during-hydration",
		"run": map[string]any{"kind": "prompt", "message": "must settle"},
	})
	if !h.daemon.AwaitRequestCount(omorpc.CmdGetEntries, beforeEntries+1, 5*time.Second) {
		t.Fatal("recovery did not enter blocked hydration")
	}
	resumed, ok := h.manager.Get("hydration-quarantine")
	if !ok {
		t.Fatal("resumed route was not published before hydration")
	}
	if err := os.Remove(h.path); err != nil {
		t.Fatal(err)
	}
	if err := resumed.SetThinking(context.Background(), "high", "quarantine-trigger"); err == nil {
		t.Fatal("concurrent mutation did not detect the missing session file")
	}
	releaseEntries()
	for {
		failure := frames.next(t, "error")
		if failure["requestId"] != "quarantined-during-hydration" {
			continue
		}
		if failure["code"] != "external-write-detected" || failure["command"] != "chat.send" {
			t.Fatalf("post-hydration quarantine failure = %#v", failure)
		}
		break
	}
	if got := h.daemon.RequestCount(omorpc.CmdPrompt); got != 0 {
		t.Fatalf("post-hydration quarantine forwarded %d prompts", got)
	}
}

func TestRecoveryReplayCannotEndConcurrentRebindReplay(t *testing.T) {
	h := newInPlaceBridgeHarness(t, "replay-owner-a")
	otherID := "replay-owner-b"
	otherPath := filepath.Join(filepath.Dir(h.path), otherID+".jsonl")
	otherBody := fmt.Sprintf("{\"type\":\"session\",\"id\":\"durable-%s\",\"version\":3,\"timestamp\":\"2026-09-03T00:00:00Z\",\"cwd\":%s}\n{\"type\":\"message\",\"id\":\"other-root\",\"parentId\":null,\"message\":{\"role\":\"user\",\"content\":\"other\"}}\n", otherID, mustJSON(t, filepath.Dir(h.path)))
	if err := os.WriteFile(otherPath, []byte(otherBody), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := h.daemon.LoadSessionFile(otherPath); err != nil {
		t.Fatal(err)
	}
	if err := h.store.SaveChat(cursorstore.Chat{ID: otherID, WorkspaceID: "ws-1", CWD: filepath.Dir(h.path), Name: otherID, SessionFile: otherPath, DurableSessionID: "durable-" + otherID, SessionProvenance: cursorstore.SessionProvenanceInPlace}); err != nil {
		t.Fatal(err)
	}

	conn, frames := h.connect(t)
	writeClient(t, conn, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": "replay-owner-a"})
	frames.next(t, "ready")
	writeClient(t, conn, map[string]any{"type": "ping"})
	frames.next(t, "pong")
	h.daemon.UnloadSession(h.path)
	frames.next(t, "error")

	beforeEntries := h.daemon.RequestCount(omorpc.CmdGetEntries)
	releaseARaw := h.daemon.BlockHandlerForPath(omorpc.CmdGetEntries, h.path)
	releaseBRaw := h.daemon.BlockHandlerForPath(omorpc.CmdGetEntries, otherPath)
	var releaseAOnce, releaseBOnce sync.Once
	releaseA := func() { releaseAOnce.Do(releaseARaw) }
	releaseB := func() { releaseBOnce.Do(releaseBRaw) }
	t.Cleanup(releaseA)
	t.Cleanup(releaseB)
	writeClient(t, conn, map[string]any{
		"type": "chat.send", "sessionId": "replay-owner-a", "requestId": "rebind-retry",
		"run": map[string]any{"kind": "prompt", "message": "retry"},
	})
	if !h.daemon.AwaitRequestCount(omorpc.CmdGetEntries, beforeEntries+1, 5*time.Second) {
		t.Fatal("recovery did not enter staged history replay")
	}
	writeClient(t, conn, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": otherID})
	if !h.daemon.AwaitRequestCount(omorpc.CmdGetEntries, beforeEntries+2, 5*time.Second) {
		t.Fatal("concurrent rebind did not enter history replay")
	}
	for {
		if ready := frames.next(t, "ready"); ready["sessionId"] == otherID {
			break
		}
	}
	releaseA()
	if !h.daemon.AwaitRequestCount(omorpc.CmdPrompt, 1, 5*time.Second) {
		t.Fatal("recovery retry did not settle its replay")
	}
	serverConn := h.soleServerConnection(t)
	serverConn.outboundMu.Lock()
	replayOwnedByCurrent := serverConn.replayActive && serverConn.replayOwner == serverConn.sub
	serverConn.outboundMu.Unlock()
	if !replayOwnedByCurrent {
		t.Fatal("stale recovery replay terminated the concurrent binding replay")
	}
	releaseB()
	for {
		if got := frames.next(t, "entries"); got["sessionId"] == otherID && got["final"] == true {
			break
		}
	}
	writeClient(t, conn, map[string]any{"type": "ping"})
	frames.next(t, "pong")
}

func TestDetachedResumableRetrySurvivesOriginatingSocketDisconnect(t *testing.T) {
	h := newInPlaceBridgeHarness(t, "send-detached-disconnect")
	conn, frames := h.connect(t)
	writeClient(t, conn, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": "send-detached-disconnect"})
	frames.next(t, "ready")
	writeClient(t, conn, map[string]any{"type": "ping"})
	frames.next(t, "pong")

	releasePrompt := h.daemon.BlockHandler(omorpc.CmdPrompt)
	h.daemon.SetPromptScript(h.path,
		map[string]any{"type": omorpctest.EventAgentStart},
		map[string]any{"type": omorpctest.EventAgentSettled, "reason": "end_turn"},
	)
	writeClient(t, conn, map[string]any{
		"type": "chat.send", "sessionId": "send-detached-disconnect", "requestId": "survives-disconnect",
		"run": map[string]any{"kind": "prompt", "message": "retry while detached"},
	})
	frames.next(t, "ack")
	if !h.daemon.AwaitRequestCount(omorpc.CmdPrompt, 1, 5*time.Second) {
		t.Fatal("initial prompt was not observed")
	}
	h.daemon.UnloadSession(h.path)
	frames.next(t, "error")
	serverDone := h.soleServerConnectionDone(t)
	if err := conn.WriteClose(1000, nil); err != nil {
		t.Fatal(err)
	}
	select {
	case <-serverDone:
	case <-time.After(5 * time.Second):
		t.Fatal("server connection context was not cancelled after client close")
	}
	releasePrompt()
	if !h.daemon.AwaitRequestCount(omorpc.CmdPrompt, 2, 5*time.Second) {
		t.Fatal("detached operation was not retried")
	}

	reconnected, replay := h.connect(t)
	writeClient(t, reconnected, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": "send-detached-disconnect"})
	replay.next(t, "ready")
	writeClient(t, reconnected, map[string]any{"type": "ping"})
	replay.next(t, "pong")
}

func TestSuccessfulSteerAndIdenticalFollowUpEmitCompletedAcks(t *testing.T) {
	h := newInPlaceBridgeHarness(t, "send-completed")
	conn, frames := h.connect(t)
	writeClient(t, conn, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": "send-completed"})
	frames.next(t, "ready")
	h.daemon.EmitSession(h.path, map[string]any{"type": omorpctest.EventAgentStart})
	frames.next(t, "run.started")

	const message = "same canonical message"
	writeClient(t, conn, map[string]any{
		"type": "chat.send", "sessionId": "send-completed", "requestId": "steer-success",
		"run": map[string]any{"kind": "steer", "message": message},
	})
	nextSuccessfulSendAcks(t, frames, "steer-success")
	if !h.daemon.AwaitRequestCount(omorpc.CmdSteer, 1, 5*time.Second) {
		t.Fatal("successful steer was not forwarded")
	}

	writeClient(t, conn, map[string]any{
		"type": "chat.send", "sessionId": "send-completed", "requestId": "follow-success",
		"run": map[string]any{"kind": "follow_up", "message": message},
	})
	nextSuccessfulSendAcks(t, frames, "follow-success")
	if !h.daemon.AwaitRequestCount(omorpc.CmdFollowUp, 1, 5*time.Second) {
		t.Fatal("successful follow-up was not forwarded")
	}
}

func TestFullSendLedgerReplayActivatesNewWebSocketSubscriber(t *testing.T) {
	h := newInPlaceBridgeHarness(t, "send-full-ledger")
	conn, frames := h.connect(t)
	writeClient(t, conn, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": "send-full-ledger"})
	frames.next(t, "ready")
	h.daemon.EmitSession(h.path, map[string]any{"type": omorpctest.EventAgentStart})
	frames.next(t, "run.started")

	for i := 0; i < session.SendOperationLedgerCapacity; i++ {
		requestID := fmt.Sprintf("full-ledger-%02d", i)
		writeClient(t, conn, map[string]any{
			"type": "chat.send", "sessionId": "send-full-ledger", "requestId": requestID,
			"run": map[string]any{"kind": "follow_up", "message": requestID},
		})
		nextSuccessfulSendAcks(t, frames, requestID)
	}

	reconnected, replay := h.connect(t)
	writeClient(t, reconnected, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": "send-full-ledger"})
	if ready := replay.next(t, "ready"); ready["sessionId"] != "send-full-ledger" {
		t.Fatalf("reconnect ready = %v", ready)
	}
	writeClient(t, reconnected, map[string]any{"type": "ping"})
	replay.next(t, "pong")
}

func TestChatSendRequestIDReplaysAndDeduplicatesAfterReconnect(t *testing.T) {
	h := newInPlaceBridgeHarness(t, "send-deduplicate")
	conn, frames := h.connect(t)
	writeClient(t, conn, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": "send-deduplicate"})
	frames.next(t, "ready")
	h.daemon.EmitSession(h.path, map[string]any{"type": omorpctest.EventAgentStart})
	frames.next(t, "run.started")

	releaseRaw := h.daemon.BlockHandler(omorpc.CmdFollowUp)
	var releaseOnce sync.Once
	release := func() { releaseOnce.Do(releaseRaw) }
	t.Cleanup(release)
	request := map[string]any{
		"type": "chat.send", "sessionId": "send-deduplicate", "requestId": "retry-1",
		"run": map[string]any{"kind": "follow_up", "message": "only once"},
	}
	writeClient(t, conn, request)
	if ack := frames.next(t, "ack"); ack["requestId"] != "retry-1" {
		t.Fatalf("initial admission ack = %v", ack)
	}
	if !h.daemon.AwaitRequestCount(omorpc.CmdFollowUp, 1, 5*time.Second) {
		t.Fatal("initial follow-up was not forwarded")
	}
	_ = conn.WriteClose(1000, nil)

	reconnected, replay := h.connect(t)
	writeClient(t, reconnected, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": "send-deduplicate"})
	replay.next(t, "ready")
	writeClient(t, reconnected, request)
	if ack := replay.next(t, "ack"); ack["requestId"] != "retry-1" {
		t.Fatalf("duplicate outcome = %v", ack)
	}
	if got := h.daemon.RequestCount(omorpc.CmdFollowUp); got != 1 {
		t.Fatalf("duplicate request reached provider %d times", got)
	}
	release()
}

func TestChatSendCompletionErrorReplaysAfterDisconnect(t *testing.T) {
	h := newInPlaceBridgeHarness(t, "send-error-replay")
	conn, frames := h.connect(t)
	writeClient(t, conn, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": "send-error-replay"})
	frames.next(t, "ready")
	h.daemon.EmitSession(h.path, map[string]any{"type": omorpctest.EventAgentStart})
	frames.next(t, "run.started")

	h.daemon.FailNext(omorpc.CmdFollowUp, omorpc.ErrCodeTooManySessions)
	releaseRaw := h.daemon.BlockHandler(omorpc.CmdFollowUp)
	var releaseOnce sync.Once
	release := func() { releaseOnce.Do(releaseRaw) }
	t.Cleanup(release)
	writeClient(t, conn, map[string]any{
		"type": "chat.send", "sessionId": "send-error-replay", "requestId": "failed-1",
		"run": map[string]any{"kind": "follow_up", "message": "fails while away"},
	})
	frames.next(t, "ack")
	if !h.daemon.AwaitRequestCount(omorpc.CmdFollowUp, 1, 5*time.Second) {
		t.Fatal("follow-up was not forwarded")
	}
	_ = conn.WriteClose(1000, nil)

	observerConn, observer := h.connect(t)
	writeClient(t, observerConn, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": "send-error-replay"})
	observer.next(t, "ready")
	release()
	if failure := observer.next(t, "error"); failure["requestId"] != "failed-1" || failure["command"] != "chat.send" {
		t.Fatalf("detached completion failure = %v", failure)
	}
	_ = observerConn.WriteClose(1000, nil)

	reconnected, replay := h.connect(t)
	writeClient(t, reconnected, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": "send-error-replay"})
	replay.next(t, "ready")
	failure := replay.next(t, "error")
	if failure["requestId"] != "failed-1" || failure["command"] != "chat.send" || failure["code"] != "provider_error" {
		t.Fatalf("replayed completion failure = %v", failure)
	}
}

func TestChatSendDetachedMutationBackpressure(t *testing.T) {
	h := newInPlaceBridgeHarness(t, "send-backpressure")
	conn, frames := h.connect(t)
	writeClient(t, conn, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": "send-backpressure"})
	frames.next(t, "ready")

	h.daemon.EmitSession(h.path, map[string]any{"type": omorpctest.EventAgentStart})
	frames.next(t, "run.started")

	releaseFollowUps := h.daemon.BlockHandler(omorpc.CmdFollowUp)
	defer releaseFollowUps()
	for i := 0; i < session.DetachedMutationLimit; i++ {
		requestID := fmt.Sprintf("queued-%d", i)
		writeClient(t, conn, map[string]any{
			"type": "chat.send", "sessionId": "send-backpressure", "requestId": requestID,
			"run": map[string]any{"kind": "follow_up", "message": requestID},
		})
		if ack := frames.next(t, "ack"); ack["requestId"] != requestID {
			t.Fatalf("queued admission ack = %v, want %q", ack, requestID)
		}
	}
	writeClient(t, conn, map[string]any{
		"type": "chat.send", "sessionId": "send-backpressure", "requestId": "overflow",
		"run": map[string]any{"kind": "follow_up", "message": "overflow"},
	})
	failure := frames.next(t, "error")
	if failure["code"] != "send_backpressure" || failure["command"] != "chat.send" || failure["requestId"] != "overflow" {
		t.Fatalf("backpressure error = %v", failure)
	}
}

func mustJSON(t *testing.T, value any) []byte {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestChatCreateMissingInPlaceSourceReportsExternalWrite(t *testing.T) {
	h := newInPlaceBridgeHarness(t, "missing-source")
	if err := os.Remove(h.path); err != nil {
		t.Fatal(err)
	}

	conn, frames := h.connect(t)
	writeClient(t, conn, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": "missing-source"})
	if got := frames.next(t, "error"); got["code"] != "external-write-detected" {
		t.Fatalf("missing source error = %#v", got)
	}
	if got := h.daemon.RequestCount(omorpc.CmdOpenSession); got != 0 {
		t.Fatalf("missing source issued %d provider opens", got)
	}
}

func TestChatCreateSessionActiveConflictsUseContractCode(t *testing.T) {
	t.Run("activity gate", func(t *testing.T) {
		h := newInPlaceBridgeHarness(t, "gate-active")
		AuthorizeInPlaceOpen(h.store, "gate-active", false, func(context.Context, string, time.Duration) (SessionActivity, error) {
			return SessionActivity{SizeDelta: 1}, nil
		})
		conn, frames := h.connect(t)
		writeClient(t, conn, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": "gate-active"})
		if got := frames.next(t, "error"); got["code"] != "session-active" {
			t.Fatalf("activity gate error = %#v", got)
		}
		if got := h.daemon.RequestCount(omorpc.CmdOpenSession); got != 0 {
			t.Fatalf("activity gate issued %d provider opens", got)
		}
	})

	t.Run("provider path in use", func(t *testing.T) {
		h := newInPlaceBridgeHarness(t, "provider-active")
		AuthorizeInPlaceOpen(h.store, "provider-active", true, nil)
		h.daemon.FailOpenPath(h.path, omorpc.ErrCodeSessionPathInUse, 3)
		conn, frames := h.connect(t)
		writeClient(t, conn, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": "provider-active"})
		if got := frames.next(t, "error"); got["code"] != "session-active" {
			t.Fatalf("provider path-in-use error = %#v", got)
		}
		if got := h.daemon.RequestCount(omorpc.CmdOpenSession); got != 3 {
			t.Fatalf("provider path-in-use attempts = %d, want 3", got)
		}
	})
}

func TestChatCreateExternalWriteRequiresExplicitRecovery(t *testing.T) {
	h := newInPlaceBridgeHarness(t, "external-recovery")
	AuthorizeInPlaceOpen(h.store, "external-recovery", true, func(context.Context, string, time.Duration) (SessionActivity, error) {
		return SessionActivity{}, nil
	})
	firstConn, firstFrames := h.connect(t)
	writeClient(t, firstConn, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": "external-recovery"})
	firstFrames.next(t, "ready")
	for {
		if got := firstFrames.next(t, "entries"); got["final"] == true {
			break
		}
	}

	file, err := os.OpenFile(h.path, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	_, writeErr := file.WriteString("{\"type\":\"message\",\"id\":\"external-leaf\",\"parentId\":\"root\",\"message\":{\"role\":\"user\",\"content\":\"external\"}}\n")
	closeErr := file.Close()
	if writeErr != nil || closeErr != nil {
		t.Fatalf("append external entry: write=%v close=%v", writeErr, closeErr)
	}

	secondConn, secondFrames := h.connect(t)
	writeClient(t, secondConn, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": "external-recovery"})
	if got := secondFrames.next(t, "error"); got["code"] != "external-write-detected" || got["knownLeaf"] != "root" || got["observedLeaf"] != "external-leaf" {
		t.Fatalf("quarantine frame = %#v", got)
	}
	beforeOpens := h.daemon.RequestCount(omorpc.CmdOpenSession)
	beforeCloses := h.daemon.RequestCount(omorpc.CmdCloseSession)

	ordinaryConn, ordinaryFrames := h.connect(t)
	writeClient(t, ordinaryConn, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": "external-recovery"})
	if got := ordinaryFrames.next(t, "error"); got["code"] != "external-write-detected" || got["knownLeaf"] != "root" || got["observedLeaf"] != "external-leaf" {
		t.Fatalf("ordinary quarantined create = %#v", got)
	}
	if got := h.daemon.RequestCount(omorpc.CmdOpenSession); got != beforeOpens {
		t.Fatalf("ordinary create opened provider route: %d -> %d", beforeOpens, got)
	}
	if got := h.daemon.RequestCount(omorpc.CmdCloseSession); got != beforeCloses {
		t.Fatalf("ordinary create closed quarantined route: %d -> %d", beforeCloses, got)
	}

	// The quarantine transition is now published to every attached subscriber
	// exactly once (unsolicited); drain it before the command-bound error.
	if got := firstFrames.next(t, "error"); got["code"] != "external-write-detected" || got["command"] != nil {
		t.Fatalf("unsolicited quarantine transition = %#v", got)
	}

	writeClient(t, firstConn, map[string]any{"type": "chat.send", "sessionId": "external-recovery", "run": map[string]any{"kind": "prompt", "message": "stale"}})
	if got := firstFrames.next(t, "error"); got["code"] != "external-write-detected" || got["knownLeaf"] != "root" || got["observedLeaf"] != "external-leaf" || got["command"] != "chat.send" {
		t.Fatalf("stale prompt error = %#v", got)
	}

	recoveryConn, recoveryFrames := h.connect(t)
	writeClient(t, recoveryConn, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": "external-recovery", "recovery": true})
	if got := recoveryFrames.next(t, "ready"); got["resumed"] != true {
		t.Fatalf("recovery ready = %#v", got)
	}
	if got := h.daemon.RequestCount(omorpc.CmdCloseSession); got != beforeCloses+1 {
		t.Fatalf("recovery closes = %d, want %d", got, beforeCloses+1)
	}
	if got := h.daemon.RequestCount(omorpc.CmdOpenSession); got != beforeOpens+1 {
		t.Fatalf("recovery opens = %d, want %d", got, beforeOpens+1)
	}
	if got, _ := h.daemon.LastRequest(omorpc.CmdOpenSession)["sessionPath"].(string); got != h.path {
		t.Fatalf("recovery opened %q, want exact original %q", got, h.path)
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
