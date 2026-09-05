package wsbridge

import (
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc/omorpctest"
	"github.com/DevNewbie1826/omo-webchat/internal/sendqueue"
	"github.com/DevNewbie1826/omo-webchat/internal/session"
)

func configureSendQueue(t *testing.T, h *inPlaceBridgeHarness) *sendqueue.Store {
	t.Helper()
	queue, err := sendqueue.Load(t.TempDir() + "/queue-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	h.bridge.cfg.SendQueue = queue
	return queue
}

func TestSendDuringRunQueuesAndSettleFlushesOneHead(t *testing.T) {
	h := newInPlaceBridgeHarness(t, "webchat-queue")
	queue := configureSendQueue(t, h)
	conn, frames := h.connect(t)
	writeClient(t, conn, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": "webchat-queue"})
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
		"type": "chat.send", "sessionId": "webchat-queue", "requestId": "running",
		"run": map[string]any{"kind": "prompt", "message": "running"},
	})
	nextSuccessfulSendAcks(t, frames, "running")

	for i, send := range []struct{ id, text string }{{"queued-1", "first"}, {"queued-2", "second"}} {
		run := map[string]any{"kind": "followUp", "message": send.text}
		if i == 0 {
			run["images"] = []any{map[string]any{"data": "aW1hZ2U=", "mimeType": "image/png"}}
		}
		writeClient(t, conn, map[string]any{
			"type": "chat.send", "sessionId": "webchat-queue", "requestId": send.id,
			"run": run,
		})
		nextSuccessfulSendAcks(t, frames, send.id)
		frame := frames.next(t, "queue")
		items := frame["items"].([]any)
		if len(items) == 0 || items[len(items)-1].(map[string]any)["text"] != send.text {
			t.Fatalf("queue frame = %v", frame)
		}
		if i == 0 && items[len(items)-1].(map[string]any)["hasImage"] != true {
			t.Fatalf("queued image flag missing: %v", frame)
		}
	}
	if got := h.daemon.RequestCount(omorpc.CmdFollowUp); got != 0 {
		t.Fatalf("engine follow_up requests = %d, want 0", got)
	}
	if got := h.daemon.RequestCount(omorpc.CmdPrompt); got != 1 {
		t.Fatalf("prompt requests before settle = %d, want 1", got)
	}

	releaseFlush := h.daemon.BlockHandler(omorpc.CmdPrompt)
	defer releaseFlush()
	releaseRun()
	frames.next(t, "run.done")
	if !h.daemon.AwaitRequestCount(omorpc.CmdPrompt, 2, 5*time.Second) {
		t.Fatal("settle did not flush the queue head")
	}
	frame := frames.next(t, "queue")
	for len(frame["items"].([]any)) != 1 {
		frame = frames.next(t, "queue")
	}
	items := frame["items"].([]any)
	if items[0].(map[string]any)["text"] != "second" {
		t.Fatalf("queue after one flush = %v", frame)
	}
	if request := h.daemon.LastRequest(omorpc.CmdPrompt); request["message"] != "first" || len(request["images"].([]any)) != 1 {
		t.Fatalf("flushed prompt = %v, want first with its image", request)
	}
	if got := queue.Snapshot("webchat-queue"); len(got.Items) != 1 || got.Items[0].Text != "second" {
		t.Fatalf("persistent queue after flush = %+v", got)
	}
}

func TestQueueCommandsAndEngineMirror(t *testing.T) {
	h := newInPlaceBridgeHarness(t, "queue-commands")
	path := t.TempDir() + "/queue-v1.json"
	queue, err := sendqueue.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	first, _ := queue.Append("queue-commands", sendqueue.Item{Text: "first"})
	second, _ := queue.Append("queue-commands", sendqueue.Item{Text: "second"})
	queue, err = sendqueue.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	h.bridge.cfg.SendQueue = queue
	conn, frames := h.connect(t)
	writeClient(t, conn, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": "queue-commands"})
	frames.next(t, "ready")
	if frame := frames.next(t, "queue"); len(frame["items"].([]any)) != 2 {
		t.Fatalf("persisted queue attach frame = %v", frame)
	}
	frames.next(t, "queue") // refreshed from get_state

	writeClient(t, conn, map[string]any{"type": "chat.queue.move", "sessionId": "queue-commands", "itemId": second, "toIndex": 0, "requestId": "move"})
	if ack := frames.next(t, "ack"); ack["command"] != "chat.queue.move" || ack["requestId"] != "move" {
		t.Fatalf("move ack = %v", ack)
	}
	if items := frames.next(t, "queue")["items"].([]any); items[0].(map[string]any)["id"] != second {
		t.Fatalf("move queue = %v", items)
	}

	writeClient(t, conn, map[string]any{"type": "chat.queue.remove", "sessionId": "queue-commands", "itemId": first, "requestId": "remove"})
	frames.next(t, "ack")
	if items := frames.next(t, "queue")["items"].([]any); len(items) != 1 {
		t.Fatalf("remove queue = %v", items)
	}
	writeClient(t, conn, map[string]any{"type": "chat.queue.remove", "sessionId": "queue-commands", "itemId": first, "requestId": "missing"})
	if failure := frames.next(t, "error"); failure["code"] != "queue_item_not_found" || failure["requestId"] != "missing" {
		t.Fatalf("missing remove = %v", failure)
	}

	h.daemon.EmitSession(h.path, map[string]any{
		"type": omorpc.EventQueueUpdate, "pendingMessageCount": 2,
		"ordered": []any{map[string]any{"text": "steer now", "mode": "steer", "enqueueOrder": 1}, map[string]any{"text": "later", "mode": "followUp", "enqueueOrder": 2}},
	})
	engine := frames.next(t, "queue")["engine"].(map[string]any)
	if engine["pendingMessageCount"] != float64(2) || len(engine["ordered"].([]any)) != 2 {
		t.Fatalf("engine mirror = %v", engine)
	}

	deadline := time.Now().Add(5 * time.Second)
	writeClient(t, conn, map[string]any{"type": "chat.queue.clear", "sessionId": "queue-commands", "scope": "all", "requestId": "clear"})
	if ack := frames.nextWithin(t, "ack", time.Until(deadline)); ack["command"] != "chat.queue.clear" {
		t.Fatalf("clear ack = %v", ack)
	}
	for {
		frame := frames.nextWithin(t, "queue", time.Until(deadline))
		items := frame["items"].([]any)
		engine := frame["engine"].(map[string]any)
		t.Logf("clear queue snapshot revision=%v items=%d pending=%v", frame["revision"], len(items), engine["pendingMessageCount"])
		if len(items) == 0 && engine["pendingMessageCount"] == float64(0) {
			break
		}
	}
	if got := h.daemon.RequestCount(omorpc.CmdClearQueue); got != 1 {
		t.Fatalf("clear_queue requests = %d, want 1", got)
	}
}

func TestSessionSendAckIsNotMappedToSecondClientFrame(t *testing.T) {
	wire, err := mapFrame(session.Frame{Kind: session.FrameAck, Command: "chat.send", RequestID: "one"}, "chat", false)
	if err != nil {
		t.Fatal(err)
	}
	if wire != nil {
		t.Fatalf("completed send ack mapped to client frame: %#v", wire)
	}
}
