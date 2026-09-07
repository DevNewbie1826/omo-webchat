package wsbridge

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc/omorpctest"
	"github.com/DevNewbie1826/omo-webchat/internal/sendqueue"
)

func TestRPC46OverflowRetryProtectsDurableBacklog(t *testing.T) {
	for _, exhausted := range []bool{false, true} {
		name := "successful-retry"
		if exhausted {
			name = "exhausted-retry"
		}
		t.Run(name, func(t *testing.T) {
			const chatID = "overflow-queue"
			h := newInPlaceBridgeHarness(t, chatID)
			queuePath := t.TempDir() + "/queue-v1.json"
			queue, err := sendqueue.Load(queuePath)
			if err != nil {
				t.Fatal(err)
			}
			h.bridge.cfg.SendQueue = queue
			conn, frames := h.connect(t)
			writeClient(t, conn, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": chatID})
			frames.next(t, "ready")
			frames.next(t, "queue")
			frames.next(t, "queue")
			sess, ok := h.manager.Get(chatID)
			if !ok {
				t.Fatal("attached session missing")
			}
			join := func() {
				t.Helper()
				ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
				defer cancel()
				release, err := h.manager.EnterChat(ctx, chatID)
				if err != nil {
					t.Fatal(err)
				}
				release()
			}
			h.daemon.SetPromptScript(h.path, map[string]any{"type": omorpctest.EventAgentStart})
			writeClient(t, conn, map[string]any{"type": "chat.send", "sessionId": chatID, "requestId": "running", "run": map[string]any{"kind": "prompt", "message": "running"}})
			nextSuccessfulSendAcks(t, frames, "running")
			frames.next(t, "run.started")
			for _, text := range []string{"first", "second"} {
				writeClient(t, conn, map[string]any{"type": "chat.send", "sessionId": chatID, "requestId": text, "run": map[string]any{"kind": "followUp", "message": text}})
				nextSuccessfulSendAcks(t, frames, text)
				frames.next(t, "queue")
			}
			join()
			revision := queue.Snapshot(chatID).Revision
			assertProtected := func(stage string) {
				t.Helper()
				// A stale idle-drain callback must also leave the durable head untouched.
				h.bridge.SessionRunSettled(chatID, sess)
				join()
				durable, err := sendqueue.Load(queuePath)
				if err != nil {
					t.Fatal(err)
				}
				snapshot := durable.Snapshot(chatID)
				if snapshot.Revision != revision || snapshot.Dispatching != nil || len(snapshot.Items) != 2 || snapshot.Items[0].Text != "first" || snapshot.Items[1].Text != "second" {
					// Join an incorrectly admitted send before Fatal tears down its
					// durable store. The socket collector was attached before sending.
					if snapshot.Dispatching != nil {
						frames.nextMatching(t, "ack", 5*time.Second, func(f map[string]any) bool {
							return f["requestId"] == snapshot.Dispatching.RequestID && f["phase"] == "completed"
						})
						join()
					}
					t.Fatalf("%s drained or rewrote durable backlog before agent_settled: %+v", stage, snapshot)
				}
				if got := h.daemon.RequestCount(omorpc.CmdPrompt); got != 1 {
					t.Fatalf("%s dispatched head before agent_settled: prompts=%d", stage, got)
				}
				frames.mu.Lock()
				defer frames.mu.Unlock()
				for _, f := range frames.decoded {
					if f.typ == "run.done" {
						t.Fatalf("%s synthesized run.done", stage)
					}
				}
			}
			emitBarrier := func(stage string, event map[string]any) {
				t.Helper()
				h.daemon.EmitSession(h.path, event)
				h.daemon.EmitSession(h.path, map[string]any{"type": "state_changed", "rpc46Barrier": stage})
				frames.nextMatching(t, "state", 5*time.Second, func(f map[string]any) bool { return f["rpc46Barrier"] == stage })
			}
			emitBarrier("overflow-start", map[string]any{"type": "compaction_start", "reason": "overflow", "requestId": "auto-1"})
			frames.next(t, "compaction.started")
			assertProtected("overflow-start")
			emitBarrier("retrying-agent-end", map[string]any{"type": "agent_end", "willRetry": true})
			assertProtected("retrying-agent-end")
			emitBarrier("retrying-compaction-end", map[string]any{"type": "compaction_end", "reason": "overflow", "requestId": "auto-1", "willRetry": true})
			frames.next(t, "compaction.done")
			assertProtected("retrying-compaction-end")
			emitBarrier("retry-notice", map[string]any{"type": "auto_retry_start", "message": "continued attempt"})
			frames.nextMatching(t, "notice", 5*time.Second, func(f map[string]any) bool { return f["kind"] == "auto_retry_start" })
			emitBarrier("continued-attempt", map[string]any{"type": "message_delta", "delta": "continued attempt"})
			assertProtected("continued-attempt")
			if exhausted {
				emitBarrier("exhausted", map[string]any{"type": "compaction_end", "reason": "overflow", "willRetry": false, "errorMessage": "QA_OVERFLOW_RECOVERY_EXHAUSTED"})
				// The state marker bounds the notice stream; absence fails immediately.
				batch, _, _ := frames.takeDecoded(0)
				found := 0
				for _, f := range batch {
					var wire map[string]any
					if err := json.Unmarshal(f.raw, &wire); err != nil {
						t.Fatal(err)
					}
					if f.typ == "notice" && wire["kind"] == "compaction_error" {
						found++
						if wire["payload"].(map[string]any)["message"] != "QA_OVERFLOW_RECOVERY_EXHAUSTED" {
							t.Fatalf("lost wire diagnostic: %v", wire)
						}
					}
					if f.typ == "compaction.done" {
						t.Fatal("standalone exhaustion synthesized compaction.done")
					}
				}
				if found != 1 {
					t.Fatalf("explicit terminal overflow diagnostic: got %d websocket notices, want 1", found)
				}
				assertProtected("exhausted")
				emitBarrier("exhausted-replay", map[string]any{"type": "compaction_end", "reason": "overflow", "willRetry": false, "errorMessage": "QA_OVERFLOW_RECOVERY_EXHAUSTED"})
				replayed, _, _ := frames.takeDecoded(len(batch))
				for _, f := range replayed {
					if f.typ == "notice" || f.typ == "error" || f.typ == "compaction.done" || f.typ == "run.done" {
						t.Errorf("exhaustion replay added a presentation or completion: %s", f.raw)
					}
				}
				assertProtected("exhausted-replay")
			}
			emitBarrier("terminal-agent-end", map[string]any{"type": "agent_end", "willRetry": false})
			assertProtected("terminal-agent-end")
			h.daemon.SetPromptScript(h.path, map[string]any{"type": omorpctest.EventAgentStart})
			h.daemon.EmitSession(h.path, map[string]any{"type": "agent_settled", "reason": "end_turn"})
			frames.next(t, "run.done")
			frames.next(t, "run.started")
			frames.nextMatching(t, "ack", 5*time.Second, func(f map[string]any) bool { return f["requestId"] == "first" && f["phase"] == "completed" })
			join()
			if got := h.daemon.RequestCount(omorpc.CmdPrompt); got != 2 {
				t.Fatalf("settlement dispatched %d total prompts, want exactly 2", got)
			}
			durable, err := sendqueue.Load(queuePath)
			if err != nil {
				t.Fatal(err)
			}
			snapshot := durable.Snapshot(chatID)
			if snapshot.Dispatching != nil || len(snapshot.Items) != 1 || snapshot.Items[0].Text != "second" {
				t.Fatalf("settlement must drain exactly one durable head: %+v", snapshot)
			}
			if req := h.daemon.LastRequest(omorpc.CmdPrompt); req["message"] != "first" {
				t.Fatalf("wrong head dispatched: %v", req)
			}
			if got := h.daemon.RequestCount(omorpc.CmdFollowUp); got != 0 {
				t.Fatalf("durable backlog leaked to engine follow_up: %d", got)
			}
		})
	}
}
