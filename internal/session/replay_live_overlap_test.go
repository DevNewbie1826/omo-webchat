package session

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

// The replay/live overlap: while a reattaching subscriber's incremental
// history fetch is in flight, the engine can complete a message whose entry
// the history read already covers. The engine emits the wire message_end
// first, persists the entry, then emits entry_appended (agent-session.js
// processes all three on its event queue in that order). The subscriber
// therefore receives BOTH the replayed entry (in the entries pages) and the
// live message frame (from the pendingLive drain) — the same response
// delivered twice.
//
// The daemon reproduces the engine order exactly: EmitSession(message_end)
// is the wire event, AppendHistory is the persistence that makes the entry
// visible to get_entries, and EmitSession(entry_appended) carries the
// durable entry id plus message payload.

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

// countToken counts how many times token occurs across the JSON encoding of
// every collected frame (entries pages carry it once per replayed copy,
// message frames once per live copy).
func countToken(frames []Frame, token string, t *testing.T) int {
	t.Helper()
	total := 0
	for _, f := range frames {
		b, err := json.Marshal(f)
		if err != nil {
			t.Fatalf("marshal frame: %v", err)
		}
		total += strings.Count(string(b), token)
	}
	return total
}

func TestReplayOverlapSuppressesLiveDuplicateOfReplayedEntry(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	store := newMemStore()
	seedCtx, seedCancel := context.WithTimeout(context.Background(), testTimeout)
	defer seedCancel()
	response, err := client.Call(seedCtx, omorpc.OpenSession{CWD: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	var opened omorpc.OpenSessionData
	if err := json.Unmarshal(response.Data, &opened); err != nil {
		t.Fatal(err)
	}
	d.SetPromptScript(opened.State.SessionFile,
		map[string]any{"type": "message_end", "message": map[string]any{
			"role": "assistant", "content": []any{map[string]any{"type": "text", "text": "seed-one"}},
		}},
		map[string]any{"type": "message_end", "message": map[string]any{
			"role": "assistant", "content": []any{map[string]any{"type": "text", "text": "seed-two"}},
		}},
		map[string]any{"type": "agent_settled"},
	)
	if _, err := client.Call(seedCtx, omorpc.Prompt{SessionID: opened.SessionID, Message: "seed"}); err != nil {
		t.Fatal(err)
	}
	// Seeded history: the prompt's user entry plus the two scripted entries.
	seedLeaf := "entry-3"
	cwd := filepath.Dir(opened.State.SessionFile)
	chat := testChat{id: "overlap", cwd: cwd}
	_ = store.SaveCursor(context.Background(), chat.id, Cursor{SessionFile: opened.State.SessionFile})
	mgr := testManager(t, client, store, 64)

	releaseTail := d.BlockHandlerForPath(omorpc.CmdGetEntries, opened.State.SessionFile)
	sub := newRecorder(64)
	acquired := make(chan error, 1)
	go func() {
		_, _, _, err := mgr.Acquire(context.Background(), chat, sub)
		acquired <- err
	}()
	if !d.AwaitRequestCountForPath(omorpc.CmdGetEntries, opened.State.SessionFile, 1, testTimeout) {
		t.Fatal("incremental tail fetch never arrived")
	}

	// Engine order while the tail read is still in flight: wire message_end,
	// then persistence (the entry joins the daemon's history the get_entries
	// response will read), then the entry_appended event carrying the id.
	d.EmitSession(opened.State.SessionFile, map[string]any{"type": "message_end", "message": overlapDupMessage()})
	if !d.AppendHistory(opened.State.SessionFile, "assistant", overlapDupToken) {
		t.Fatal("persisting the overlap entry failed")
	}
	d.EmitSession(opened.State.SessionFile, map[string]any{
		"type":  "entry_appended",
		"entry": map[string]any{"type": "message", "id": "entry-4", "message": overlapDupMessage()},
	})
	// A non-message live frame must always survive the drain.
	d.EmitSession(opened.State.SessionFile, map[string]any{
		"type":                  "message_delta",
		"assistantMessageEvent": map[string]any{"type": "text_delta", "delta": "tick"},
	})
	// Sentinel: a live message whose entry is NOT replayed must always be
	// delivered, proving the drain flushed and suppression is id-scoped.
	d.EmitSession(opened.State.SessionFile, map[string]any{"type": "message_end", "message": overlapSentinelMessage()})
	d.EmitSession(opened.State.SessionFile, map[string]any{
		"type":  "entry_appended",
		"entry": map[string]any{"type": "message", "id": "entry-5", "message": overlapSentinelMessage()},
	})

	releaseTail()
	select {
	case err := <-acquired:
		if err != nil {
			t.Fatalf("Acquire: %v", err)
		}
	case <-time.After(testTimeout):
		t.Fatal("Acquire did not settle")
	}

	var collected []Frame
	sentinelSeen := false
	deltaSeen := false
	deadline := time.After(testTimeout)
	for !(sentinelSeen && deltaSeen) {
		select {
		case f := <-sub.ch:
			collected = append(collected, f)
			if f.Kind == FrameMessage {
				if b, err := json.Marshal(f); err == nil && strings.Contains(string(b), overlapSentinelToken) {
					sentinelSeen = true
				}
			}
			if f.Kind == FrameMessageDelta {
				deltaSeen = true
			}
		case <-deadline:
			t.Fatalf("timed out collecting frames; sentinel=%v delta=%v frames=%d", sentinelSeen, deltaSeen, len(collected))
		}
	}
	// Drain anything already queued behind the sentinel.
	collected = append(collected, sub.drain()...)

	dupCount := countToken(collected, overlapDupToken, t)
	if dupCount != 1 {
		t.Fatalf("overlap message deliveries = %d (leaf %q), want exactly 1 (replayed entry or live frame, never both); frames:\n%s", dupCount, seedLeaf, framesSummary(collected))
	}
	sentinelCount := countToken(collected, overlapSentinelToken, t)
	if sentinelCount != 1 {
		t.Fatalf("sentinel deliveries = %d, want 1", sentinelCount)
	}
}

func framesSummary(frames []Frame) string {
	var b strings.Builder
	for _, f := range frames {
		fmt.Fprintf(&b, "%s %+v\n", f.Kind, f.Data)
	}
	return b.String()
}
