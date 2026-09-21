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
	select {
	case <-h.soleServerConnectionDone(t):
		t.Fatal("connection closed after pre-activation overflow")
	case <-time.After(5 * time.Second):
	}
	frames.nextWithin(t, "ready", 15*time.Second)
	writeClient(t, conn, map[string]any{"type": "ping"})
	frames.nextWithin(t, "pong", 5*time.Second)
}
