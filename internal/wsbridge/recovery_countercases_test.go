package wsbridge

import (
	"context"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc/omorpctest"
)

func awaitRecoverySignal(t *testing.T, signal <-chan struct{}) {
	t.Helper()
	select {
	case <-signal:
	case <-time.After(heartbeatTestTimeout):
		t.Fatal("recovery barrier deadline")
	}
}

func TestRecoverySendTransportLossWithholdsOutcome(t *testing.T) {
	const chatID, requestID = "retry-loss", "retry-written-once"
	h := newInPlaceBridgeHarness(t, chatID)
	conn, frames := h.connect(t)
	attachAndAwaitHistory(t, conn, frames, chatID)
	awaitCommandFence(t, conn, frames)
	before, _ := entryCountForPath(t, h.daemon, h.path)
	// The first send is definitively rejected. Only its recovery retry reaches
	// the post-route/pre-apply barrier, where a transport loss is ambiguous.
	h.daemon.FailNext(omorpc.CmdPrompt, omorpc.ErrCodeUnknownSession)
	entered, release := h.daemon.BlockPromptBeforeApply(h.path)
	defer release()
	request := map[string]any{"type": "chat.send", "sessionId": chatID, "requestId": requestID,
		"run": map[string]any{"kind": "prompt", "message": "recovery retry applied once"}}
	writeClient(t, conn, request)
	awaitRecoverySignal(t, entered)
	awaitRecoveredHistory(t, frames) // first recovery, before the retry loses RPC
	h.daemon.DropConnections()
	awaitTransportLoss(t, frames)
	awaitRecoveredHistory(t, frames)
	awaitCommandFence(t, conn, frames)
	assertNoPhasedOutcome(t, frames, requestID)
	writeClient(t, conn, request)
	nextSuccessfulSendAcks(t, frames, requestID)
	awaitCommandFence(t, conn, frames)
	assertNoPhasedOutcome(t, frames, requestID)
	release()
	if !h.daemon.AwaitSessionEntryCount(h.path, before.EntryCount+1, heartbeatTestTimeout) {
		t.Fatal("recovery retry was not durably applied")
	}
	after, _ := entryCountForPath(t, h.daemon, h.path)
	if after.EntryCount != before.EntryCount+1 || len(after.Prompts) != 1 {
		t.Fatalf("durable application = %+v, before %+v", after, before)
	}
	if got := h.daemon.RequestCountForPath(omorpc.CmdPrompt, h.path); got != 2 {
		t.Fatalf("prompt calls = %d, want rejection + exactly one retry", got)
	}
}

func TestAutomaticRecoveryWithoutBrowserBinding(t *testing.T) {
	const chatID = "unbound-active"
	h := newInPlaceBridgeHarness(t, chatID)
	conn, frames := h.connect(t)
	attachAndAwaitHistory(t, conn, frames, chatID)
	awaitCommandFence(t, conn, frames)
	server := h.soleServerConnection(t)
	_, stale := server.binding()
	h.daemon.SetPromptScript(h.path, map[string]any{"type": omorpctest.EventAgentStart})
	// Synchronous acceptance ensures there is no detached-send owner propping
	// up recovery eligibility: only the accepted run remains active.
	if err := stale.SendPrompt(context.Background(), "active without browser", nil); err != nil {
		t.Fatal(err)
	}
	frames.next(t, "run.started")
	server.unbind()
	before := h.daemon.OpenCount()
	release := h.daemon.BlockHandler(omorpc.CmdOpenSession)
	defer release()
	h.daemon.DropConnections()
	if !h.daemon.AwaitRequestCount(omorpc.CmdOpenSession, before+1, heartbeatTestTimeout) {
		t.Fatal("unbound accepted work was not automatically reopened")
	}
	done := make(chan struct{})
	h.manager.EnqueueChat(chatID, func() { close(done) })
	release()
	awaitRecoverySignal(t, done)
	recovered, ok := h.manager.Get(chatID)
	if !ok || recovered == stale || recovered.Resumable() || recovered.ID() != stale.ID() || recovered.SessionFile() != stale.SessionFile() {
		t.Fatalf("headless recovery = %v, stale %v", recovered, stale)
	}
	attachAndAwaitHistory(t, conn, frames, chatID)
	awaitCommandFence(t, conn, frames)
	if got := h.daemon.OpenCount() - before; got != 1 {
		t.Fatalf("recovery + later attach opens = %d", got)
	}
}

func TestAutomaticRebindingResynchronizesSettledState(t *testing.T) {
	const chatID = "settled-during-loss"
	h := newInPlaceBridgeHarness(t, chatID)
	conn, frames := h.connect(t)
	attachAndAwaitHistory(t, conn, frames, chatID)
	awaitCommandFence(t, conn, frames)
	h.daemon.EmitSession(h.path, map[string]any{"type": omorpctest.EventAgentStart})
	frames.next(t, "run.started")
	clearCollector(frames)
	before := h.daemon.OpenCount()
	release := h.daemon.BlockHandler(omorpc.CmdOpenSession)
	defer release()
	h.daemon.DropConnections()
	awaitTransportLoss(t, frames)
	if !h.daemon.AwaitRequestCount(omorpc.CmdOpenSession, before+1, heartbeatTestTimeout) {
		t.Fatal("missing recovery open")
	}
	// The run settles while its old route is unbound. Its live event cannot
	// initialize the rebound browser; the authoritative query must do that.
	h.daemon.EmitSession(h.path, map[string]any{"type": omorpctest.EventAgentSettled, "reason": "end_turn"})
	release()
	awaitRecoveredHistory(t, frames)
	awaitCommandFence(t, conn, frames)
	state := frames.next(t, "state")
	if state["isStreaming"] != false || state["isCompacting"] != false {
		t.Fatalf("rebound state = %v", state)
	}
	frames.next(t, "models")
	frames.next(t, "commands")
	frames.next(t, "stats")
}
