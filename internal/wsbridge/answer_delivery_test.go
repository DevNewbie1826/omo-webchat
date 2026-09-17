package wsbridge

import (
	"context"
	"encoding/json"
	"net"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/cursorstore"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/session"
)

// The current server speaks Unix-socket RPC. Adapt only the transport of the
// executable stdio fixture; every request and event remains real JSONL.
func newAnswerDeliveryHarness(t *testing.T) *inPlaceBridgeHarness {
	t.Helper()
	dir, err := os.MkdirTemp("", "answer-rpc-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	socket := filepath.Join(dir, "rpc.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	fixture, err := filepath.Abs("../../test/mock-pi/mock-pi.mjs")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	accepted := make(chan net.Conn, 1)
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			done <- err
			return
		}
		accepted <- conn
		cmd := exec.CommandContext(ctx, "node", fixture, "--multi-session")
		cmd.Env = append(os.Environ(), "MOCK_PI_APPROVE=1", "MOCK_PI_QUESTION=1", "MOCK_PI_HISTORY_SIZE=1", "MOCK_PI_RESUME_IDENTITY="+filepath.Join(dir, "engine.jsonl"))
		cmd.Stdin, cmd.Stdout, cmd.Stderr = conn, conn, os.Stderr
		done <- cmd.Run()
	}()
	t.Cleanup(func() {
		cancel()
		_ = listener.Close()
		select {
		case conn := <-accepted:
			_ = conn.Close()
		default:
		}
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Error("fixture did not exit")
		}
	})
	client, err := omorpc.Dial(t.Context(), socket)
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
	if err := store.SaveChat(cursorstore.Chat{ID: "answer-delivery", WorkspaceID: "ws-1", CWD: dir, Name: "answer"}); err != nil {
		t.Fatal(err)
	}
	manager := session.NewManager(session.Config{Client: client, Store: (*CursorStore)(store)})
	bridge := New(Config{Manager: manager, Store: store})
	server := httptest.NewServer(bridge)
	t.Cleanup(func() { server.Close(); _ = manager.CloseAll(context.Background()); _ = client.Close() })
	return &inPlaceBridgeHarness{store: store, manager: manager, bridge: bridge, server: server}
}

func TestAnswerDeliveryExpiredQuestion(t *testing.T) {
	h := newAnswerDeliveryHarness(t)
	conn, frames := h.connect(t)
	writeClient(t, conn, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": "answer-delivery"})
	frames.next(t, "ready")
	frames.next(t, "commands")
	writeClient(t, conn, map[string]any{"type": "chat.send", "sessionId": "answer-delivery", "requestId": "ask-turn", "run": map[string]any{"kind": "prompt", "message": "ask"}})
	ask := frames.next(t, "approval")
	// Abort the asking operation in the same engine and conversation. No
	// compaction, process replacement, private session mutation, or sleeps.
	writeClient(t, conn, map[string]any{"type": "chat.abort", "sessionId": "answer-delivery"})
	frames.next(t, "run.done")
	writeClient(t, conn, map[string]any{"type": "approval.respond", "sessionId": "answer-delivery", "requestId": "late-answer", "id": ask["id"], "answers": map[string]any{"q1": map[string]any{"selected": []string{"Go"}}}})
	resolved := frames.next(t, "approval.resolved")
	if resolved["id"] != ask["id"] {
		t.Fatalf("wrong resolution: %v", resolved)
	}
	failure := frames.nextMatching(t, "error", 5*time.Second, func(f map[string]any) bool { return f["requestId"] == "late-answer" })
	t.Logf("terminal resolution=%v failure=%v", resolved, failure)
	late, replay := h.connect(t)
	writeClient(t, late, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": "answer-delivery"})
	replay.next(t, "ready")
	awaitCommandFence(t, late, replay)
	replay.mu.Lock()
	defer replay.mu.Unlock()
	for _, frame := range replay.decoded {
		if frame.typ == "approval" {
			t.Fatalf("expired request replayed: %s", frame.raw)
		}
	}
}

func TestAnswerDeliveryProviderResumeRetiresApproval(t *testing.T) {
	h := newInPlaceBridgeHarness(t, "resumed-answer")
	conn, frames := h.connect(t)
	attachAndAwaitHistory(t, conn, frames, "resumed-answer")
	frames.next(t, "commands")
	h.daemon.EmitSession(h.path, map[string]any{"type": "extension_ui_request", "id": "old-ask", "method": "confirm"})
	frames.next(t, "approval")
	before, ok := h.manager.Get("resumed-answer")
	if !ok {
		t.Fatal("missing original route")
	}
	h.daemon.EvictSessionWithEvent(h.path, "session_unloaded")
	frames.next(t, "approval.resolved")
	writeClient(t, conn, map[string]any{"type": "chat.commands", "sessionId": "resumed-answer"})
	frames.next(t, "commands")
	after, ok := h.manager.Get("resumed-answer")
	if !ok || before.RoutingID() == after.RoutingID() {
		t.Fatal("session did not resume on a new provider route")
	}
	writeClient(t, conn, map[string]any{"type": "approval.respond", "sessionId": "resumed-answer", "requestId": "after-resume", "id": "old-ask", "confirmed": true})
	resolved := frames.next(t, "approval.resolved")
	failure := frames.nextMatching(t, "error", 5*time.Second, func(f map[string]any) bool { return f["requestId"] == "after-resume" })
	if resolved["id"] != "old-ask" {
		t.Fatalf("wrong expired identity: %v", resolved)
	}
	t.Logf("resumed route rejected stale approval: %v", failure)
}

func TestAnswerDeliveryEngineRejectionAfterAck(t *testing.T) {
	h := newInPlaceBridgeHarness(t, "rejected-answer")
	conn, frames := h.connect(t)
	attachAndAwaitHistory(t, conn, frames, "rejected-answer")
	h.daemon.EmitSession(h.path, map[string]any{"type": "extension_ui_request", "id": "ask", "method": "question"})
	frames.next(t, "approval")
	writeClient(t, conn, map[string]any{"type": "approval.respond", "sessionId": "rejected-answer", "requestId": "answer", "id": "ask", "answers": map[string]any{}})
	frames.next(t, "ack")
	// A one-way write can succeed before the engine reports that its waiter
	// disappeared. Drive the late engine response through the real RPC socket.
	h.daemon.EmitSession(h.path, map[string]any{"type": "response", "command": "extension_ui_response", "id": "ask", "success": false, "error": "unknown_request"})
	resolved := frames.next(t, "approval.resolved")
	failure := frames.next(t, "error")
	if resolved["id"] != "ask" || resolved["outcome"] != "expired" || failure["message"] != "unknown_request" {
		t.Fatalf("engine rejection not terminal: resolution=%v failure=%v", resolved, failure)
	}
}

func TestAnswerDeliverySuccessfulQuestion(t *testing.T) {
	h := newAnswerDeliveryHarness(t)
	conn, frames := h.connect(t)
	writeClient(t, conn, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": "answer-delivery"})
	frames.next(t, "ready")
	frames.next(t, "commands")
	writeClient(t, conn, map[string]any{"type": "chat.send", "sessionId": "answer-delivery", "requestId": "ask-turn", "run": map[string]any{"kind": "prompt", "message": "ask"}})
	ask := frames.next(t, "approval")
	writeClient(t, conn, map[string]any{"type": "approval.respond", "sessionId": "answer-delivery", "requestId": "answer", "id": ask["id"], "answers": map[string]any{"q1": map[string]any{"selected": []string{"Go"}}}})
	frames.next(t, "run.done") // same subscriber stream: success ack precedes the resumed turn
	var encoded json.RawMessage
	batch, _, _ := frames.takeDecoded(0)
	for _, frame := range batch {
		if frame.typ != "ack" {
			continue
		}
		var ack map[string]any
		if err := json.Unmarshal(frame.raw, &ack); err != nil {
			t.Fatal(err)
		}
		if ack["requestId"] == "answer" {
			encoded = frame.raw
			break
		}
	}
	const want = `{"command":"extension_ui_response","id":"approve-1","requestId":"answer","sessionId":"answer-delivery","type":"ack"}`
	if string(encoded) != want {
		t.Fatalf("success wire changed: %s", encoded)
	}
	message := frames.next(t, "message")["message"].(map[string]any)
	blocks := message["blocks"].([]any)
	if text := blocks[0].(map[string]any)["text"]; text != `{"q1":{"selected":["Go"]}} (mocked by mock-pi)` {
		t.Fatalf("asking engine did not consume structured answer: %v", message)
	}
	t.Logf("success ack=%s; engine consumed answer", encoded)
}
