package wsbridge

import (
	"context"
	"reflect"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc/omorpctest"
	"github.com/DevNewbie1826/omo-webchat/internal/session"
)

func TestChatSendImagePayloadIncludesType(t *testing.T) {
	const data, mimeType = "aGVsbG8=", "image/png"

	t.Run("direct prompt reaches engine", func(t *testing.T) {
		h := newInPlaceBridgeHarness(t, "image-direct")
		conn, frames := h.connect(t)
		writeClient(t, conn, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": "image-direct"})
		frames.next(t, "ready")
		writeClient(t, conn, map[string]any{"type": "chat.send", "sessionId": "image-direct", "requestId": "image-direct-request", "run": map[string]any{"kind": "prompt", "message": "look", "images": []any{map[string]any{"data": data, "mimeType": mimeType}}}})
		nextSuccessfulSendAcks(t, frames, "image-direct-request")
		if !h.daemon.AwaitRequestCount(omorpc.CmdPrompt, 1, 5*time.Second) {
			t.Fatal("prompt was not forwarded")
		}
		var got map[string]any
		for _, request := range h.daemon.Requests() {
			if request["type"] == omorpc.CmdPrompt {
				got = request
				break
			}
		}
		if got == nil {
			t.Fatalf("prompt request not found")
		}
		images := got["images"].([]any)
		if len(images) != 1 || !reflect.DeepEqual(images[0], map[string]any{"type": "image", "data": data, "mimeType": mimeType}) {
			t.Fatalf("engine received images = %#v", images)
		}
	})

	t.Run("queued_send_persists_complete_image_block", func(t *testing.T) {
		h := newInPlaceBridgeHarness(t, "image-queued")
		queue := configureSendQueue(t, h)
		conn, frames := h.connect(t)
		writeClient(t, conn, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": "image-queued"})
		frames.next(t, "ready")
		frames.next(t, "queue")
		frames.next(t, "queue") // refreshed from get_state

		h.daemon.SetPromptScript(h.path,
			map[string]any{"type": omorpctest.EventAgentStart},
			map[string]any{"type": omorpctest.EventAgentSettled, "reason": "end_turn"},
		)
		releaseRun := h.daemon.HoldPrompt(h.path)
		defer releaseRun()
		writeClient(t, conn, map[string]any{
			"type": "chat.send", "sessionId": "image-queued", "requestId": "running",
			"run": map[string]any{"kind": "prompt", "message": "running"},
		})
		nextSuccessfulSendAcks(t, frames, "running")

		writeClient(t, conn, map[string]any{
			"type": "chat.send", "sessionId": "image-queued", "requestId": "queued-image",
			"run": map[string]any{"kind": "followUp", "message": "look", "images": []any{map[string]any{"data": "aW1hZ2U=", "mimeType": "image/png"}}},
		})
		nextSuccessfulSendAcks(t, frames, "queued-image")

		releaseFlush := h.daemon.BlockHandler(omorpc.CmdPrompt)
		defer releaseFlush()
		releaseRun()
		frames.next(t, "run.done")
		if !h.daemon.AwaitRequestCount(omorpc.CmdPrompt, 2, 5*time.Second) {
			t.Fatal("settle did not flush the queue head")
		}
		// The request observation precedes its detached persistence callback.
		// Subscribe while the flush is held, then join its completion and queued
		// publications before socket/harness/TempDir cleanup (including Fatal paths).
		sess, ok := h.manager.Get("image-queued")
		if !ok {
			t.Fatal("attached session disappeared")
		}
		completion := &cancelSignalSubscriber{frames: make(chan session.Frame, 64), cancelled: make(chan struct{})}
		detach := sess.Attach(completion)
		t.Cleanup(func() {
			defer detach()
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			releaseFlush()
			pending := map[string]bool{"running": true, "queued-image": true}
			for {
				select {
				case outcome := <-completion.frames:
					if outcome.Kind != session.FrameAck || outcome.Phase != "completed" {
						continue
					}
					delete(pending, outcome.RequestID)
					if len(pending) != 0 {
						continue
					}
					// CompleteDetachedSend publishes the flush ack after enqueueing both
					// the queue publication and idle drain. Join their FIFO position.
					release, err := h.manager.EnterChat(ctx, "image-queued")
					if err != nil {
						t.Fatal(err)
					}
					release()
					if got := queue.Snapshot("image-queued"); got.Dispatching != nil {
						t.Fatal("queue dispatch completion still owns a persistence write at teardown")
					}
					return
				case <-ctx.Done():
					t.Fatal("timed out joining flushed queue head completion")
				}
			}
		})
		request := h.daemon.LastRequest(omorpc.CmdPrompt)
		images, _ := request["images"].([]any)
		if len(images) != 1 || !reflect.DeepEqual(images[0], map[string]any{"type": "image", "data": "aW1hZ2U=", "mimeType": "image/png"}) {
			t.Fatalf("flushed prompt images = %#v", request["images"])
		}
	})
}
