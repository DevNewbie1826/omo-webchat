package wsbridge

import (
	"testing"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/sendqueue"
)

func TestQueueClearEngineFailurePreservesDurableItems(t *testing.T) {
	// Given: attach with an empty durable queue before seeding the item.
	h := newInPlaceBridgeHarness(t, "queue-clear-fail")
	path := t.TempDir() + "/queue-v1.json"
	queue, err := sendqueue.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	h.bridge.cfg.SendQueue = queue
	conn, frames := h.connect(t)
	writeClient(t, conn, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": "queue-clear-fail"})
	frames.next(t, "ready")
	frames.next(t, "queue")
	frames.next(t, "queue") // refreshed from get_state
	// This joins create's synchronous HasBacklog(false) decision: no drain was
	// queued. A ping is not a join for an already-scheduled asynchronous drain.
	writeClient(t, conn, map[string]any{"type": "ping"})
	frames.next(t, "pong")
	id, _, err := queue.Append("queue-clear-fail", sendqueue.Item{Text: "keep-me"})
	if err != nil {
		t.Fatal(err)
	}
	h.daemon.FailNext(omorpc.CmdClearQueue, omorpc.ErrCodeTooManySessions)

	// When: the provider rejects clearing both its queue and the durable queue.
	writeClient(t, conn, map[string]any{
		"type": "chat.queue.clear", "sessionId": "queue-clear-fail",
		"scope": "all", "requestId": "clear-fail",
	})

	// Then: the error stays correlated and the same item survives in both stores.
	failure := frames.next(t, "error")
	if failure["code"] != "provider_error" {
		t.Errorf("clear failure code = %v, want provider_error", failure["code"])
	}
	if failure["command"] != "chat.queue.clear" {
		t.Errorf("clear failure command = %v, want chat.queue.clear", failure["command"])
	}
	if failure["requestId"] != "clear-fail" {
		t.Errorf("clear failure requestId = %v, want clear-fail", failure["requestId"])
	}
	// The error can precede an incorrect store mutation. Join this connection's
	// synchronous clear handler before observing memory or reloading the JSON.
	writeClient(t, conn, map[string]any{"type": "ping"})
	frames.next(t, "pong")
	awaitCommandFence(t, conn, frames)
	if got := queue.Snapshot("queue-clear-fail"); len(got.Items) != 1 || got.Items[0].ID != id || got.Items[0].Text != "keep-me" {
		t.Errorf("memory queue after failed clear = %+v, want item %q with text keep-me", got, id)
	}
	reloaded, err := sendqueue.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := reloaded.Snapshot("queue-clear-fail"); len(got.Items) != 1 || got.Items[0].ID != id || got.Items[0].Text != "keep-me" {
		t.Errorf("disk queue after failed clear = %+v, want item %q with text keep-me", got, id)
	}
	if got := h.daemon.RequestCount(omorpc.CmdClearQueue); got != 1 {
		t.Errorf("clear_queue requests = %d, want 1", got)
	}
}
