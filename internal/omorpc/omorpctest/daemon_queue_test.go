package omorpctest

// Queue-behaviour tests for the shared mock daemon: the mock must model the
// engine's public per-session queue contract (observed engine behavior) so
// downstream integration tests can observe queueing, queue_update events,
// clearing, and one-at-a-time follow-up consumption after a run ends.

import (
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

const queueTestAwait = 2 * time.Second

// queueTest bundles one daemon + one dialed client with one open session.
type queueTest struct {
	t    *testing.T
	d    *Daemon
	c    *omorpc.Client
	path string // durable sessionFile path
	rpc  string // epoch-local routing handle
}

func newQueueTest(t *testing.T) *queueTest {
	t.Helper()
	// Short-lived temp dir: macOS caps unix socket paths at 104 bytes.
	dir, err := os.MkdirTemp("", "omoq-*")
	if err != nil {
		t.Fatalf("temp dir: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	d := New(dir)
	if err := d.Start(); err != nil {
		t.Fatalf("daemon start: %v", err)
	}
	c, err := omorpc.DialWithConfig(context.Background(), d.SocketPath(), omorpc.Config{})
	if err != nil {
		d.Stop()
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() {
		_ = c.Close()
		d.Stop()
	})
	q := &queueTest{t: t, d: d, c: c}
	var opened omorpc.OpenSessionData
	q.callData(omorpc.OpenSession{CWD: dir}, &opened)
	q.path = opened.State.SessionFile
	q.rpc = opened.SessionID
	return q
}

func (q *queueTest) call(cmd omorpc.Command) *omorpc.Response {
	q.t.Helper()
	resp, err := q.c.Call(context.Background(), cmd)
	if err != nil {
		q.t.Fatalf("Call %T: %v", cmd, err)
	}
	if !resp.Success {
		q.t.Fatalf("Call %T: not successful: %v", cmd, resp.Err())
	}
	return resp
}

func (q *queueTest) callData(cmd omorpc.Command, out any) {
	q.t.Helper()
	resp := q.call(cmd)
	if err := json.Unmarshal(resp.Data, out); err != nil {
		q.t.Fatalf("decode %T data: %v", cmd, err)
	}
}

func (q *queueTest) state() omorpc.SessionState {
	q.t.Helper()
	var st omorpc.SessionState
	q.callData(omorpc.GetState{SessionID: q.rpc}, &st)
	return st
}

func (q *queueTest) followUpMessages() []string {
	q.t.Helper()
	var data omorpc.GetFollowUpMessagesData
	q.callData(omorpc.GetFollowUpMessages{SessionID: q.rpc}, &data)
	return data.Messages
}

// nextEvent returns the next inbound event or fails on bounded timeout.
func (q *queueTest) nextEvent() *omorpc.Event {
	q.t.Helper()
	select {
	case ev, ok := <-q.c.Events():
		if !ok {
			q.t.Fatal("event channel closed while waiting for an event")
		}
		return ev
	case <-time.After(queueTestAwait):
		q.t.Fatal("timed out waiting for event")
		return nil
	}
}

// expectEvent consumes events until one of the given type arrives.
func (q *queueTest) expectEvent(typ string) {
	q.t.Helper()
	for {
		ev := q.nextEvent()
		if ev.Type == typ {
			return
		}
	}
}

// expectQueueUpdate consumes events until a queue_update arrives and
// returns its typed payload.
func (q *queueTest) expectQueueUpdate() omorpc.QueueUpdate {
	q.t.Helper()
	for {
		ev := q.nextEvent()
		if ev.Type != omorpc.EventQueueUpdate {
			continue
		}
		if ev.SessionID != q.rpc {
			q.t.Fatalf("queue_update sessionId = %q, want %q", ev.SessionID, q.rpc)
		}
		qu, err := omorpc.ParseQueueUpdate(ev)
		if err != nil {
			q.t.Fatalf("parse queue_update: %v", err)
		}
		return *qu
	}
}

// holdAndStartRun arms a two-event run script (agent_start, agent_end) and
// holds it after the accepted response so the run is observably active.
func (q *queueTest) holdAndStartRun() (release func()) {
	q.t.Helper()
	q.d.SetPromptScript(q.path,
		map[string]any{"type": EventAgentStart},
		map[string]any{"type": EventAgentEnd},
		map[string]any{"type": EventAgentSettled},
	)
	hold := q.d.HoldPrompt(q.path)
	q.call(omorpc.Prompt{SessionID: q.rpc, Message: "run"})
	return hold
}

func (q *queueTest) finishRun(hold func()) {
	q.t.Helper()
	hold()
	q.expectEvent(EventAgentStart)
	q.expectEvent(EventAgentEnd)
	q.expectEvent(EventAgentSettled)
}

// TestDaemonQueueInitialStateAndFollowUp: a fresh session's queue is empty,
// follow_up appends with queue_update each time, and the queue is
// observable via get_state and get_follow_up_messages. Steer without an
// active run does not enqueue.
func TestDaemonQueueInitialStateAndFollowUp(t *testing.T) {
	q := newQueueTest(t)

	st := q.state()
	if len(st.FollowUp) != 0 || len(st.Ordered) != 0 || st.PendingMessageCount != 0 {
		t.Fatalf("initial state queue: followUp=%v ordered=%v pending=%d, want empty",
			st.FollowUp, st.Ordered, st.PendingMessageCount)
	}

	// No active run: steer must not enqueue.
	q.call(omorpc.Steer{SessionID: q.rpc, Message: "early"})
	if st = q.state(); st.PendingMessageCount != 0 {
		t.Fatalf("steer without active run enqueued: %+v", st)
	}

	q.call(omorpc.FollowUp{SessionID: q.rpc, Message: "f1"})
	qu := q.expectQueueUpdate()
	if len(qu.FollowUp) != 1 || qu.FollowUp[0] != "f1" || qu.PendingMessageCount != 1 {
		t.Fatalf("first follow_up queue_update: %+v", qu)
	}
	if len(qu.Ordered) != 1 || qu.Ordered[0] != (omorpc.QueuedMessage{Text: "f1", Mode: "followUp", EnqueueOrder: 1}) {
		t.Fatalf("first follow_up ordered: %+v", qu.Ordered)
	}

	q.call(omorpc.FollowUp{SessionID: q.rpc, Message: "f2"})
	qu = q.expectQueueUpdate()
	if len(qu.FollowUp) != 2 || qu.FollowUp[0] != "f1" || qu.FollowUp[1] != "f2" || qu.PendingMessageCount != 2 {
		t.Fatalf("second follow_up queue_update: %+v", qu)
	}
	wantOrdered := []omorpc.QueuedMessage{
		{Text: "f1", Mode: "followUp", EnqueueOrder: 1},
		{Text: "f2", Mode: "followUp", EnqueueOrder: 2},
	}
	if len(qu.Ordered) != len(wantOrdered) {
		t.Fatalf("second follow_up ordered: %+v", qu.Ordered)
	}
	for i, want := range wantOrdered {
		if qu.Ordered[i] != want {
			t.Fatalf("ordered[%d] = %+v, want %+v", i, qu.Ordered[i], want)
		}
	}

	st = q.state()
	if len(st.FollowUp) != 2 || st.FollowUp[0] != "f1" || st.FollowUp[1] != "f2" {
		t.Fatalf("get_state followUp: %+v", st.FollowUp)
	}
	if len(st.Ordered) != 2 || st.Ordered[0] != wantOrdered[0] || st.Ordered[1] != wantOrdered[1] {
		t.Fatalf("get_state ordered: %+v", st.Ordered)
	}
	if st.PendingMessageCount != 2 {
		t.Fatalf("get_state pendingMessageCount = %d, want 2", st.PendingMessageCount)
	}

	msgs := q.followUpMessages()
	if len(msgs) != 2 || msgs[0] != "f1" || msgs[1] != "f2" {
		t.Fatalf("get_follow_up_messages: %v, want [f1 f2]", msgs)
	}
}

// TestDaemonQueueSteerDuringRunAbortAndClear: steer during an active run
// enqueues with mode "steer"; abort leaves the queue intact; clear_queue
// empties both queues, returns the cleared texts, and emits queue_update.
func TestDaemonQueueSteerDuringRunAbortAndClear(t *testing.T) {
	q := newQueueTest(t)

	hold := q.holdAndStartRun() // run active, scripted events parked behind hold

	q.call(omorpc.Steer{SessionID: q.rpc, Message: "s1"})
	qu := q.expectQueueUpdate()
	if len(qu.FollowUp) != 0 {
		t.Fatalf("steer queue_update followUp: %+v", qu.FollowUp)
	}
	wantOrdered := []omorpc.QueuedMessage{{Text: "s1", Mode: "steer", EnqueueOrder: 1}}
	if len(qu.Ordered) != 1 || qu.Ordered[0] != wantOrdered[0] {
		t.Fatalf("steer queue_update ordered: %+v", qu.Ordered)
	}
	if qu.PendingMessageCount != 1 {
		t.Fatalf("steer queue_update pendingMessageCount = %d, want 1", qu.PendingMessageCount)
	}

	// abort does NOT drop queued messages.
	q.call(omorpc.Abort{SessionID: q.rpc})
	if msgs := q.followUpMessages(); len(msgs) != 0 {
		t.Fatalf("get_follow_up_messages after abort: %v, want empty", msgs)
	}
	st := q.state()
	if st.PendingMessageCount != 1 || len(st.Ordered) != 1 || st.Ordered[0] != wantOrdered[0] {
		t.Fatalf("state after abort must keep the queue intact: %+v", st)
	}

	// clear_queue empties both queues and reports the cleared texts.
	var cleared omorpc.ClearQueueData
	q.callData(omorpc.ClearQueue{SessionID: q.rpc}, &cleared)
	if len(cleared.Steering) != 1 || cleared.Steering[0] != "s1" {
		t.Fatalf("clear_queue steering: %+v", cleared.Steering)
	}
	if len(cleared.FollowUp) != 0 {
		t.Fatalf("clear_queue followUp: %+v", cleared.FollowUp)
	}
	qu = q.expectQueueUpdate()
	if qu.PendingMessageCount != 0 || len(qu.Ordered) != 0 || len(qu.FollowUp) != 0 {
		t.Fatalf("clear_queue queue_update: %+v", qu)
	}

	// The queued message must have been delivered into the run, so ending it
	// must not consume anything further.
	q.finishRun(hold)
	if st = q.state(); st.PendingMessageCount != 0 {
		t.Fatalf("state after run end: pendingMessageCount = %d, want 0", st.PendingMessageCount)
	}
}

// TestDaemonQueueFollowUpConsumedOneAtATime: after a run's agent_end the
// mock consumes exactly ONE head follow-up item as the next run, emitting
// queue_update; the remaining item stays queued.
func TestDaemonQueueOrderedByEnqueueOrderAcrossQueues(t *testing.T) {
	q := newQueueTest(t)
	hold := q.holdAndStartRun()

	q.call(omorpc.FollowUp{SessionID: q.rpc, Message: "f1"})
	q.expectQueueUpdate()
	q.call(omorpc.Steer{SessionID: q.rpc, Message: "s1"})
	q.expectQueueUpdate()
	q.call(omorpc.FollowUp{SessionID: q.rpc, Message: "f2"})
	q.expectQueueUpdate()

	st := q.state()
	want := []omorpc.QueuedMessage{
		{Text: "f1", Mode: "followUp", EnqueueOrder: 1},
		{Text: "s1", Mode: "steer", EnqueueOrder: 2},
		{Text: "f2", Mode: "followUp", EnqueueOrder: 3},
	}
	if len(st.Ordered) != len(want) {
		t.Fatalf("ordered = %+v, want %+v", st.Ordered, want)
	}
	for i := range want {
		if st.Ordered[i] != want[i] {
			t.Fatalf("ordered[%d] = %+v, want %+v", i, st.Ordered[i], want[i])
		}
	}
	hold()
	q.expectEvent(EventAgentStart)
	q.expectEvent(EventAgentEnd)
	q.expectEvent(EventAgentSettled)
}

func TestDaemonQueueNonterminalScriptDoesNotConsumeFollowUp(t *testing.T) {
	q := newQueueTest(t)
	q.call(omorpc.FollowUp{SessionID: q.rpc, Message: "f1"})
	q.expectQueueUpdate()
	q.d.SetPromptScript(q.path, map[string]any{"type": EventMessageDelta, "delta": "partial"})
	q.call(omorpc.Prompt{SessionID: q.rpc, Message: "run"})
	q.expectEvent(EventMessageDelta)

	if msgs := q.followUpMessages(); len(msgs) != 1 || msgs[0] != "f1" {
		t.Fatalf("follow-up after nonterminal script = %v, want [f1]", msgs)
	}
	if st := q.state(); st.PendingMessageCount != 1 {
		t.Fatalf("pending after nonterminal script = %d, want 1", st.PendingMessageCount)
	}
}

func TestDaemonQueueSettlesOnlyAfterAgentSettled(t *testing.T) {
	q := newQueueTest(t)
	q.call(omorpc.FollowUp{SessionID: q.rpc, Message: "f1"})
	q.expectQueueUpdate()
	q.d.SetPromptScript(q.path,
		map[string]any{"type": EventAgentStart},
		map[string]any{"type": EventAgentEnd},
		map[string]any{"type": EventMessageDelta, "delta": "after end"},
		map[string]any{"type": EventAgentSettled},
	)
	q.call(omorpc.Prompt{SessionID: q.rpc, Message: "run"})
	q.expectEvent(EventAgentStart)
	q.expectEvent(EventAgentEnd)
	q.expectEvent(EventMessageDelta)
	// No queue_update may occur before the true terminal marker; expectEvent
	// reads the stream in order, so settlement must be observed next.
	q.expectEvent(EventAgentSettled)

	qu := q.expectQueueUpdate()
	if len(qu.FollowUp) != 0 || qu.PendingMessageCount != 0 {
		t.Fatalf("settlement queue_update = %+v, want empty queue", qu)
	}
	q.expectEvent(EventAgentStart)
	q.expectEvent(EventAgentEnd)
}

func TestDaemonQueueFollowUpConsumedOneAtATime(t *testing.T) {
	q := newQueueTest(t)

	q.call(omorpc.FollowUp{SessionID: q.rpc, Message: "f1"})
	q.expectQueueUpdate()
	q.call(omorpc.FollowUp{SessionID: q.rpc, Message: "f2"})
	q.expectQueueUpdate()

	hold := q.holdAndStartRun()
	q.finishRun(hold) // original run: agent_start, agent_end

	// One head item consumed as the next run: queue_update, agent_start, agent_end.
	qu := q.expectQueueUpdate()
	if len(qu.FollowUp) != 1 || qu.FollowUp[0] != "f2" {
		t.Fatalf("consumption queue_update followUp: %+v, want [f2]", qu.FollowUp)
	}
	wantOrdered := []omorpc.QueuedMessage{{Text: "f2", Mode: "followUp", EnqueueOrder: 2}}
	if len(qu.Ordered) != 1 || qu.Ordered[0] != wantOrdered[0] {
		t.Fatalf("consumption queue_update ordered: %+v, want %+v", qu.Ordered, wantOrdered)
	}
	if qu.PendingMessageCount != 1 {
		t.Fatalf("consumption queue_update pendingMessageCount = %d, want 1", qu.PendingMessageCount)
	}
	q.expectEvent(EventAgentStart) // consumed run starts
	q.expectEvent(EventAgentEnd)   // and ends

	// One-at-a-time: f2 must still be queued after the consumed run ends.
	if msgs := q.followUpMessages(); len(msgs) != 1 || msgs[0] != "f2" {
		t.Fatalf("get_follow_up_messages after consumption: %v, want [f2]", msgs)
	}
	st := q.state()
	if st.PendingMessageCount != 1 || len(st.Ordered) != 1 || st.Ordered[0] != wantOrdered[0] {
		t.Fatalf("state after consumption: %+v", st)
	}
}
