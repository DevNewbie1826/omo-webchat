package wsbridge

import (
	"context"
	"encoding/json"
	"fmt"
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
	mu      sync.Mutex
	frames  []json.RawMessage
	notify  chan struct{}
	timeout time.Duration
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
		case <-timer.C:
			t.Fatalf("timed out waiting for %s", typ)
		}
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

	frame, err := wscontract.ParseClientFrame([]byte(`{"type":"ping"}`))
	if err != nil {
		t.Fatalf("parse ping: %v", err)
	}
	started := time.Now()
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
	if afterReattach.SessionFile != chat.SessionFile || afterReattach.SessionProvenance != "" {
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
	daemon  *omorpctest.Daemon
	store   *cursorstore.Store
	manager *session.Manager
	server  *httptest.Server
	path    string
}

func newInPlaceBridgeHarness(t *testing.T, chatID string) *inPlaceBridgeHarness {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, chatID+".jsonl")
	body := "{\"type\":\"session\",\"id\":\"durable-" + chatID + "\",\"version\":3,\"timestamp\":\"2026-09-03T00:00:00Z\",\"cwd\":" + string(mustJSON(t, dir)) + "}\n" +
		"{\"type\":\"message\",\"id\":\"root\",\"parentId\":null,\"message\":{\"role\":\"user\",\"content\":\"before\"}}\n"
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
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
	server := httptest.NewServer(New(Config{Manager: manager, Store: store}))
	t.Cleanup(func() {
		server.Close()
		_ = manager.CloseAll(context.Background())
		_ = client.Close()
		d.Stop()
	})
	return &inPlaceBridgeHarness{daemon: d, store: store, manager: manager, server: server, path: path}
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

	h.daemon.FailNext(omorpc.CmdPrompt, omorpc.ErrCodeUnknownSession)
	writeClient(t, conn, map[string]any{
		"type": "chat.send", "sessionId": "send-identity", "requestId": "prompt-1",
		"run": map[string]any{"kind": "prompt", "message": "fail"},
	})
	if ack := frames.next(t, "ack"); ack["command"] != "chat.send" || ack["requestId"] != "prompt-1" {
		t.Fatalf("prompt admission ack = %v", ack)
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
	if ack := frames.next(t, "ack"); ack["command"] != "chat.send" || ack["requestId"] != "prompt-2" {
		t.Fatalf("successful admission ack = %v", ack)
	}

	h.daemon.FailNext(omorpc.CmdFollowUp, omorpc.ErrCodeUnknownSession)
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
	if ack := replay.next(t, "ack"); ack["requestId"] != "retry-1" || ack["command"] != "chat.send" {
		t.Fatalf("replayed admission = %v", ack)
	}
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

	h.daemon.FailNext(omorpc.CmdFollowUp, omorpc.ErrCodeUnknownSession)
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
	observer.next(t, "ack")
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
