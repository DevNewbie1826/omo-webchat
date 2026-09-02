package session

// Contract RED suite: client-owned latch and delivery discipline
// (invariants 12, 16), transport-independent, exercised through the mock
// daemon's scripting.

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc/omorpctest"
)

func errIs(err, target error) bool { return errors.Is(err, target) }

// Gates: a prompt during an active run is rejected with ErrPromptInFlight,
// compaction during an active run with ErrCompactionInFlight, and both
// latches clear when the run settles on agent_settled.
func TestContractGatesRejectDuringActiveRun(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	store := newMemStore()
	chat := testChat{id: "chat-1", cwd: t.TempDir()}
	mgr := testManager(client, store, 64)

	sub := newRecorder(128)
	sess, _, _ := acquire(t, mgr, chat, sub)
	sub.next(t) // ready

	// Hold the run open: the prompt is accepted but its event stream is
	// parked until release. HoldPrompt only gates an existing script.
	d.SetPromptScript(sess.SessionFile(), map[string]any{"type": omorpctest.EventAgentStart}, map[string]any{"type": omorpctest.EventAgentSettled})
	release := d.HoldPrompt(sess.SessionFile())
	defer release()

	if err := sess.SendPrompt(context.Background(), "go", nil); err != nil {
		t.Fatalf("first prompt must start the run: %v", err)
	}
	if err := sess.SendPrompt(context.Background(), "while running", nil); !errIs(err, ErrPromptInFlight) {
		t.Fatalf("prompt during run must fail ErrPromptInFlight, got %v", err)
	}
	if err := sess.Compact(context.Background()); !errIs(err, ErrCompactionInFlight) {
		t.Fatalf("compact during run must fail ErrCompactionInFlight, got %v", err)
	}

	release()
	sub.await(t, FrameRunDone)

	// Both gates clear once the run settles.
	d.SetPromptScript(sess.SessionFile(), map[string]any{"type": omorpctest.EventAgentStart}, map[string]any{"type": omorpctest.EventAgentSettled})
	if err := sess.SendPrompt(context.Background(), "after settle", nil); err != nil {
		t.Fatalf("prompt after settle must pass the gate: %v", err)
	}
	sub.await(t, FrameRunDone)
	if err := sess.Compact(context.Background()); err != nil {
		t.Fatalf("compact after settle must pass the gate: %v", err)
	}
	sub.await(t, FrameCompactionDone)
}

// Abort is fire-and-forget: it never waits for the provider's answer.
func TestContractAbortIsFireAndForget(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	store := newMemStore()
	chat := testChat{id: "chat-1", cwd: t.TempDir()}
	mgr := testManager(client, store, 64)

	sub := newRecorder(64)
	sess, _, _ := acquire(t, mgr, chat, sub)
	sub.next(t) // ready

	// Park the abort handler: Abort must return promptly and concurrent calls
	// collapse into the one in-flight provider request.
	release := d.BlockHandler(omorpc.CmdAbort)
	defer release()

	done := make(chan struct{}, 2)
	go func() { _ = sess.Abort(context.Background()); done <- struct{}{} }()
	go func() { _ = sess.Abort(context.Background()); done <- struct{}{} }()

	select {
	case <-done:
	case <-time.After(100 * time.Millisecond):
		t.Fatalf("Abort blocked on the provider response; must be fire-and-forget")
	}
	if !d.AwaitRequestCount(omorpc.CmdAbort, 1, testTimeout) {
		t.Fatalf("daemon must have received the abort")
	}
	if got := d.RequestCount(omorpc.CmdAbort); got != 1 {
		t.Fatalf("concurrent aborts issued %d provider requests, want 1", got)
	}
}

// Terminal discipline (invariant 16): a run completes ONLY on
// agent_settled -- agent_end{willRetry:false} never completes it -- and a
// duplicate agent_start arms exactly one run.
func TestContractRunTerminalDiscipline(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	store := newMemStore()
	chat := testChat{id: "chat-1", cwd: t.TempDir()}
	mgr := testManager(client, store, 64)

	sub := newRecorder(128)
	sess, _, _ := acquire(t, mgr, chat, sub)
	sub.next(t) // ready

	// agent_end arrives BEFORE more streaming and the settle: run.done must
	// not appear between them.
	d.SetPromptScript(sess.SessionFile(),
		map[string]any{"type": omorpctest.EventAgentStart},
		map[string]any{"type": omorpctest.EventAgentEnd, "willRetry": false},
		map[string]any{"type": omorpctest.EventMessageDelta, "delta": "still streaming"},
		map[string]any{"type": omorpctest.EventAgentSettled, "reason": "end_turn"},
	)
	if err := sess.SendPrompt(context.Background(), "one", nil); err != nil {
		t.Fatalf("SendPrompt: %v", err)
	}
	var frames []Frame
	deadline := time.After(testTimeout)
	for counts(frames)[FrameRunDone] == 0 {
		select {
		case f := <-sub.ch:
			frames = append(frames, f)
		case <-deadline:
			t.Fatalf("run never settled: %+v", frames)
		}
	}
	if idx := frameIndex(frames, FrameRunDone); idx < frameIndex(frames, FrameMessageDelta) {
		t.Fatalf("run.done completed the run before agent_settled (agent_end is not terminal): %+v", frames)
	}
	if c := counts(frames); c[FrameRunStarted] != 1 {
		t.Fatalf("first prompt armed %d runs, want 1: %+v", c[FrameRunStarted], frames)
	}

	// Duplicate agent_start arms exactly one run.
	d.SetPromptScript(sess.SessionFile(),
		map[string]any{"type": omorpctest.EventAgentStart},
		map[string]any{"type": omorpctest.EventAgentStart},
		map[string]any{"type": omorpctest.EventAgentSettled, "reason": "end_turn"},
	)
	if err := sess.SendPrompt(context.Background(), "two", nil); err != nil {
		t.Fatalf("second prompt: %v", err)
	}
	prior, done := sub.await(t, FrameRunDone)
	if c := counts(append(append(frames, prior...), done)); c[FrameRunStarted] != 2 {
		t.Fatalf("duplicate agent_start armed %d runs total, want 2", c[FrameRunStarted])
	}
}

// Blocking subscriber implementation: Deliver parks until released, so the
// manager's per-subscriber queue is the only thing draining frames.
type blockingSub struct {
	mu         sync.Mutex
	release    chan struct{}
	released   bool
	deliveries int
	once       sync.Once
}

func newBlockingSub() *blockingSub {
	return &blockingSub{release: make(chan struct{})}
}

func (b *blockingSub) Deliver(f Frame) {
	b.mu.Lock()
	b.deliveries++
	released := b.released
	b.mu.Unlock()
	if f.Kind == FrameReady {
		return // never block on ready; keep setup deterministic
	}
	if !released {
		<-b.release
	}
}

func (b *blockingSub) delivered() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.deliveries
}

func (b *blockingSub) unblock() {
	b.once.Do(func() {
		b.mu.Lock()
		b.released = true
		b.mu.Unlock()
		close(b.release)
	})
}

func (b *blockingSub) Close() error { b.unblock(); return nil }

// Overflow-detach: a subscriber whose Deliver never drains receives at most
// the queue bound, while the session keeps streaming and settles normally
// (invariant 12: detach the slow consumer, never kill the session).
func TestContractSlowSubscriberDetachedSessionSurvives(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	store := newMemStore()
	chat := testChat{id: "chat-1", cwd: t.TempDir()}
	const queueSize = 8
	mgr := testManager(client, store, queueSize)

	sess, _, _ := acquire(t, mgr, chat, nil)

	slow := newBlockingSub()
	detach := sess.Attach(slow)
	if detach == nil {
		t.Fatalf("Attach must return a detach function")
	}

	// Storm: several prompts, each scripted with a SHORT burst (4 frames
	// < the queue bound, so the healthy sibling below can never overflow
	// — a single 34-frame burst outran the sibling's 8-frame queue before
	// its pump was scheduled and detached it spuriously). The PARKED slow
	// consumer still accumulates the bursts in its queue and detaches at
	// the bound mid-storm, which is the behavior under test.
	runScript := []map[string]any{
		{"type": omorpctest.EventAgentStart},
		{"type": omorpctest.EventMessageDelta, "delta": "x"},
		{"type": omorpctest.EventMessageDelta, "delta": "x"},
		{"type": omorpctest.EventAgentSettled, "reason": "end_turn"},
	}

	// Subscribe before triggering anything; whether SendPrompt returns
	// before or after the daemon's immediate event script is intentionally
	// unspecified by the transport.
	healthy := newRecorder(64)
	sess.Attach(healthy)
	for i := 0; i < queueSize; i++ {
		d.SetPromptScript(sess.SessionFile(), runScript...)
		if err := sess.SendPrompt(context.Background(), "flood", nil); err != nil {
			t.Fatalf("SendPrompt %d: %v", i, err)
		}
		healthy.await(t, FrameRunDone)
	}

	// The slow consumer was detached at the bound: it can never have been
	// handed more frames than the queue holds, and it did detach (its pump
	// parked on the first frame while 8 queue slots + the storm filled up).
	if got := slow.delivered(); got > queueSize {
		t.Fatalf("slow subscriber received %d frames, queue bound is %d (not detached)", got, queueSize)
	}

	// Detach is idempotent and the session still works afterwards.
	detach()
	detach()
	if _, err := sess.QueryState(context.Background()); err != nil {
		t.Fatalf("session must survive the overflow-detach: %v", err)
	}
}
