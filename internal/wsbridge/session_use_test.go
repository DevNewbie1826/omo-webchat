package wsbridge

import "testing"

func TestAutomaticBindingPreservesSessionUse(t *testing.T) {
	for _, mode := range []string{"initial", "reattach", "query_recovery", "send_recovery"} {
		t.Run(mode, func(t *testing.T) {
			// Given: an existing use stamp, independent of file activity.
			const id = "automatic-use"
			const lastUsed = 1700000000123
			h := newInPlaceBridgeHarness(t, id)
			conn, frames := h.connect(t)
			if mode != "initial" {
				attachAndAwaitHistory(t, conn, frames, id)
				writeClient(t, conn, map[string]any{"type": "ping"})
				frames.next(t, "pong")
				clearCollector(frames)
			}
			chat, err := h.store.GetChat(id)
			if err != nil {
				t.Fatal(err)
			}
			chat.LastUsedAt = lastUsed
			if err := h.store.SaveChat(chat); err != nil {
				t.Fatal(err)
			}
			// When: bind/restoration or transparent recovery reaches its exact completion.
			switch mode {
			case "initial":
				attachAndAwaitHistory(t, conn, frames, id)
			case "reattach":
				restored, restoredFrames := h.connect(t)
				attachAndAwaitHistory(t, restored, restoredFrames, id)
				writeClient(t, restored, map[string]any{"type": "ping"})
				restoredFrames.next(t, "pong")
			case "query_recovery":
				h.daemon.EvictSessionSilently(h.path)
				writeClient(t, conn, map[string]any{"type": "chat.commands", "sessionId": id})
				frames.next(t, "commands")
			case "send_recovery":
				h.daemon.EvictSessionSilently(h.path)
				writeClient(t, conn, map[string]any{"type": "chat.send", "sessionId": id, "requestId": "resume-use", "run": map[string]any{"kind": "prompt", "message": "continue"}})
				nextSuccessfulSendAcks(t, frames, "resume-use")
				frames.next(t, "commands")
			default:
				t.Fatalf("unhandled mode %s", mode)
			}
			writeClient(t, conn, map[string]any{"type": "ping"})
			frames.next(t, "pong")
			// Then: activity may change, but use time is not an automatic side effect.
			got, err := h.store.GetChat(id)
			if err != nil {
				t.Fatal(err)
			}
			if got.LastUsedAt != lastUsed {
				t.Errorf("automatic %s changed use from %d to %d", mode, lastUsed, got.LastUsedAt)
			}
		})
	}
}
