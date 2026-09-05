package wsbridge

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/lxzan/gws"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc/omorpctest"
)

func TestTransparentIdleRecoveryBridge(t *testing.T) {
	t.Run("refresh_without_notice", func(t *testing.T) {
		h := newInPlaceBridgeHarnessWithHistory(t, "refresh-without-notice", 3)
		first, firstFrames := h.connect(t)
		attachAndAwaitHistory(t, first, firstFrames, "refresh-without-notice")
		_, stale := h.soleServerConnection(t).binding()
		staleRoute := stale.RoutingID()
		beforeOpen := h.daemon.OpenCount()
		h.daemon.EvictSessionSilently(h.path)

		refresh, frames := h.connect(t)
		writeClient(t, refresh, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": "refresh-without-notice"})
		writeClient(t, refresh, map[string]any{"type": "ping"})
		frames.next(t, "pong")

		assertTerminalHistory(t, frames, 3)
		assertNoBridgeErrors(t, frames)
		recovered, ok := h.manager.Get("refresh-without-notice")
		if !ok || recovered == nil || recovered.RoutingID() == staleRoute || recovered.ID() != stale.ID() || recovered.SessionFile() != stale.SessionFile() {
			t.Fatalf("refresh identity = stale:%+v recovered:%+v", stale, recovered)
		}
		if got := h.daemon.OpenCount() - beforeOpen; got != 1 {
			t.Fatalf("refresh opens = %d, want 1", got)
		}
	})

	t.Run("user_query_after_notice", func(t *testing.T) {
		h := newInPlaceBridgeHarnessWithHistory(t, "query-after-notice", 2)
		conn, frames := h.connect(t)
		attachAndAwaitHistory(t, conn, frames, "query-after-notice")
		writeClient(t, conn, map[string]any{"type": "ping"})
		frames.next(t, "pong")
		clearCollector(frames)
		beforeOpen := h.daemon.OpenCount()

		h.daemon.EvictSessionWithEvent(h.path, "session_closed")
		writeClient(t, conn, map[string]any{"type": "chat.commands", "sessionId": "query-after-notice"})
		writeClient(t, conn, map[string]any{"type": "ping"})
		frames.next(t, "pong")

		frames.next(t, "commands")
		assertNoBridgeErrors(t, frames)
		if got := h.daemon.OpenCount() - beforeOpen; got != 1 {
			t.Fatalf("query recovery opens = %d, want 1", got)
		}
	})

	t.Run("concurrent_refresh_send", func(t *testing.T) {
		h := newInPlaceBridgeHarnessWithHistory(t, "concurrent-refresh-send", 2)
		sendConn, sendFrames := h.connect(t)
		attachAndAwaitHistory(t, sendConn, sendFrames, "concurrent-refresh-send")
		h.daemon.EvictSessionSilently(h.path)
		beforeOpen := h.daemon.OpenCount()
		beforePrompt := h.daemon.RequestCount(omorpc.CmdPrompt)
		releaseOpen := h.daemon.BlockHandler(omorpc.CmdOpenSession)
		defer releaseOpen()

		refreshConn, refreshFrames := h.connect(t)
		writeClient(t, refreshConn, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": "concurrent-refresh-send"})
		if !h.daemon.AwaitRequestCount(omorpc.CmdOpenSession, beforeOpen+1, 5*time.Second) {
			t.Fatal("refresh did not reach the open barrier")
		}
		h.daemon.SetPromptScript(h.path,
			map[string]any{"type": omorpctest.EventAgentStart},
			map[string]any{"type": omorpctest.EventAgentSettled, "reason": "end_turn"},
		)
		writeClient(t, sendConn, map[string]any{
			"type": "chat.send", "sessionId": "concurrent-refresh-send", "requestId": "concurrent-once",
			"run": map[string]any{"kind": "prompt", "message": "accepted once"},
		})
		releaseOpen()
		writeClient(t, refreshConn, map[string]any{"type": "ping"})
		refreshFrames.next(t, "pong")

		if !h.daemon.AwaitRequestCount(omorpc.CmdPrompt, beforePrompt+1, 5*time.Second) {
			sendFrames.mu.Lock()
			pending := append([]json.RawMessage(nil), sendFrames.frames...)
			sendFrames.mu.Unlock()
			t.Fatalf("send did not reach the recovered route; requests=%v frames=%s", h.daemon.Requests(), pending)
		}
		nextSuccessfulSendAcks(t, sendFrames, "concurrent-once")
		assertTerminalHistory(t, refreshFrames, 2)
		assertNoBridgeErrors(t, refreshFrames)
		assertNoBridgeErrors(t, sendFrames)
		if got := h.daemon.OpenCount() - beforeOpen; got != 1 {
			t.Fatalf("concurrent recovery opens = %d, want 1", got)
		}
		if got := h.daemon.RequestCount(omorpc.CmdPrompt) - beforePrompt; got != 1 {
			t.Fatalf("prompt acceptances = %d, want 1", got)
		}
	})

	t.Run("terminal_history_eviction", func(t *testing.T) {
		h := newInPlaceBridgeHarnessWithHistory(t, "terminal-history-eviction", 4)
		first, firstFrames := h.connect(t)
		attachAndAwaitHistory(t, first, firstFrames, "terminal-history-eviction")
		beforeEntries := h.daemon.RequestCount(omorpc.CmdGetEntries)
		beforeOpen := h.daemon.OpenCount()
		releaseEntries := h.daemon.BlockHandlerForPath(omorpc.CmdGetEntries, h.path)
		defer releaseEntries()

		refresh, frames := h.connect(t)
		writeClient(t, refresh, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": "terminal-history-eviction"})
		if !h.daemon.AwaitRequestCount(omorpc.CmdGetEntries, beforeEntries+1, 5*time.Second) {
			t.Fatal("terminal history query did not reach the barrier")
		}
		h.daemon.EvictSessionSilently(h.path)
		releaseEntries()
		writeClient(t, refresh, map[string]any{"type": "ping"})
		frames.next(t, "pong")

		assertTerminalHistory(t, frames, 4)
		assertNoBridgeErrors(t, frames)
		if got := h.daemon.OpenCount() - beforeOpen; got != 1 {
			t.Fatalf("terminal-query recovery opens = %d, want 1", got)
		}
	})

	t.Run("resume_failure", func(t *testing.T) {
		h := newInPlaceBridgeHarnessWithHistory(t, "bounded-resume-failure", 2)
		first, firstFrames := h.connect(t)
		attachAndAwaitHistory(t, first, firstFrames, "bounded-resume-failure")
		h.daemon.EvictSessionSilently(h.path)
		h.daemon.FailOpenPath(h.path, omorpc.ErrCodeSessionPathInUse, 3)
		beforeOpen := h.daemon.OpenCount()

		refresh, frames := h.connect(t)
		writeClient(t, refresh, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": "bounded-resume-failure"})
		failure := frames.next(t, "error")
		if failure["code"] != "session-active" || failure["message"] != "session is active in another process" {
			t.Fatalf("bounded recovery failure = %#v", failure)
		}
		if got := h.daemon.OpenCount() - beforeOpen; got != 3 {
			t.Fatalf("failed recovery opens = %d, want bounded provider retry budget 3", got)
		}
	})
}

func attachAndAwaitHistory(t *testing.T, conn *gws.Conn, frames *collector, chatID string) {
	t.Helper()
	writeClient(t, conn, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": chatID})
	frames.next(t, "ready")
	for {
		if frame := frames.next(t, "entries"); frame["final"] == true {
			return
		}
	}
}

func assertTerminalHistory(t *testing.T, frames *collector, wantEntries int) {
	t.Helper()
	entries := 0
	finals := 0
	frames.mu.Lock()
	defer frames.mu.Unlock()
	for _, raw := range frames.frames {
		var frame map[string]any
		_ = json.Unmarshal(raw, &frame)
		if frame["type"] != "entries" {
			continue
		}
		if page, ok := frame["entries"].([]any); ok {
			entries += len(page)
		}
		if frame["final"] == true {
			finals++
		}
	}
	if entries != wantEntries || finals != 1 {
		t.Fatalf("history entries=%d finals=%d, want entries=%d finals=1; frames=%s", entries, finals, wantEntries, frames.frames)
	}
}

func clearCollector(frames *collector) {
	frames.mu.Lock()
	frames.frames = nil
	frames.mu.Unlock()
}

func assertNoBridgeErrors(t *testing.T, frames *collector) {
	t.Helper()
	frames.mu.Lock()
	defer frames.mu.Unlock()
	for _, raw := range frames.frames {
		var frame map[string]any
		_ = json.Unmarshal(raw, &frame)
		if frame["type"] == "error" {
			t.Fatalf("transparent recovery exposed error: %s", raw)
		}
	}
}
