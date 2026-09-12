package wsbridge

import (
	"encoding/json"
	"path/filepath"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc/omorpctest"
)

func assertNoWireError(t *testing.T, frames *collector) {
	t.Helper()
	frames.mu.Lock()
	defer frames.mu.Unlock()
	for _, raw := range frames.frames {
		var frame map[string]any
		if err := json.Unmarshal(raw, &frame); err != nil {
			t.Fatalf("decode websocket frame: %v", err)
		}
		if frame["type"] == "error" {
			t.Fatalf("unexpected websocket error: %s", raw)
		}
	}
}

func TestChatCreateRetriesOnceAfterTransportDisconnect(t *testing.T) {
	const chatID = "open-disconnect-retry"
	h := newInPlaceBridgeHarness(t, chatID)
	releaseOpen := h.daemon.BlockHandler(omorpc.CmdOpenSession)
	t.Cleanup(releaseOpen)
	conn, frames := h.connect(t)

	writeClient(t, conn, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": chatID})
	if !h.daemon.AwaitRequestCount(omorpc.CmdOpenSession, 1, 5*time.Second) {
		t.Fatal("first acquire did not reach the provider")
	}

	// Replace the endpoint while the first open is unanswered. The old peer
	// closes the request with ErrDisconnected; the successor can serve a retry.
	root := filepath.Dir(h.daemon.SocketPath())
	h.daemon.Stop()
	successor := omorpctest.New(root)
	if err := successor.LoadSessionFile(h.path); err != nil {
		t.Fatal(err)
	}
	if err := successor.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(successor.Stop)
	releaseOpen()

	if ready := frames.nextWithin(t, "ready", 10*time.Second); ready["sessionId"] != chatID {
		t.Fatalf("ready frame = %#v", ready)
	}
	writeClient(t, conn, map[string]any{"type": "ping"})
	frames.nextWithin(t, "pong", 5*time.Second)
	assertNoWireError(t, frames)
	if first, second := h.daemon.RequestCount(omorpc.CmdOpenSession), successor.RequestCount(omorpc.CmdOpenSession); first != 1 || second != 1 {
		t.Fatalf("acquire attempts = %d + %d, want exactly 1 before and 1 after replacement", first, second)
	}
}

func TestChatCreateDisconnectedTransportStillFailsWithinBound(t *testing.T) {
	const chatID = "open-disconnect-exhausted"
	h := newInPlaceBridgeHarness(t, chatID)
	releaseOpen := h.daemon.BlockHandler(omorpc.CmdOpenSession)
	t.Cleanup(releaseOpen)
	conn, frames := h.connect(t)

	writeClient(t, conn, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": chatID})
	if !h.daemon.AwaitRequestCount(omorpc.CmdOpenSession, 1, 5*time.Second) {
		t.Fatal("first acquire did not reach the provider")
	}
	h.daemon.Stop()
	releaseOpen()

	failure := frames.nextWithin(t, "error", 10*time.Second)
	if failure["code"] != "start_failed" || failure["message"] != "could not open the session; please retry" {
		t.Fatalf("disconnected open failure = %#v", failure)
	}
	if got := h.daemon.RequestCount(omorpc.CmdOpenSession); got != 1 {
		t.Fatalf("dead transport acquire attempts = %d, want 1", got)
	}
}

func TestChatCreateDeletedDuringOpenIsNotRetried(t *testing.T) {
	const chatID = "open-deleted-no-retry"
	h := newInPlaceBridgeHarness(t, chatID)
	releaseOpen := h.daemon.BlockHandler(omorpc.CmdOpenSession)
	t.Cleanup(releaseOpen)
	conn, frames := h.connect(t)

	writeClient(t, conn, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": chatID})
	if !h.daemon.AwaitRequestCount(omorpc.CmdOpenSession, 1, 5*time.Second) {
		t.Fatal("acquire did not reach the provider")
	}
	h.chatVersion.Add(1)
	releaseOpen()

	failure := frames.nextWithin(t, "error", 5*time.Second)
	if failure["code"] != "no_chat" {
		t.Fatalf("deleted-chat failure = %#v, want no_chat", failure)
	}
	if got := h.daemon.RequestCount(omorpc.CmdOpenSession); got != 1 {
		t.Fatalf("deleted-chat acquire attempts = %d, want exactly 1", got)
	}
}
