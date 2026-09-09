package wsbridge

import (
	"context"
	"testing"

	"github.com/DevNewbie1826/omo-webchat/internal/sendqueue"
)

func TestReviewOmittedActivityCompactionTerminalDrainsQueue(t *testing.T) {
	const chatID = "unknown-compaction"
	h := newInPlaceBridgeHarness(t, chatID)
	queue := configureSendQueue(t, h)
	conn, frames := h.connect(t)
	attachAndAwaitHistory(t, conn, frames, chatID)
	awaitCommandFence(t, conn, frames)
	h.daemon.EmitSession(h.path, map[string]any{"type": "compaction_start", "reason": "threshold", "requestId": "owned-compaction"})
	frames.next(t, "compaction.started")
	if _, _, err := queue.Append(chatID, sendqueue.Item{Text: "after recovered compaction", RequestID: "backlog"}); err != nil {
		t.Fatal(err)
	}
	h.daemon.SetOmitActivityFields(true)
	h.daemon.DropConnections()
	awaitTransportLoss(t, frames)
	awaitRecoveredHistory(t, frames)
	awaitCommandFence(t, conn, frames)
	done := make(chan struct{})
	h.manager.EnqueueChat(chatID, func() { close(done) })
	awaitRecoverySignal(t, done)
	s, ok := h.manager.Get(chatID)
	if !ok {
		t.Fatal("missing recovered session")
	}
	state, err := s.QueryState(context.Background())
	if err != nil || state.IsStreaming != nil || state.IsCompacting != nil {
		t.Fatalf("expected omitted engine activity: %+v, %v", state, err)
	}
	if run := s.RunSnapshot(); run.Streaming || !run.Compacting {
		t.Fatalf("recovered compaction became a prompt run: %+v", run)
	}
	if got := queue.Snapshot(chatID); len(got.Items) != 1 || got.Dispatching != nil {
		t.Fatalf("compaction did not retain backlog: %+v", got)
	}
	h.daemon.EmitSession(h.path, map[string]any{"type": "compaction_done", "requestId": "owned-compaction", "reason": "threshold"})
	frames.next(t, "compaction.done")
	frames.nextMatching(t, "ack", heartbeatTestTimeout, func(f map[string]any) bool {
		return f["requestId"] == "backlog" && f["phase"] == "completed"
	})
	if got := queue.Snapshot(chatID); len(got.Items) != 0 || got.Dispatching != nil {
		t.Fatalf("compaction terminal did not drain backlog: %+v", got)
	}
}
