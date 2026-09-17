package wsbridge

import (
	"reflect"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/sendqueue"
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

	t.Run("queued send persists complete image block", func(t *testing.T) {
		h := newInPlaceBridgeHarness(t, "image-queued")
		queue, err := sendqueue.Load(t.TempDir() + "/queue.json")
		if err != nil {
			t.Fatal(err)
		}
		h.bridge.cfg.SendQueue = queue
		_, _, err = queue.Append("image-queued", sendqueue.Item{Text: "queued", Images: []map[string]string{{"type": "image", "data": data, "mimeType": mimeType}}})
		if err != nil {
			t.Fatal(err)
		}
		item := queue.Snapshot("image-queued").Items[0]
		if len(item.Images) != 1 || len(item.Images[0]) != 3 || item.Images[0]["type"] != "image" || item.Images[0]["data"] != data || item.Images[0]["mimeType"] != mimeType {
			t.Fatalf("queued images = %#v", item.Images)
		}
	})
}
