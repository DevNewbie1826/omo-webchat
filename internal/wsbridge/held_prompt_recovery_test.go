package wsbridge

import (
	"context"
	"testing"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

func TestReviewHeldPromptActivityAfterHeadlessRecovery(t *testing.T) {
	for _, requestID := range []string{"held-headless", ""} {
		t.Run("requestID="+requestID, func(t *testing.T) {
			const chatID = "held-headless"
			h := newInPlaceBridgeHarness(t, chatID)
			conn, frames := h.connect(t)
			attachAndAwaitHistory(t, conn, frames, chatID)
			awaitCommandFence(t, conn, frames)
			server := h.soleServerConnection(t)
			_, stale := server.binding()
			before, _ := entryCountForPath(t, h.daemon, h.path)
			entered, release := h.daemon.BlockPromptBeforeApply(h.path)
			defer release()
			writeClient(t, conn, map[string]any{"type": "chat.send", "sessionId": chatID, "requestId": requestID,
				"run": map[string]any{"kind": "prompt", "message": "held before durable application"}})
			awaitRecoverySignal(t, entered)
			awaitCommandFence(t, conn, frames)
			server.unbind()
			// A second loss while the original write is still unresolved proves
			// that idle snapshots did not retire its headless recovery ownership.
			for loss := 1; loss <= 2; loss++ {
				beforeOpen := h.daemon.OpenCount()
				releaseOpen := h.daemon.BlockHandler(omorpc.CmdOpenSession)
				defer releaseOpen()
				h.daemon.DropConnections()
				if !h.daemon.AwaitRequestCount(omorpc.CmdOpenSession, beforeOpen+1, heartbeatTestTimeout) {
					t.Fatalf("loss %d: unresolved headless send was not reopened", loss)
				}
				done := make(chan struct{})
				h.manager.EnqueueChat(chatID, func() { close(done) })
				releaseOpen()
				awaitRecoverySignal(t, done)
				recovered, ok := h.manager.Get(chatID)
				if !ok || recovered == stale || recovered.Resumable() || recovered.ID() != stale.ID() || recovered.SessionFile() != stale.SessionFile() {
					t.Fatalf("loss %d: replacement = %v, stale %v", loss, recovered, stale)
				}
				state, err := recovered.QueryState(context.Background())
				if err != nil || state.IsStreaming == nil || *state.IsStreaming || state.IsCompacting == nil || *state.IsCompacting {
					t.Fatalf("held prompt activity = %+v, %v", state, err)
				}
				stale = recovered
			}
			release()
			if !h.daemon.AwaitSessionEntryCount(h.path, before.EntryCount+1, heartbeatTestTimeout) {
				t.Fatal("original prompt was not applied")
			}
			// The old connection cannot deliver agent_start. Only this successful
			// query can discover the provider activity after the idle snapshots.
			state, err := stale.QueryState(context.Background())
			if err != nil || state.IsStreaming == nil || !*state.IsStreaming {
				t.Fatalf("applied prompt engine state = %+v, %v", state, err)
			}
			if run := stale.RunSnapshot(); !run.Streaming || run.Compacting {
				t.Fatalf("applied prompt lost activity hydration: %+v", run)
			}
			if got := h.daemon.RequestCountForPath(omorpc.CmdPrompt, h.path); got != 1 {
				t.Fatalf("prompt writes = %d, want exactly one", got)
			}
		})
	}
}
