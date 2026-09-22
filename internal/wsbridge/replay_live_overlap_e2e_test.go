package wsbridge

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

// Wire-level reproduction of the replay/live overlap: a browser reattaches
// with an incremental history fetch while the engine completes a message.
// The engine emits the wire message_end, persists the entry, then emits
// entry_appended (that exact queue order), so the tail the blocked
// get_entries eventually reads already contains the entry whose live frame
// is queued behind the replay. The browser must receive that response
// exactly once across the entries pages and the drained live frames.
//
// Determinism: RPC responses settle on the client's pending-call path while
// engine events queue for the manager's serial event loop, so releasing the
// blocked get_entries right after emitting events does NOT order the
// session's dispatch against the history response. The test therefore opens
// a first connection before the replay window and waits until IT observed
// the injected live frames before releasing the tail block: both sockets
// are fed by the same synchronous broadcast that retains frames in the
// replaying connection's pendingLive, and event dispatch is FIFO, so the
// last injected frame observed on the barrier connection proves every
// earlier engine event was already dispatched.

const overlapDupToken = "overlap-dup-token-7f3a9c"
const overlapSentinelToken = "overlap-sentinel-token-1d2b"

func overlapDupMessage() map[string]any {
	return map[string]any{
		"role":    "assistant",
		"content": []any{map[string]any{"type": "text", "text": overlapDupToken}},
	}
}

func overlapSentinelMessage() map[string]any {
	return map[string]any{
		"role":    "assistant",
		"content": []any{map[string]any{"type": "text", "text": overlapSentinelToken}},
	}
}

func snapshotFrames(c *collector) []json.RawMessage {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]json.RawMessage(nil), c.frames...)
}

func awaitOverlapSettled(t *testing.T, c *collector, timeout time.Duration) []json.RawMessage {
	t.Helper()
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	for {
		raws := snapshotFrames(c)
		terminal, delta, sentinel := false, false, false
		for _, raw := range raws {
			var head struct {
				Type  string `json:"type"`
				Final bool   `json:"final"`
			}
			if json.Unmarshal(raw, &head) != nil {
				continue
			}
			if head.Type == "entries" && head.Final {
				terminal = true
			}
			if head.Type == "messageDelta" && strings.Contains(string(raw), "tick") {
				delta = true
			}
			if head.Type == "message" && strings.Contains(string(raw), overlapSentinelToken) {
				sentinel = true
			}
		}
		if terminal && delta && sentinel {
			return raws
		}
		c.mu.Lock()
		notify := c.notify
		c.mu.Unlock()
		select {
		case <-notify:
		case <-timer.C:
			t.Fatalf("overlap stream did not settle; terminal=%v delta=%v sentinel=%v frames=%d", terminal, delta, sentinel, len(raws))
		}
	}
}

// awaitOverlapBarrier blocks until the barrier connection observed every
// injected live frame (dup message, delta, sentinel). The tail block may
// only release afterwards.
func awaitOverlapBarrier(t *testing.T, c *collector, timeout time.Duration) {
	t.Helper()
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	for {
		raws := snapshotFrames(c)
		dup, delta, sentinel := false, false, false
		for _, raw := range raws {
			var head struct {
				Type string `json:"type"`
			}
			if json.Unmarshal(raw, &head) != nil {
				continue
			}
			if head.Type == "message" && strings.Contains(string(raw), overlapDupToken) {
				dup = true
			}
			if head.Type == "messageDelta" && strings.Contains(string(raw), "tick") {
				delta = true
			}
			if head.Type == "message" && strings.Contains(string(raw), overlapSentinelToken) {
				sentinel = true
			}
		}
		if dup && delta && sentinel {
			return
		}
		c.mu.Lock()
		notify := c.notify
		c.mu.Unlock()
		select {
		case <-notify:
		case <-timer.C:
			t.Fatalf("barrier connection did not observe injected frames; dup=%v delta=%v sentinel=%v frames=%d", dup, delta, sentinel, len(raws))
		}
	}
}

// awaitOverlapAttachSettled blocks until the connection's attach-time
// history finished (a final entries page arrived), proving the session's
// hydration is no longer in flight before the tail block is armed.
func awaitOverlapAttachSettled(t *testing.T, c *collector, timeout time.Duration) {
	t.Helper()
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	for {
		for _, raw := range snapshotFrames(c) {
			var head struct {
				Type  string `json:"type"`
				Final bool   `json:"final"`
			}
			if json.Unmarshal(raw, &head) == nil && head.Type == "entries" && head.Final {
				return
			}
		}
		c.mu.Lock()
		notify := c.notify
		c.mu.Unlock()
		select {
		case <-notify:
		case <-timer.C:
			t.Fatal("barrier connection attach history never settled")
		}
	}
}

func TestReplayOverlapWebSocketDeliversMessageExactlyOnce(t *testing.T) {
	h := newHistoryBridgeHarness(t, historyE2ETestBudget*2/3)
	ctx, cancel := context.WithTimeout(t.Context(), historyE2ETestBudget)
	defer cancel()
	response, err := h.client.Call(ctx, omorpc.OpenSession{CWD: h.workspace.Path})
	if err != nil {
		t.Fatal(err)
	}
	var opened omorpc.OpenSessionData
	if err := json.Unmarshal(response.Data, &opened); err != nil {
		t.Fatal(err)
	}
	h.daemon.SetPromptScript(opened.State.SessionFile,
		map[string]any{"type": "message_end", "message": map[string]any{
			"role": "assistant", "content": []any{map[string]any{"type": "text", "text": "seed-one"}},
		}},
		map[string]any{"type": "message_end", "message": map[string]any{
			"role": "assistant", "content": []any{map[string]any{"type": "text", "text": "seed-two"}},
		}},
		map[string]any{"type": "agent_settled"},
	)
	if _, err := h.client.Call(ctx, omorpc.Prompt{SessionID: opened.SessionID, Message: "seed"}); err != nil {
		t.Fatal(err)
	}
	h.saveChat(t, "overlap-history", opened.State.SessionFile)

	// The dispatch barrier: a first connection whose attach-time history has
	// settled before the replay window opens.
	preConn, preFrames := h.connect(t, 1024)
	writeClient(t, preConn, map[string]any{
		"type": "chat.create", "wsId": h.workspace.ID, "chatId": "overlap-history",
	})
	preFrames.next(t, "ready")
	awaitOverlapAttachSettled(t, preFrames, historyE2ETestBudget)

	releaseTail := h.daemon.BlockHandlerForPath(omorpc.CmdGetEntries, opened.State.SessionFile)
	conn, frames := h.connect(t, 1024)
	writeClient(t, conn, map[string]any{
		"type": "chat.create", "wsId": h.workspace.ID, "chatId": "overlap-history",
	})
	deadline := time.Now().Add(historyE2ETestBudget)
	// The barrier connection's attach already consumed one get_entries.
	if !h.daemon.AwaitRequestCountForPath(omorpc.CmdGetEntries, opened.State.SessionFile, 2, time.Until(deadline)) {
		t.Fatal("incremental tail fetch never arrived")
	}

	// Engine wire order while the tail read is in flight: message_end, then
	// persistence (AppendHistory makes the entry visible to the get_entries
	// response), then entry_appended with the durable entry id.
	h.daemon.EmitSession(opened.State.SessionFile, map[string]any{"type": "message_end", "message": overlapDupMessage()})
	if !h.daemon.AppendHistory(opened.State.SessionFile, "assistant", overlapDupToken) {
		t.Fatal("persisting the overlap entry failed")
	}
	h.daemon.EmitSession(opened.State.SessionFile, map[string]any{
		"type":  "entry_appended",
		"entry": map[string]any{"type": "message", "id": "entry-4", "message": overlapDupMessage()},
	})
	// A non-message live frame must always survive the drain.
	h.daemon.EmitSession(opened.State.SessionFile, map[string]any{
		"type":                  "message_delta",
		"assistantMessageEvent": map[string]any{"type": "text_delta", "delta": "tick"},
	})
	// Sentinel: a live message whose entry is never replayed must always be
	// delivered, which also proves the pendingLive drain flushed.
	h.daemon.EmitSession(opened.State.SessionFile, map[string]any{"type": "message_end", "message": overlapSentinelMessage()})
	h.daemon.EmitSession(opened.State.SessionFile, map[string]any{
		"type":  "entry_appended",
		"entry": map[string]any{"type": "message", "id": "entry-5", "message": overlapSentinelMessage()},
	})

	// Barrier: FIFO event dispatch means the sentinel observed on the first
	// connection implies the dup frame and both entry_appended events were
	// already consumed by the session.
	awaitOverlapBarrier(t, preFrames, time.Until(deadline))

	releaseTail()
	raws := awaitOverlapSettled(t, frames, time.Until(deadline))

	dupCount, sentinelCount, deltaCount := 0, 0, 0
	for _, raw := range raws {
		dupCount += strings.Count(string(raw), overlapDupToken)
		sentinelCount += strings.Count(string(raw), overlapSentinelToken)
		deltaCount += strings.Count(string(raw), "tick")
	}
	if dupCount != 1 {
		t.Fatalf("overlap message deliveries = %d, want exactly 1 across entries pages and live frames", dupCount)
	}
	if sentinelCount != 1 {
		t.Fatalf("sentinel deliveries = %d, want 1", sentinelCount)
	}
	if deltaCount != 1 {
		t.Fatalf("delta deliveries = %d, want 1", deltaCount)
	}
}
