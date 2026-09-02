package session

// Adversarial edge matrix for the internal/session orchestration layer,
// run against the shared mock daemon (internal/omorpc/omorpctest). The
// happy-path contract and integration suites deliberately skip these.
//
// Scenario -> invariant mapping (docs/v2/invariants.md):
//
//	 1. Events for a routing id with no owning session (unknown, closed,
//	    or evicted route) are dropped without panic or cross-talk.
//	    Encodes invariant 13's "provider exit between open and
//	    registration rejects the stale session" for the steady state, and
//	    invariant 11's post-eviction quietness. The v1 drop was logged;
//	    at this layer the drop is silent — no observable log surface.
//	 2. agent_settled with no armed run is ignored (invariant 16: stale
//	    settles never fabricate a run).
//	 3. A compact RPC response arriving after a NEWER compaction was
//	    armed must not clear the newer latch (invariant 16: stale compact
//	    responses never clear a newer compaction; sequence-guarded).
//	 4. Prompt send failure: the latch rolls back only while the prompt
//	    sequence still matches, and the session stays usable or — after a
//	    transport epoch death — resumable (invariants 16 + 12 transport
//	    epoch; never wedged).
//	 5. Two concurrent Acquires for one chat: single-flight, exactly one
//	    open_session, both callers attach to the same Session (invariant
//	    11: acquire reuses/attaches atomically).
//	 6. Subscriber attach during a live run sees the live remainder with
//	    exactly one terminal (invariant 12 per-subscriber delivery). GAP,
//	    see the test comment: no run.started/armed-state replay exists.
//	 7. Slow-subscriber detach isolates backpressure: siblings and the
//	    broadcaster keep flowing; the queue bound detaches exactly the
//	    parked consumer (invariant 12).
//	 8. CloseAll during an in-flight prompt: typed failure to the
//	    CloseAll caller when close cannot complete, maps cleared, and no
//	    goroutine leak (exact NumGoroutine tracking, v1 canon style).
//	 9. Three manager restarts over one daemon: the chat resumes every
//	    time with the identical durable id (invariants 7 + 9 identity
//	    persistence).

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"runtime"
	"sync"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc/omorpctest"
)

// ---- edge-suite helpers (test-local; no fixed sleeps) ----

// awaitTrue polls an externally-driven async state change under a bounded
// deadline. The assertion never depends on the delay — only the bound.
func awaitTrue(t *testing.T, what string, budget time.Duration, f func() bool) {
	t.Helper()
	deadline := time.After(budget)
	for {
		if f() {
			return
		}
		select {
		case <-deadline:
			t.Fatalf("condition never became true: %s", what)
			return
		case <-time.After(2 * time.Millisecond):
		}
	}
}

// injectEvent drives one provider event straight into the session's
// dispatch path (same-package white box, mirroring v1's dispatchEvent
// canon). Used where the timing needed is impossible to script at the
// daemon: a provider event landing while a session-scoped RPC response is
// still parked.
func injectEvent(t *testing.T, s *Session, event map[string]any) {
	t.Helper()
	typ, _ := event["type"].(string)
	if typ == "" {
		t.Fatalf("injectEvent: event needs a type: %+v", event)
	}
	b, err := json.Marshal(event)
	if err != nil {
		t.Fatalf("injectEvent: %v", err)
	}
	s.dispatch(&omorpc.Event{Type: typ, SessionID: s.RoutingID(), Raw: b})
}

// awaitGoroutinesAtMost is the exact goroutine tracking used by v1's
// broadcaster leak canaries: poll NumGoroutine against a baseline captured
// with every persistent goroutine already running, and fail when the count
// does not drain back within the budget.
func awaitGoroutinesAtMost(t *testing.T, baseline, tolerance int, budget time.Duration) {
	t.Helper()
	deadline := time.Now().Add(budget)
	for runtime.NumGoroutine() > baseline+tolerance {
		if time.Now().After(deadline) {
			t.Fatalf("goroutines did not drain: %d > baseline %d +%d",
				runtime.NumGoroutine(), baseline, tolerance)
		}
		time.Sleep(2 * time.Millisecond)
	}
}

// runScript arms and sends one scripted prompt run (start -> settled).
func runScript(t *testing.T, d *omorpctest.Daemon, s *Session, msg string) {
	t.Helper()
	d.SetPromptScript(s.SessionFile(),
		map[string]any{"type": omorpctest.EventAgentStart},
		map[string]any{"type": omorpctest.EventAgentSettled, "reason": "end_turn"},
	)
	if err := s.SendPrompt(context.Background(), msg, nil); err != nil {
		t.Fatalf("SendPrompt(%q): %v", msg, err)
	}
}

// ---- 1. events for a routing id with no owning session ----

func TestEdgeEventForUnownedSessionDroppedQuietly(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	store := newMemStore()
	mgr := testManager(client, store, 64)

	chatA := testChat{id: "chat-a", cwd: t.TempDir()}
	chatB := testChat{id: "chat-b", cwd: t.TempDir()}
	subA, subB := newRecorder(64), newRecorder(64)
	sessA, _, _ := acquire(t, mgr, chatA, subA)
	sessB, _, _ := acquire(t, mgr, chatB, subB)
	if ready := subA.next(t); ready.Kind != FrameReady {
		t.Fatalf("expected ready for A, got %+v", ready)
	}
	if ready := subB.next(t); ready.Kind != FrameReady {
		t.Fatalf("expected ready for B, got %+v", ready)
	}

	// (i) Unknown routing id: nobody owns it, nothing panics, nothing is
	// delivered. The marker event proves the ghost was already processed
	// (the connection is FIFO) and produced no frames.
	d.Emit(map[string]any{"type": "message_delta", "sessionId": "rpc-does-not-exist", "delta": "ghost"})
	d.EmitSession(sessA.SessionFile(), map[string]any{"type": "state"})
	_, f := subA.await(t, FrameState)
	if f.SessionID != sessA.ID() {
		t.Fatalf("marker frame routed wrong: %+v", f)
	}
	for _, f := range subA.drain() {
		if f.Kind == FrameMessageDelta {
			t.Fatalf("ghost event delivered: %+v", f)
		}
	}
	if got := subB.drain(); len(got) != 0 {
		t.Fatalf("cross-talk to sibling: %+v", got)
	}

	// (ii) Routing id of an explicitly stopped session: the route is gone
	// from the manager, so events for it are dropped. Marker on B proves
	// processing; A's subscriber must see nothing.
	if err := mgr.Stop(chatA.id); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	if _, ok := mgr.Get(chatA.id); ok {
		t.Fatalf("stopped chat still routed")
	}
	d.EmitSession(sessA.SessionFile(), map[string]any{"type": "message_delta", "delta": "late"})
	d.EmitSession(sessB.SessionFile(), map[string]any{"type": "state"})
	_, fB := subB.await(t, FrameState)
	if fB.SessionID != sessB.ID() {
		t.Fatalf("marker frame routed wrong: %+v", fB)
	}
	if got := subA.drain(); len(got) != 0 {
		t.Fatalf("late event for stopped session delivered: %+v", got)
	}

	// (iii) Routing id of an unloaded (resumable) session: dispatch drops
	// everything after the single session_unloaded terminal.
	d.UnloadSession(sessB.SessionFile())
	prior, _ := subB.awaitError(t, "session_unloaded")
	for _, f := range prior {
		if f.Kind == FrameError {
			t.Fatalf("session_unloaded not exactly once: %+v", prior)
		}
	}
	awaitTrue(t, "session B resumable", testTimeout, sessB.Resumable)
	d.EmitSession(sessB.SessionFile(), map[string]any{"type": "message_delta", "delta": "post-unload"})
	// Marker: re-acquire A (resume) and mark on its live route.
	subA2 := newRecorder(64)
	sessA2, _, _ := acquire(t, mgr, chatA, subA2)
	ready := subA2.next(t)
	if ready.Kind != FrameReady || !ready.Resumed {
		t.Fatalf("re-acquire must resume A, got %+v", ready)
	}
	d.EmitSession(sessA2.SessionFile(), map[string]any{"type": "state"})
	_, fA2 := subA2.await(t, FrameState)
	if fA2.SessionID != sessA2.ID() {
		t.Fatalf("marker frame routed wrong: %+v", fA2)
	}
	if got := subB.drain(); len(got) != 0 {
		t.Fatalf("post-unload event delivered: %+v", got)
	}
	// Full-trail cross-talk audit: every frame names its own session.
	for _, f := range append(subA.drain(), subA2.drain()...) {
		if f.SessionID != sessA.ID() && f.SessionID != sessA2.ID() {
			t.Fatalf("frame crossed sessions: %+v", f)
		}
	}
	for _, f := range subB.drain() {
		if f.SessionID != sessB.ID() {
			t.Fatalf("frame crossed sessions: %+v", f)
		}
	}
}

// ---- 2. stale agent_settled with no armed run ----

func TestEdgeStaleAgentSettledWithoutArmedRunIgnored(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	store := newMemStore()
	chat := testChat{id: "chat-1", cwd: t.TempDir()}
	mgr := testManager(client, store, 64)

	sub := newRecorder(128)
	sess, _, _ := acquire(t, mgr, chat, sub)
	sub.next(t) // ready

	// Settled before anything was ever armed.
	d.EmitSession(sess.SessionFile(), map[string]any{"type": omorpctest.EventAgentSettled, "reason": "end_turn"})
	d.EmitSession(sess.SessionFile(), map[string]any{"type": "state"})
	sub.await(t, FrameState)
	for _, f := range sub.drain() {
		if f.Kind == FrameRunStarted || f.Kind == FrameRunDone {
			t.Fatalf("stale settle fabricated run frames: %+v", f)
		}
	}

	// The gate is not wedged: a real run arms and settles normally.
	runScript(t, d, sess, "one")
	prior, done := sub.await(t, FrameRunDone)
	if got := counts(append(prior, done)); got[FrameRunStarted] != 1 || got[FrameRunDone] != 1 {
		t.Fatalf("first run frame counts wrong: %+v", got)
	}

	// Duplicate settle after completion: still ignored.
	d.EmitSession(sess.SessionFile(), map[string]any{"type": omorpctest.EventAgentSettled, "reason": "end_turn"})
	d.EmitSession(sess.SessionFile(), map[string]any{"type": "state"})
	sub.await(t, FrameState)
	for _, f := range sub.drain() {
		if f.Kind == FrameRunDone {
			t.Fatalf("duplicate settle emitted a second run.done: %+v", f)
		}
	}

	// And the session keeps working.
	runScript(t, d, sess, "two")
	sub.await(t, FrameRunDone)
}

// ---- 3. stale compact RPC response vs a newer compaction ----

func TestEdgeStaleCompactRPCResponseDoesNotClearNewerLatch(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	store := newMemStore()
	chat := testChat{id: "chat-1", cwd: t.TempDir()}
	mgr := testManager(client, store, 64)

	sub := newRecorder(64)
	sess, _, _ := acquire(t, mgr, chat, sub)
	sub.next(t) // ready

	// Compact A: response parked at the daemon, latch armed.
	releaseCompact := d.BlockHandler(omorpc.CmdCompact)
	defer releaseCompact()
	errA := make(chan error, 1)
	go func() { errA <- sess.Compact(context.Background()) }()
	if !d.AwaitRequestCount(omorpc.CmdCompact, 1, testTimeout) {
		t.Fatalf("daemon never saw compact A")
	}
	_, started := sub.await(t, FrameCompactionStart)
	if started.RequestID == "" {
		t.Fatalf("manual compact must publish its RPC request id: %+v", started)
	}

	// While A's response is parked, the provider starts its own
	// compaction (auto/threshold). It merges with the live one, and its
	// terminal completes it — the latch clears WITHOUT A's response.
	injectEvent(t, sess, map[string]any{"type": "compaction_start", "reason": "threshold", "requestId": "prov-auto"})
	for _, f := range sub.drain() {
		if f.Kind == FrameCompactionStart {
			t.Fatalf("provider compaction_start duplicated the started frame: %+v", f)
		}
	}
	injectEvent(t, sess, map[string]any{"type": "compaction_end", "requestId": "prov-auto"})
	_, provDone := sub.await(t, FrameCompactionDone)
	if provDone.RequestID != "prov-auto" {
		t.Fatalf("provider compaction terminal carried %q, want prov-auto", provDone.RequestID)
	}

	// Compact B arms on a fresh latch (new sequence number) while A's RPC
	// response is STILL parked at the daemon.
	errB := make(chan error, 1)
	go func() { errB <- sess.Compact(context.Background()) }()
	if !d.AwaitRequestCount(omorpc.CmdCompact, 2, testTimeout) {
		t.Fatalf("daemon never saw compact B")
	}
	_, startedB := sub.await(t, FrameCompactionStart)
	if startedB.RequestID == started.RequestID {
		t.Fatalf("compact sequence ids reused: %q", startedB.RequestID)
	}

	// Release: BOTH stale-A and fresh-B responses arrive. Exactly one
	// terminal may result — B's. A's late response must not clear (or
	// re-clear) anything: the sequence guard skips it.
	releaseCompact()
	select {
	case err := <-errB:
		if err != nil {
			t.Fatalf("compact B failed: %v", err)
		}
	case <-time.After(testTimeout):
		t.Fatal("compact B never returned")
	}
	_, doneB := sub.await(t, FrameCompactionDone)
	if doneB.RequestID != startedB.RequestID {
		t.Fatalf("B terminal correlated %q, want %q", doneB.RequestID, startedB.RequestID)
	}
	select {
	case err := <-errA:
		if err != nil {
			t.Fatalf("compact A call errored: %v", err)
		}
	case <-time.After(testTimeout):
		t.Fatal("compact A never returned after release")
	}

	var dones []Frame
	for _, f := range sub.drain() {
		if f.Kind == FrameCompactionDone {
			dones = append(dones, f)
		}
	}
	for _, f := range dones {
		if f.RequestID == started.RequestID {
			t.Fatalf("stale A response produced its own terminal after the newer latch: %+v", dones)
		}
	}

	// Session fully usable after the stale response landed.
	if _, err := sess.QueryState(context.Background()); err != nil {
		t.Fatalf("session unusable after stale compact response: %v", err)
	}
	if err := sess.Compact(context.Background()); err != nil {
		t.Fatalf("compact after stale response must pass: %v", err)
	}
	sub.await(t, FrameCompactionDone)
}

// ---- 4. prompt send failure: latch rollback and the sequence guard ----

func TestEdgePromptSendFailureLatchesAndSequenceGuard(t *testing.T) {
	t.Run("rpc_rejected_rolls_back_and_session_usable", func(t *testing.T) {
		d := newDaemon(t)
		client := dial(t, d)
		store := newMemStore()
		chat := testChat{id: "chat-1", cwd: t.TempDir()}
		mgr := testManager(client, store, 64)
		sub := newRecorder(64)
		sess, _, _ := acquire(t, mgr, chat, sub)
		sub.next(t) // ready

		d.FailNext(omorpc.CmdPrompt, omorpctest.CodeUnknownSession)
		err := sess.SendPrompt(context.Background(), "rejected", nil)
		var stable *omorpc.StableError
		if !errors.As(err, &stable) || stable.Code != omorpctest.CodeUnknownSession {
			t.Fatalf("prompt failure must surface the stable code, got %v", err)
		}
		// Rollback happened: the gate is free again, nothing wedged.
		runScript(t, d, sess, "after failure")
		prior, done := sub.await(t, FrameRunDone)
		if c := counts(append(prior, done)); c[FrameRunStarted] != 1 || c[FrameRunDone] != 1 {
			t.Fatalf("run after failed prompt polluted: %+v", c)
		}
	})

	t.Run("disconnect_midcall_rolls_back_and_resumes", func(t *testing.T) {
		d := newDaemon(t)
		client := dial(t, d)
		store := newMemStore()
		chat := testChat{id: "chat-1", cwd: t.TempDir()}
		mgr := testManager(client, store, 64)
		sub := newRecorder(64)
		sess, _, _ := acquire(t, mgr, chat, sub)
		sub.next(t) // ready
		stored := store.stored(chat.id)

		// Park the daemon handler, then kill the epoch mid-call: the
		// pending prompt fails typed, the manager invalidates, and the
		// session becomes resumable from the durable cursor.
		releasePrompt := d.BlockHandler(omorpc.CmdPrompt)
		defer releasePrompt()
		errCh := make(chan error, 1)
		go func() { errCh <- sess.SendPrompt(context.Background(), "lost", nil) }()
		if !d.AwaitRequestCount(omorpc.CmdPrompt, 1, testTimeout) {
			t.Fatalf("daemon never saw the prompt")
		}
		d.DropConnections()
		select {
		case err := <-errCh:
			if !errors.Is(err, omorpc.ErrDisconnected) {
				t.Fatalf("mid-call disconnect: %v, want ErrDisconnected", err)
			}
		case <-time.After(testTimeout):
			t.Fatal("prompt never failed after epoch death")
		}
		// Unpark the daemon handler: the first prompt is already settled
		// by the disconnect, and the post-resume prompt below must reach
		// the daemon (deferred release alone would deadlock it).
		releasePrompt()
		awaitTrue(t, "session resumable after disconnect", testTimeout, sess.Resumable)
		if got := sub.drain(); counts(got)[FrameRunDone] != 0 {
			t.Fatalf("failed prompt emitted terminal frames: %+v", got)
		}

		// Never wedged: the same manager resumes the chat from the
		// stored identity and the run completes.
		sub2 := newRecorder(64)
		sess2, _, _ := acquire(t, mgr, chat, sub2)
		ready := sub2.next(t)
		if ready.Kind != FrameReady || !ready.Resumed {
			t.Fatalf("expected resumed ready, got %+v", ready)
		}
		if sess2.ID() != stored.DurableSessionID || sess2.SessionFile() != stored.SessionFile {
			t.Fatalf("resume identity drifted: %q/%q vs %q/%q",
				sess2.ID(), sess2.SessionFile(), stored.DurableSessionID, stored.SessionFile)
		}
		runScript(t, d, sess2, "after reconnect")
		sub2.await(t, FrameRunDone)
	})

	t.Run("stale_failure_never_rolls_back_newer_prompt", func(t *testing.T) {
		d := newDaemon(t)
		client := dial(t, d)
		store := newMemStore()
		chat := testChat{id: "chat-1", cwd: t.TempDir()}
		mgr := testManager(client, store, 64)
		sub := newRecorder(128)
		sess, _, _ := acquire(t, mgr, chat, sub)
		sub.next(t) // ready

		// Prompt A parks at the daemon, response never written.
		releasePrompt := d.BlockHandler(omorpc.CmdPrompt)
		errA := make(chan error, 1)
		go func() { errA <- sess.SendPrompt(context.Background(), "A", nil) }()
		if !d.AwaitRequestCount(omorpc.CmdPrompt, 1, testTimeout) {
			t.Fatalf("daemon never saw prompt A")
		}
		aid, _ := d.LastRequest(omorpc.CmdPrompt)["id"].(string)

		// The provider finishes A's run by events: start + settled. A's
		// latch is gone; prompt B may arm while A's RPC is still parked.
		injectEvent(t, sess, map[string]any{"type": omorpctest.EventAgentStart})
		injectEvent(t, sess, map[string]any{"type": omorpctest.EventAgentSettled, "reason": "end_turn"})
		sub.await(t, FrameRunDone)

		errB := make(chan error, 1)
		go func() { errB <- sess.SendPrompt(context.Background(), "B", nil) }()
		if !d.AwaitRequestCount(omorpc.CmdPrompt, 2, testTimeout) {
			t.Fatalf("daemon never saw prompt B")
		}

		// NOW A's outcome arrives — as a FAILURE — while B owns the latch.
		// The sequence guard must skip the rollback: B stays in flight.
		d.WriteRaw(fmt.Appendf(nil,
			`{"id":%q,"type":"response","command":"prompt","success":false,"error":"unknown_session"}`+"\n", aid))
		select {
		case err := <-errA:
			var stable *omorpc.StableError
			if !errors.As(err, &stable) || stable.Code != omorpctest.CodeUnknownSession {
				t.Fatalf("stale A failure not stable-typed: %v", err)
			}
		case <-time.After(testTimeout):
			t.Fatal("stale A failure never delivered")
		}
		// The probe: if A's failure had rolled back B's latch, this would
		// slip through the gate.
		if err := sess.SendPrompt(context.Background(), "probe", nil); !errIs(err, ErrPromptInFlight) {
			t.Fatalf("stale A failure rolled back B's latch: probe = %v, want ErrPromptInFlight", err)
		}

		// B's run settles normally.
		injectEvent(t, sess, map[string]any{"type": omorpctest.EventAgentStart})
		injectEvent(t, sess, map[string]any{"type": omorpctest.EventAgentSettled, "reason": "end_turn"})
		sub.await(t, FrameRunDone)
		releasePrompt()
		select {
		case err := <-errB:
			if err != nil {
				t.Fatalf("prompt B failed: %v", err)
			}
		case <-time.After(testTimeout):
			t.Fatal("prompt B never returned")
		}
		// A's real (late, now-unsolicited) success response is dropped by
		// the dispatch switch; nothing new surfaces.
		d.EmitSession(sess.SessionFile(), map[string]any{"type": "state"})
		sub.await(t, FrameState)
		if got := counts(sub.drain()); got[FrameRunStarted] != 0 || got[FrameRunDone] != 0 {
			t.Fatalf("unexpected run frames after stale delivery: %+v", got)
		}
		// Fully usable.
		runScript(t, d, sess, "C")
		sub.await(t, FrameRunDone)
	})
}

// ---- 5. concurrent Acquire single-flight ----

func TestEdgeConcurrentAcquireSingleFlight(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	store := newMemStore()
	chat := testChat{id: "chat-1", cwd: t.TempDir()}
	mgr := testManager(client, store, 64)

	// Park the daemon's open handler: while the first Acquire is in
	// flight, the second must be waiting on the manager's single-flight
	// lock — provably NOT issuing its own open_session.
	releaseOpen := d.BlockHandler(omorpc.CmdOpenSession)
	defer releaseOpen()

	sub1, sub2 := newRecorder(32), newRecorder(32)
	type acquired struct {
		s       *Session
		started bool
		detach  func()
		err     error
	}
	res1 := make(chan acquired, 1)
	res2 := make(chan acquired, 1)
	go func() {
		s, started, detach, err := mgr.Acquire(context.Background(), chat, sub1)
		res1 <- acquired{s, started, detach, err}
	}()
	go func() {
		s, started, detach, err := mgr.Acquire(context.Background(), chat, sub2)
		res2 <- acquired{s, started, detach, err}
	}()

	if !d.AwaitRequestCount(omorpc.CmdOpenSession, 1, testTimeout) {
		t.Fatalf("first acquire never opened")
	}
	if got := d.RequestCount(omorpc.CmdOpenSession); got != 1 {
		t.Fatalf("concurrent acquire issued %d opens while parked, want exactly 1", got)
	}

	releaseOpen()
	var r1, r2 acquired
	select {
	case r1 = <-res1:
	case <-time.After(testTimeout):
		t.Fatal("acquire 1 never returned")
	}
	select {
	case r2 = <-res2:
	case <-time.After(testTimeout):
		t.Fatal("acquire 2 never returned")
	}
	if r1.err != nil || r2.err != nil {
		t.Fatalf("acquires failed: %v / %v", r1.err, r2.err)
	}
	if r1.s != r2.s {
		t.Fatalf("two concurrent acquires got different sessions: %p != %p", r1.s, r2.s)
	}
	startedCount := 0
	for _, r := range []acquired{r1, r2} {
		if r.started {
			startedCount++
		}
		if r.detach == nil {
			t.Fatalf("acquire must return a detach function")
		}
	}
	if startedCount != 1 {
		t.Fatalf("exactly one acquire may report started, got %d", startedCount)
	}
	if got := d.OpenCount(); got != 1 {
		t.Fatalf("total open_session count = %d, want 1", got)
	}
	// Both subscribers are attached to the SAME session: both observe the
	// ready frame (the second via attach replay).
	if ready := sub1.next(t); ready.Kind != FrameReady {
		t.Fatalf("sub1 ready: %+v", ready)
	}
	if ready := sub2.next(t); ready.Kind != FrameReady {
		t.Fatalf("sub2 ready (attach replay): %+v", ready)
	}
}

// ---- 6. subscriber attach during a live run ----

func TestEdgeMidRunAttachSeesStateWithoutTerminalDuplication(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	store := newMemStore()
	chat := testChat{id: "chat-1", cwd: t.TempDir()}
	mgr := testManager(client, store, 64)

	sub1 := newRecorder(128)
	sess, _, _ := acquire(t, mgr, chat, sub1)
	sub1.next(t) // ready

	// Baseline full-run subscriber, attached before the run exists.
	sub2 := newRecorder(128)
	detach2 := sess.Attach(sub2)
	defer detach2()
	if ready := sub2.next(t); ready.Kind != FrameReady {
		t.Fatalf("attach must replay ready, got %+v", ready)
	}

	// Script ONLY the run start: after it flows the run is live and the
	// stream is quiescent, giving a DETERMINISTIC mid-run attach point
	// (a burst must never be allowed to race the attach).
	d.SetPromptScript(sess.SessionFile(), map[string]any{"type": omorpctest.EventAgentStart})
	if err := sess.SendPrompt(context.Background(), "live", nil); err != nil {
		t.Fatalf("SendPrompt: %v", err)
	}

	prior1, started1 := sub1.await(t, FrameRunStarted)
	// Attach AFTER run.started passed: the latecomer joins a live run.
	sub3 := newRecorder(128)
	detach3 := sess.Attach(sub3)
	defer detach3()
	if ready := sub3.next(t); ready.Kind != FrameReady {
		t.Fatalf("mid-stream attach must replay ready, got %+v", ready)
	}

	// Settle the run: one terminal event, published exactly once to every
	// subscriber present.
	injectEvent(t, sess, map[string]any{"type": omorpctest.EventAgentSettled, "reason": "end_turn"})
	prior2, done2 := sub2.await(t, FrameRunDone)
	prior3, done3 := sub3.await(t, FrameRunDone)
	_, done1 := sub1.await(t, FrameRunDone)

	c1 := counts(append(append(prior1, started1), done1))
	c2 := counts(append(prior2, done2))
	c3 := counts(append(prior3, done3))
	if c1[FrameRunStarted] != 1 || c2[FrameRunStarted] != 1 {
		t.Fatalf("full-run subscribers: started counts %+v / %+v", c1, c2)
	}
	if c2[FrameRunDone] != 1 || c3[FrameRunDone] != 1 {
		t.Fatalf("terminal duplicated: %+v / %+v", c2, c3)
	}
	// GAP (reported, not fixed here): sub3 observes run.done with NO
	// run.started and no armed-state frame — there is no run.started
	// replay or armed-state signal for mid-run attaches at this layer.
	// Terminal dedup itself holds: exactly one run.done per subscriber,
	// and nothing trails it.
	if got := counts(sub3.drain()); got[FrameRunStarted] != 0 || got[FrameRunDone] != 0 {
		t.Fatalf("frames trailed the terminal for the latecomer: %+v", got)
	}
	if _, err := sess.QueryState(context.Background()); err != nil {
		t.Fatalf("session unusable after run: %v", err)
	}
}

// ---- 7. slow subscriber detach: backpressure isolation ----

// parkingSub passes ready frames through, counts and signals the first
// non-ready frame, then parks — a deterministic stand-in for a wedged
// websocket write. (blockingSub in the contract suite parks without an
// entry signal, which makes "has the pump parked yet?" scheduler-dependent.)
type parkingSub struct {
	entered     chan struct{}
	release     chan struct{}
	parkOnce    sync.Once
	releaseOnce sync.Once
	mu          sync.Mutex
	n           int
}

func newParkingSub() *parkingSub {
	return &parkingSub{entered: make(chan struct{}), release: make(chan struct{})}
}

func (p *parkingSub) Deliver(f Frame) {
	if f.Kind == FrameReady {
		return
	}
	p.mu.Lock()
	p.n++
	p.mu.Unlock()
	p.parkOnce.Do(func() { close(p.entered) })
	<-p.release
}

func (p *parkingSub) delivered() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.n
}

func (p *parkingSub) unblock() {
	p.releaseOnce.Do(func() { close(p.release) })
}

func TestEdgeSlowSubscriberDetachBackpressureIsolation(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	store := newMemStore()
	chat := testChat{id: "chat-1", cwd: t.TempDir()}
	const queueSize = 64
	mgr := testManager(client, store, queueSize)

	sess, _, _ := acquire(t, mgr, chat, nil)

	slow := newParkingSub()
	detachSlow := sess.Attach(slow)
	defer slow.unblock()
	defer detachSlow()
	healthy := newRecorder(256)
	detachHealthy := sess.Attach(healthy)
	defer detachHealthy()
	// The attach replays the ready frame first (the session was published
	// ready at acquire).
	if f := healthy.next(t); f.Kind != FrameReady {
		t.Fatalf("expected ready replay on attach, got %+v", f)
	}

	// Drive real frames through the session's broadcast path. Every step
	// is a synchronous handoff: publish one frame, await it on the
	// sibling — so no burst can outrun the healthy pump and the test
	// stays deterministic regardless of scheduler pressure.
	publish := func(f Frame) {
		sess.lifecycleMu.Lock()
		sess.publishLocked(f)
		sess.lifecycleMu.Unlock()
	}
	delta := func(n int) Frame {
		return Frame{Kind: FrameMessageDelta, SessionID: sess.ID(), Data: map[string]any{"n": n}}
	}

	// parkingSub passes ready frames through, counts the first non-ready
	// frame, signals entry, and parks — a deterministic stand-in for a
	// wedged websocket write (blockingSub in the contract suite parks
	// without an entry signal, which is scheduler-sensitive).
	type parkingSub struct {
		entered chan struct{}
		release chan struct{}
		once    sync.Once
		mu      sync.Mutex
		n       int
	}

	// Frame 1 parks the slow consumer's pump; the entry signal makes the
	// park observable instead of scheduler-dependent.
	publish(Frame{Kind: FrameRunStarted, SessionID: sess.ID()})
	select {
	case <-slow.entered:
	case <-time.After(testTimeout):
		t.Fatal("slow consumer never took the first frame")
	}
	if f := healthy.next(t); f.Kind != FrameRunStarted {
		t.Fatalf("sibling lost the first frame: %+v", f)
	}
	// queueSize more frames: the slow queue fills to the bound.
	for i := 0; i < queueSize; i++ {
		publish(delta(i))
		if f := healthy.next(t); f.Kind != FrameMessageDelta {
			t.Fatalf("sibling stalled at frame %d: %+v", i, f)
		}
	}
	if got := slow.delivered(); got != 1 { // exactly the parked run.started
		t.Fatalf("parked slow consumer delivered %d frames, want 1 (pump parked on run.started)", got)
	}
	// One more: the slow subscriber is detached AT the bound; the sibling
	// is untouched and still flowing.
	publish(delta(queueSize))
	if f := healthy.next(t); f.Kind != FrameMessageDelta {
		t.Fatalf("sibling stalled after overflow-detach: %+v", f)
	}
	if got := slow.delivered(); got != 1 {
		t.Fatalf("detached slow consumer kept receiving: %d", got)
	}

	// The broadcaster and its reader are alive: a marker frame flows.
	publish(Frame{Kind: FrameState, SessionID: sess.ID()})
	if f := healthy.next(t); f.Kind != FrameState {
		t.Fatalf("broadcaster wedged after overflow-detach: %+v", f)
	}

	// End-to-end: with the slow consumer still parked, a real scripted
	// run streams, settles, and the session stays usable (small burst,
	// well under the bound, so no scheduling sensitivity).
	runScript(t, d, sess, "after storm")
	runPrior, runDone := healthy.await(t, FrameRunDone)
	if got := counts(append(runPrior, runDone)); got[FrameRunStarted] != 1 || got[FrameRunDone] != 1 {
		t.Fatalf("run frames wrong: %+v", got)
	}
	if _, err := sess.QueryState(context.Background()); err != nil {
		t.Fatalf("session unusable: %v", err)
	}
	// Idempotent detach, and the Events reader is still live afterwards.
	detachSlow()
	detachSlow()
	d.EmitSession(sess.SessionFile(), map[string]any{"type": "state"})
	healthy.await(t, FrameState)
}

// ---- 8. CloseAll during an in-flight prompt ----

func TestEdgeCloseAllDuringInflightPromptTypedFailureNoLeak(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	store := newMemStore()
	chat := testChat{id: "chat-1", cwd: t.TempDir()}
	mgr := testManager(client, store, 64)

	sub := newRecorder(64)
	sess, _, _ := acquire(t, mgr, chat, sub)
	sub.next(t) // ready

	// Baseline: daemon accept loop + read loop, client reader, manager
	// event loop, subscriber pump — all persistent goroutines running.
	baseline := runtime.NumGoroutine()

	releasePrompt := d.BlockHandler(omorpc.CmdPrompt)
	releaseClose := d.BlockHandler(omorpc.CmdCloseSession)

	errPrompt := make(chan error, 1)
	go func() { errPrompt <- sess.SendPrompt(context.Background(), "inflight", nil) }()
	if !d.AwaitRequestCount(omorpc.CmdPrompt, 1, testTimeout) {
		t.Fatalf("daemon never saw the prompt")
	}

	// CloseAll whose close_session can never complete: the caller gets a
	// typed failure (context deadline), the maps are already cleaned, and
	// nothing wedges.
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	errClose := make(chan error, 1)
	go func() { errClose <- mgr.CloseAll(ctx) }()
	if !d.AwaitRequestCount(omorpc.CmdCloseSession, 1, testTimeout) {
		t.Fatalf("daemon never saw close_session")
	}
	select {
	case err := <-errClose:
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("CloseAll must surface the typed deadline failure, got %v", err)
		}
	case <-time.After(testTimeout):
		t.Fatal("CloseAll never returned")
	}
	if _, ok := mgr.Get(chat.id); ok {
		t.Fatalf("chat still routed after CloseAll")
	}
	if got := mgr.LiveSummaries(); len(got) != 0 {
		t.Fatalf("closed session still summarized: %+v", got)
	}

	// Unwind: close completes (its late success response is unsolicited
	// and dropped), the parked prompt settles, everything drains.
	releaseClose()
	releasePrompt()
	select {
	case <-errPrompt:
	case <-time.After(testTimeout):
		t.Fatal("in-flight prompt never settled after CloseAll unwind")
	}

	// Exact goroutine tracking: every goroutine this scenario created
	// (prompt caller, CloseAll caller, daemon request handlers) drains.
	awaitGoroutinesAtMost(t, baseline, 2, 3*time.Second)

	// The daemon saw exactly one prompt and one close_session.
	if got := d.RequestCount(omorpc.CmdPrompt); got != 1 {
		t.Fatalf("prompt requests = %d, want 1", got)
	}
	if got := d.RequestCount(omorpc.CmdCloseSession); got != 1 {
		t.Fatalf("close_session requests = %d, want 1", got)
	}
}

// ---- 9. three manager restarts over one daemon ----

func TestEdgeThreeManagerRestartsResumeSameDurableID(t *testing.T) {
	d := newDaemon(t)
	store := newMemStore()
	chat := testChat{id: "chat-1", cwd: t.TempDir()}

	client := dial(t, d)
	mgr := testManager(client, store, 64)
	sub := newRecorder(128)
	sess, _, _ := acquire(t, mgr, chat, sub)
	ready := sub.next(t)
	if ready.Kind != FrameReady || ready.Resumed {
		t.Fatalf("first acquire must be a fresh open, got %+v", ready)
	}
	firstID := sess.ID()
	firstFile := sess.SessionFile()
	if firstID == "" || firstFile == "" {
		t.Fatalf("fresh session must carry durable identity")
	}
	if stored := store.stored(chat.id); stored.SessionFile != firstFile || stored.DurableSessionID != firstID {
		t.Fatalf("cursor not persisted on fresh open: %+v", stored)
	}

	for cycle := 1; cycle <= 3; cycle++ {
		// Manager restart over one daemon: new client + new manager, same
		// socket, same durable registry, same cursor store.
		_ = client.Close()
		d.Restart()
		client = dial(t, d)
		mgr = testManager(client, store, 64)

		sub := newRecorder(128)
		sess, started, _ := acquire(t, mgr, chat, sub)
		if !started {
			t.Fatalf("cycle %d: restart acquire must start a provider session", cycle)
		}
		ready := sub.next(t)
		if ready.Kind != FrameReady || !ready.Resumed {
			t.Fatalf("cycle %d: expected resumed ready, got %+v", cycle, ready)
		}
		if sess.ID() != firstID {
			t.Fatalf("cycle %d: durable id drifted: %q, want %q", cycle, sess.ID(), firstID)
		}
		if sess.SessionFile() != firstFile {
			t.Fatalf("cycle %d: sessionFile drifted: %q, want %q", cycle, sess.SessionFile(), firstFile)
		}
		if got := d.OpenCount(); got != cycle+1 {
			t.Fatalf("cycle %d: open_session count = %d, want %d (one per acquire)", cycle, got, cycle+1)
		}
		// History flows after every resume.
		_, entries := sub.await(t, FrameEntries)
		data, _ := entries.Data.(EntriesFrame)
		if !data.Final || len(data.Entries) == 0 {
			t.Fatalf("cycle %d: resumed history broken: %+v", cycle, data)
		}
		// And the session is usable each time.
		runScript(t, d, sess, fmt.Sprintf("cycle-%d", cycle))
		sub.await(t, FrameRunDone)
	}
}
