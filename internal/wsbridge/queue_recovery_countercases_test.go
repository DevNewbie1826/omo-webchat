package wsbridge

import (
	"testing"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc/omorpctest"
	"github.com/DevNewbie1826/omo-webchat/internal/sendqueue"
)

func TestAutomaticQueueRecoveryWithholdsBeforeApplication(t *testing.T) {
	const chatID, requestID, text = "queue-held-at-loss", "held-queue-request", "queued application exactly once"
	h := newInPlaceBridgeHarness(t, chatID)
	queue := configureSendQueue(t, h)
	conn, frames := h.connect(t)
	attachAndAwaitHistory(t, conn, frames, chatID)
	awaitCommandFence(t, conn, frames)
	before, _ := entryCountForPath(t, h.daemon, h.path)
	if _, _, err := queue.Append(chatID, sendqueue.Item{Text: text, RequestID: requestID}); err != nil {
		t.Fatal(err)
	}
	entered, release := h.daemon.BlockPromptBeforeApply(h.path)
	defer release()
	sess, _ := h.manager.Get(chatID)
	h.bridge.scheduleIdleDrain(chatID, sess)
	awaitRecoverySignal(t, entered)
	h.daemon.DropConnections()
	awaitTransportLoss(t, frames)
	awaitRecoveredHistory(t, frames)
	// Join recovery initialization, then the drain it enqueued. Unlike a
	// socket pong, this fence owns the same chat FIFO as automatic delivery.
	awaitCommandFence(t, conn, frames)
	done := make(chan struct{})
	h.manager.EnqueueChat(chatID, func() { close(done) })
	awaitRecoverySignal(t, done)
	if got := h.daemon.RequestCountForPath(omorpc.CmdPrompt, h.path); got != 1 {
		t.Fatalf("automatic recovery resent a held prompt: %d sends", got)
	}
	if got := queue.Snapshot(chatID); got.Dispatching == nil || got.Dispatching.DispatchState != sendqueue.DispatchAttempted {
		t.Fatalf("ambiguous delivery not parked: %+v", got)
	}
	// Explicit client replay must deduplicate, not turn the parked attempt
	// into permission to send on the replacement epoch.
	writeClient(t, conn, map[string]any{"type": "chat.send", "sessionId": chatID, "requestId": requestID,
		"run": map[string]any{"kind": "prompt", "message": text}})
	nextSuccessfulSendAcks(t, frames, requestID)
	awaitCommandFence(t, conn, frames)
	assertNoPhasedOutcome(t, frames, requestID)
	release()
	if !h.daemon.AwaitSessionEntryCount(h.path, before.EntryCount+1, heartbeatTestTimeout) {
		t.Fatal("held queue prompt was not durably applied")
	}
	after, _ := entryCountForPath(t, h.daemon, h.path)
	if after.EntryCount != before.EntryCount+1 || len(after.Prompts) != 1 || after.Prompts[0] != text {
		t.Fatalf("durable application = %+v, before %+v", after, before)
	}
	if got := h.daemon.RequestCountForPath(omorpc.CmdPrompt, h.path); got != 1 {
		t.Fatalf("replacement epoch sent another prompt: %d", got)
	}
	// Positive durable evidence may retire the same dispatch and settle its
	// existing request-ID ledger; it still must not resend it.
	h.daemon.EmitSession(h.path, map[string]any{"type": omorpctest.EventAgentStart})
	frames.next(t, "run.started")
	h.daemon.EmitSession(h.path, map[string]any{"type": omorpctest.EventAgentSettled, "reason": "end_turn"})
	frames.next(t, "run.done")
	frames.nextMatching(t, "ack", heartbeatTestTimeout, func(f map[string]any) bool {
		return f["requestId"] == requestID && f["phase"] == "completed"
	})
	if got := queue.Snapshot(chatID); got.Dispatching != nil {
		t.Fatalf("applied dispatch not retired: %+v", got)
	}
}
