package wsbridge

import (
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

func TestRecoveryAttachSurvivesLiveFrameOverflow(t *testing.T) {
	h := newInPlaceBridgeHarnessWithHistory(t, "recovery-overflow", 10)
	conn, frames := h.connect(t)
	defer func() { _ = conn.WriteClose(1000, nil) }()

	release := h.daemon.BlockHandler(omorpc.CmdGetEntries)
	defer release()
	writeClient(t, conn, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": "recovery-overflow", "recovery": true})
	if !h.daemon.AwaitRequestCount(omorpc.CmdGetEntries, 1, 5*time.Second) {
		t.Fatal("recovery attach never reached history validation")
	}

	for i := 0; i < preActivationBufferCapacity+40; i++ {
		h.daemon.EmitSession(h.path, map[string]any{"type": "extension_notify", "seq": i + 1})
	}

	release()
	if !h.daemon.AwaitRequestCount(omorpc.CmdGetEntries, 2, 15*time.Second) {
		t.Fatal("overflowed hydration did not re-enter attach")
	}
	frames.nextWithin(t, "ready", 15*time.Second)
	frames.nextMatching(t, "entries", 15*time.Second, func(frame map[string]any) bool {
		return frame["final"] == true
	})

	h.daemon.EmitSession(h.path, map[string]any{"type": "agent_start"})
	frames.nextWithin(t, "run.started", 5*time.Second)
}

func TestLiveSubscriberOverflowReattachesAndContinuesDelivery(t *testing.T) {
	h := newInPlaceBridgeHarnessWithHistory(t, "live-overflow", 10)
	conn, frames := h.connect(t)
	defer func() { _ = conn.WriteClose(1000, nil) }()
	attachAndAwaitHistory(t, conn, frames, "live-overflow")

	server := h.soleServerConnection(t)
	server.stateMu.Lock()
	overflowed := server.sub
	server.stateMu.Unlock()
	if err := overflowed.CancelDelivery(); err != nil {
		t.Fatal(err)
	}
	overflowed.RecoverSubscriberOverflow()

	frames.nextWithin(t, "ready", 15*time.Second)
	frames.nextMatching(t, "entries", 15*time.Second, func(frame map[string]any) bool {
		return frame["final"] == true
	})
	h.daemon.EmitSession(h.path, map[string]any{"type": "agent_start"})
	frames.nextWithin(t, "run.started", 5*time.Second)
}
