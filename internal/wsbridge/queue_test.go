package wsbridge

import (
	"context"
	"net/http/httptest"
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
	queue := configureSendQueue(t, h)
	conn, frames := h.connect(t)
	writeClient(t, conn, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": "queue-commands"})
	frames.next(t, "ready")
	frames.next(t, "queue")
	frames.next(t, "queue") // refreshed from get_state

	first, _, err := queue.Append("queue-commands", sendqueue.Item{Text: "first"})
	if err != nil {
		t.Fatal(err)
	}
	second, _, err := queue.Append("queue-commands", sendqueue.Item{Text: "second"})
	if err != nil {
		t.Fatal(err)
	}
	h.bridge.publishQueue("queue-commands", nil)
	if frame := frames.next(t, "queue"); len(frame["items"].([]any)) != 2 {
		t.Fatalf("queue frame = %v", frame)
	}

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

func restartInPlaceBridge(t *testing.T, prior *inPlaceBridgeHarness, queue *sendqueue.Store) *inPlaceBridgeHarness {
	t.Helper()
	client, err := omorpc.Dial(t.Context(), prior.daemon.SocketPath())
	if err != nil {
		t.Fatal(err)
	}
	manager := session.NewManager(session.Config{Client: client, Store: (*CursorStore)(prior.store), RetryBackoff: time.Millisecond})
	bridge := New(Config{Manager: manager, Store: prior.store, SendQueue: queue})
	server := httptest.NewServer(bridge)
	h := &inPlaceBridgeHarness{daemon: prior.daemon, store: prior.store, manager: manager, bridge: bridge, server: server, path: prior.path}
	t.Cleanup(func() {
		server.Close()
		_ = manager.CloseAll(context.Background())
		_ = client.Close()
	})
	return h
}

func TestAcceptedDispatchReconcilesAfterProcessRestartWithoutResend(t *testing.T) {
	h := newInPlaceBridgeHarness(t, "dispatch-accepted-crash")
	conn, frames := h.connect(t)
	writeClient(t, conn, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": "dispatch-accepted-crash"})
	frames.next(t, "ready")

	path := t.TempDir() + "/queue-v1.json"
	queue, err := sendqueue.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := queue.Append("dispatch-accepted-crash", sendqueue.Item{Text: "accepted before crash", RequestID: "accepted-request"}); err != nil {
		t.Fatal(err)
	}
	item, ok, err := queue.BeginDispatch("dispatch-accepted-crash")
	if err != nil || !ok {
		t.Fatalf("begin dispatch = (%+v, %v, %v)", item, ok, err)
	}
	if _, err := queue.MarkDispatchAttempted("dispatch-accepted-crash", item.DeliveryID, "root"); err != nil {
		t.Fatal(err)
	}
	queue, err = sendqueue.Load(path)
	if err != nil {
		t.Fatal(err)
	}

	sess, ok := h.manager.Get("dispatch-accepted-crash")
	if !ok {
		t.Fatal("attached session disappeared")
	}
	accepted := make(chan error, 1)
	acceptedCtx, cancelAccepted := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancelAccepted()
	if err := sess.SendPromptDetachedWithRequestIDAndCompletion(acceptedCtx, item.Text, nil, item.RequestID, func(err error) { accepted <- err }); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-accepted:
		if err != nil {
			t.Fatal(err)
		}
	case <-acceptedCtx.Done():
		t.Fatal(acceptedCtx.Err())
	}
	if got := h.daemon.RequestCount(omorpc.CmdPrompt); got != 1 {
		t.Fatalf("accepted prompt requests = %d, want 1", got)
	}

	beforeEntries := h.daemon.RequestCount(omorpc.CmdGetEntries)
	restarted := restartInPlaceBridge(t, h, queue)
	restartConn, restartFrames := restarted.connect(t)
	writeClient(t, restartConn, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": "dispatch-accepted-crash"})
	restartFrames.next(t, "ready")
	for {
		frame := restartFrames.next(t, "queue")
		if frame["revision"].(float64) >= 4 {
			break
		}
	}
	if got := h.daemon.RequestCount(omorpc.CmdPrompt); got != 1 {
		t.Fatalf("accepted dispatch was resent after restart: %d prompt requests", got)
	}
	if got := h.daemon.RequestCount(omorpc.CmdGetEntries); got < beforeEntries+2 {
		t.Fatalf("durable reconciliation requests = %d, want at least %d", got, beforeEntries+2)
	}
	if got := queue.Snapshot("dispatch-accepted-crash"); got.Dispatching != nil || len(got.Items) != 0 {
		t.Fatalf("reconciled dispatch remained queued: %+v", got)
	}
}

func TestClearDuringDispatchPreservesCompletionAndReleasesGuard(t *testing.T) {
	h := newInPlaceBridgeHarness(t, "dispatch-clear")
	queue := configureSendQueue(t, h)
	if _, _, err := queue.Append("dispatch-clear", sendqueue.Item{Text: "in flight", RequestID: "in-flight"}); err != nil {
		t.Fatal(err)
	}
	h.daemon.SetPromptScript(h.path,
		map[string]any{"type": omorpctest.EventAgentStart},
		map[string]any{"type": omorpctest.EventAgentSettled, "reason": "end_turn"},
	)
	release := h.daemon.BlockHandler(omorpc.CmdPrompt)
	defer release()

	conn, frames := h.connect(t)
	writeClient(t, conn, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": "dispatch-clear"})
	frames.next(t, "ready")
	if !h.daemon.AwaitRequestCount(omorpc.CmdPrompt, 1, 5*time.Second) {
		t.Fatal("dispatch did not reach provider transport")
	}
	writeClient(t, conn, map[string]any{"type": "chat.queue.clear", "sessionId": "dispatch-clear", "scope": "webchat", "requestId": "clear"})
	frames.next(t, "ack")
	if got := queue.Snapshot("dispatch-clear"); got.Dispatching == nil || len(got.Items) != 0 {
		t.Fatalf("clear removed in-flight dispatch: %+v", got)
	}

	release()
	frames.next(t, "run.done")
	for {
		frame := frames.next(t, "queue")
		if frame["revision"].(float64) >= 4 {
			break
		}
	}
	if got := queue.Snapshot("dispatch-clear"); got.Dispatching != nil || len(got.Items) != 0 {
		t.Fatalf("completed dispatch did not settle after clear: %+v", got)
	}
	laterID, laterRevision, err := queue.Append("dispatch-clear", sendqueue.Item{Text: "later", RequestID: "later"})
	if err != nil {
		t.Fatal(err)
	}
	if laterID == "" {
		t.Fatal("later dispatch item has no ID")
	}
	h.bridge.SessionRunSettled("dispatch-clear", nil)
	if !h.daemon.AwaitRequestCount(omorpc.CmdPrompt, 2, 5*time.Second) {
		t.Fatal("later dispatch remained blocked by stale process guard")
	}
	// The dispatch observation is published before its completion callback.
	// This item's append, attempt, and completion transitions are consecutive;
	// wait for this item's exact completion revision before asserting quiescence.
	for {
		frame := frames.next(t, "queue")
		if frame["revision"].(float64) == float64(laterRevision+3) {
			break
		}
	}
	if got := queue.Snapshot("dispatch-clear"); got.Dispatching != nil || len(got.Items) != 0 {
		t.Fatalf("later dispatch did not settle: %+v", got)
	}
}

func TestDispatchingHeadReattemptsOnceAfterRestartAndCarriesRequestID(t *testing.T) {
	h := newInPlaceBridgeHarness(t, "dispatch-restart")
	path := t.TempDir() + "/queue-v1.json"
	queue, err := sendqueue.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := queue.Append("dispatch-restart", sendqueue.Item{Text: "queued", RequestID: "browser-request"}); err != nil {
		t.Fatal(err)
	}
	claimed, ok, err := queue.BeginDispatch("dispatch-restart")
	if err != nil || !ok || claimed.DeliveryID == "" {
		t.Fatalf("begin dispatch = (%+v, %v, %v)", claimed, ok, err)
	}
	restarted, err := sendqueue.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	h.bridge.cfg.SendQueue = restarted
	release := h.daemon.BlockHandler(omorpc.CmdPrompt)
	defer release()

	conn, frames := h.connect(t)
	writeClient(t, conn, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": "dispatch-restart"})
	frames.next(t, "ready")
	if !h.daemon.AwaitRequestCount(omorpc.CmdPrompt, 1, 5*time.Second) {
		t.Fatal("restart did not reattempt the dispatching head")
	}
	h.bridge.SessionRunSettled("dispatch-restart", nil)
	releaseChat, err := h.manager.EnterChat(t.Context(), "dispatch-restart")
	if err != nil {
		t.Fatal(err)
	}
	releaseChat()
	if got := h.daemon.RequestCount(omorpc.CmdPrompt); got != 1 {
		t.Fatalf("dispatching head requests = %d, want exactly 1", got)
	}

	release()
	for {
		frame := frames.next(t, "queue")
		if frame["revision"].(float64) >= 4 {
			break
		}
	}
	h.daemon.EmitSession(h.path, map[string]any{"type": omorpctest.EventAgentStart})
	h.daemon.EmitSession(h.path, map[string]any{"type": omorpctest.EventAgentSettled, "reason": "end_turn"})
	frames.next(t, "run.done")
	sess, ok := h.manager.Get("dispatch-restart")
	if !ok {
		t.Fatal("attached session disappeared")
	}
	if err := sess.SendPromptDetachedWithRequestID(t.Context(), "duplicate", nil, "browser-request"); err != nil {
		t.Fatalf("replaying accepted browser request: %v", err)
	}
	if got := h.daemon.RequestCount(omorpc.CmdPrompt); got != 1 {
		t.Fatalf("accepted browser request was sent again: %d prompt requests", got)
	}
	reloaded, err := sendqueue.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if snapshot := reloaded.Snapshot("dispatch-restart"); snapshot.Dispatching != nil || len(snapshot.Items) != 0 {
		t.Fatalf("accepted dispatch remained durable: %+v", snapshot)
	}
}

func TestDisconnectedDispatchRemainsDurableAndPublishesNotice(t *testing.T) {
	h := newInPlaceBridgeHarness(t, "dispatch-uncertain")
	queue := configureSendQueue(t, h)
	if _, _, err := queue.Append("dispatch-uncertain", sendqueue.Item{Text: "possibly accepted", RequestID: "uncertain-request"}); err != nil {
		t.Fatal(err)
	}
	release := h.daemon.BlockHandler(omorpc.CmdPrompt)
	defer release()

	conn, frames := h.connect(t)
	writeClient(t, conn, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": "dispatch-uncertain"})
	frames.next(t, "ready")
	if !h.daemon.AwaitRequestCount(omorpc.CmdPrompt, 1, 5*time.Second) {
		t.Fatal("dispatch did not reach provider transport")
	}
	h.daemon.DropConnections()
	if notice := frames.next(t, "notice"); notice["kind"] != "queue_delivery_uncertain" {
		t.Fatalf("uncertain delivery notice = %v", notice)
	}
	if got := queue.Snapshot("dispatch-uncertain"); got.Dispatching == nil || got.Dispatching.RequestID != "uncertain-request" {
		t.Fatalf("uncertain dispatch was not retained: %+v", got)
	}
}

func TestIdleBacklogOrdersRestoredHeadBeforeNewPrompt(t *testing.T) {
	h := newInPlaceBridgeHarness(t, "idle-backlog")
	queue := configureSendQueue(t, h)
	if _, _, err := queue.Append("idle-backlog", sendqueue.Item{Text: "A", RequestID: "request-a"}); err != nil {
		t.Fatal(err)
	}
	h.daemon.SetPromptScript(h.path,
		map[string]any{"type": omorpctest.EventAgentStart},
		map[string]any{"type": omorpctest.EventAgentSettled, "reason": "end_turn"},
	)
	releaseA := h.daemon.BlockHandler(omorpc.CmdPrompt)

	conn, frames := h.connect(t)
	writeClient(t, conn, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": "idle-backlog"})
	frames.next(t, "ready")
	if !h.daemon.AwaitRequestCount(omorpc.CmdPrompt, 1, 5*time.Second) {
		t.Fatal("idle attach did not drain A")
	}
	writeClient(t, conn, map[string]any{
		"type": "chat.send", "sessionId": "idle-backlog", "requestId": "request-b",
		"run": map[string]any{"kind": "prompt", "message": "B"},
	})
	nextSuccessfulSendAcks(t, frames, "request-b")
	if got := queue.Snapshot("idle-backlog"); len(got.Items) != 1 || got.Items[0].Text != "B" {
		t.Fatalf("new prompt did not park behind dispatching A: %+v", got)
	}

	releaseA()
	if !h.daemon.AwaitRequestCount(omorpc.CmdPrompt, 2, 5*time.Second) {
		t.Fatal("B was not dispatched after A settled")
	}
	var prompts []string
	for _, request := range h.daemon.Requests() {
		if request["type"] == omorpc.CmdPrompt {
			prompts = append(prompts, request["message"].(string))
		}
	}
	if len(prompts) != 2 || prompts[0] != "A" || prompts[1] != "B" {
		t.Fatalf("prompt order = %v, want [A B]", prompts)
	}
	for {
		frame := frames.next(t, "queue")
		if frame["revision"].(float64) >= 8 {
			break
		}
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
