package session

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

type synchronousLedgerRecorder struct {
	*recorder
}

func (*synchronousLedgerRecorder) SynchronousAttach() {}

func TestAttachReplaysFullSendOperationLedger(t *testing.T) {
	s := &Session{durableID: "durable-full-ledger", queueSize: DefaultQueueSize, readyPublished: true}
	for i := 0; i < SendOperationLedgerCapacity; i++ {
		requestID := fmt.Sprintf("request-%02d", i)
		if err, stop := s.beginSendOperation(requestID); err != nil || stop {
			t.Fatalf("begin operation %d = (%v, %v)", i, err, stop)
		}
		s.recordSendOperation(requestID, nil)
		s.completeSendOperation(requestID, nil)
	}

	sub := &synchronousLedgerRecorder{recorder: newRecorder(SendOperationLedgerCapacity + 1)}
	attached := make(chan error, 1)
	go func() {
		_, err := s.attachChecked(sub)
		attached <- err
	}()
	select {
	case err := <-attached:
		if err != nil {
			t.Fatalf("attach full ledger: %v", err)
		}
	case <-time.After(testTimeout):
		t.Fatal("attach blocked while replaying a full operation ledger")
	}
	t.Cleanup(func() { s.broadcast.close(ErrSubscriberSessionEnd) })

	if ready := sub.next(t); ready.Kind != FrameReady {
		t.Fatalf("first replay frame = %+v, want ready", ready)
	}
	for i := 0; i < SendOperationLedgerCapacity; i++ {
		frame := sub.next(t)
		wantID := fmt.Sprintf("request-%02d", i)
		if frame.Kind != FrameAck || frame.RequestID != wantID || frame.Phase != "completed" {
			t.Fatalf("operation replay %d = %+v, want completed ack for %q", i, frame, wantID)
		}
	}
}

func TestFullSendOperationLedgerRejectsWhenEveryEntryIsInFlight(t *testing.T) {
	s := &Session{durableID: "durable-in-flight"}
	for i := 0; i < SendOperationLedgerCapacity; i++ {
		requestID := fmt.Sprintf("request-%02d", i)
		if err, stop := s.beginSendOperation(requestID); err != nil || stop {
			t.Fatalf("begin operation %d = (%v, %v)", i, err, stop)
		}
		s.recordSendOperation(requestID, nil)
	}

	err, stop := s.beginSendOperation("overflow")
	if !stop || !errors.Is(err, ErrSendBackpressure) {
		t.Fatalf("full in-flight ledger admission = (%v, %v), want send backpressure", err, stop)
	}
	if len(s.sendOwner.fifo) != SendOperationLedgerCapacity || len(s.sendOwner.operations) != SendOperationLedgerCapacity {
		t.Fatalf("ledger changed after rejection: fifo=%d map=%d", len(s.sendOwner.fifo), len(s.sendOwner.operations))
	}
	if _, exists := s.sendOwner.operations["request-00"]; !exists {
		t.Fatal("oldest in-flight operation was evicted")
	}
	if _, exists := s.sendOwner.operations["overflow"]; exists {
		t.Fatal("rejected operation was inserted")
	}
}

func TestFullSendOperationLedgerEvictsOldestTerminalEntry(t *testing.T) {
	s := &Session{durableID: "durable-terminal-eviction"}
	for i := 0; i < SendOperationLedgerCapacity; i++ {
		requestID := fmt.Sprintf("request-%02d", i)
		if err, stop := s.beginSendOperation(requestID); err != nil || stop {
			t.Fatalf("begin operation %d = (%v, %v)", i, err, stop)
		}
		s.recordSendOperation(requestID, nil)
	}
	s.completeSendOperation("request-00", nil)

	if err, stop := s.beginSendOperation("replacement"); err != nil || stop {
		t.Fatalf("replacement admission = (%v, %v)", err, stop)
	}
	if _, exists := s.sendOwner.operations["request-00"]; exists {
		t.Fatal("oldest terminal operation was not evicted")
	}
	for i := 1; i < SendOperationLedgerCapacity; i++ {
		requestID := fmt.Sprintf("request-%02d", i)
		operation, exists := s.sendOwner.operations[requestID]
		if !exists || operation.phase != sendOperationAdmitted {
			t.Fatalf("in-flight operation %q was not preserved: %+v, exists=%v", requestID, operation, exists)
		}
	}
	if got := s.sendOwner.fifo[len(s.sendOwner.fifo)-1]; got != "replacement" {
		t.Fatalf("newest ledger entry = %q, want replacement", got)
	}
}

func TestConcurrentCompletionAndAdmissionPublishAndRetainTerminalSnapshots(t *testing.T) {
	s := &Session{durableID: "durable-concurrent", queueSize: 2 * SendOperationLedgerCapacity, readyPublished: true}
	live := &synchronousLedgerRecorder{recorder: newRecorder(SendOperationLedgerCapacity + 1)}
	if _, err := s.attachChecked(live); err != nil {
		t.Fatalf("attach live observer: %v", err)
	}
	defer s.broadcast.close(ErrSubscriberSessionEnd)
	if ready := live.next(t); ready.Kind != FrameReady {
		t.Fatalf("first live frame = %+v, want ready", ready)
	}
	for i := 0; i < SendOperationLedgerCapacity; i++ {
		requestID := fmt.Sprintf("original-%02d", i)
		if err, stop := s.beginSendOperation(requestID); err != nil || stop {
			t.Fatalf("begin operation %d = (%v, %v)", i, err, stop)
		}
		s.recordSendOperation(requestID, nil)
	}

	start := make(chan struct{})
	admitted := make(chan string, SendOperationLedgerCapacity)
	var wg sync.WaitGroup
	for i := 0; i < SendOperationLedgerCapacity; i++ {
		originalID := fmt.Sprintf("original-%02d", i)
		replacementID := fmt.Sprintf("replacement-%02d", i)
		wg.Add(2)
		go func() {
			defer wg.Done()
			<-start
			s.publishDetachedOutcome(nil, "chat.send", originalID)
		}()
		go func() {
			defer wg.Done()
			<-start
			if err, stop := s.beginSendOperation(replacementID); err == nil && !stop {
				admitted <- replacementID
			}
		}()
	}
	close(start)
	wg.Wait()
	close(admitted)

	seen := make(map[string]bool, SendOperationLedgerCapacity)
	for i := 0; i < SendOperationLedgerCapacity; i++ {
		frame := live.next(t)
		if frame.Kind != FrameAck || frame.Phase != "completed" {
			t.Fatalf("completion %d = %+v, want completed ack", i, frame)
		}
		if seen[frame.RequestID] {
			t.Fatalf("duplicate completion for %q", frame.RequestID)
		}
		seen[frame.RequestID] = true
	}

	s.sendOwner.mu.Lock()
	if len(s.sendOwner.fifo) != SendOperationLedgerCapacity || len(s.sendOwner.operations) != SendOperationLedgerCapacity {
		s.sendOwner.mu.Unlock()
		t.Fatalf("concurrent ledger size = fifo %d/map %d, want %d", len(s.sendOwner.fifo), len(s.sendOwner.operations), SendOperationLedgerCapacity)
	}
	var replayWant []Frame
	for _, requestID := range s.sendOwner.fifo {
		operation := s.sendOwner.operations[requestID]
		if operation.phase == sendOperationTerminal {
			if operation.outcome.Kind != FrameAck || operation.outcome.Phase != "completed" {
				s.sendOwner.mu.Unlock()
				t.Fatalf("retained terminal %q = %+v", requestID, operation)
			}
			replayWant = append(replayWant, operation.outcome)
		}
	}
	for replacementID := range admitted {
		if _, ok := s.sendOwner.operations[replacementID]; !ok {
			s.sendOwner.mu.Unlock()
			t.Fatalf("successful concurrent admission %q was lost", replacementID)
		}
	}
	s.sendOwner.mu.Unlock()

	replay := &synchronousLedgerRecorder{recorder: newRecorder(len(replayWant) + 1)}
	if _, err := s.attachChecked(replay); err != nil {
		t.Fatalf("attach replay observer: %v", err)
	}
	if ready := replay.next(t); ready.Kind != FrameReady {
		t.Fatalf("first replay frame = %+v, want ready", ready)
	}
	for i, want := range replayWant {
		if got := replay.next(t); got.Kind != FrameAck || got.RequestID != want.RequestID || got.Phase != "completed" {
			t.Fatalf("replayed terminal %d = %+v, want %+v", i, got, want)
		}
	}
}

func TestUncorrelatedDetachedFailurePublishesExactlyOnce(t *testing.T) {
	s := &Session{durableID: "durable-uncorrelated", queueSize: DefaultQueueSize}
	s.operationOwner()
	sub := &synchronousLedgerRecorder{recorder: newRecorder(2)}
	if _, err := s.attachChecked(sub); err != nil {
		t.Fatal(err)
	}
	defer s.broadcast.close(ErrSubscriberSessionEnd)

	s.publishDetachedOutcome(errors.New("abort failed"), "chat.abort", "")
	if frame := sub.next(t); frame.Kind != FrameError || frame.Command != "chat.abort" || frame.RequestID != "" {
		t.Fatalf("uncorrelated failure = %+v", frame)
	}
	s.lifecycleMu.Lock()
	s.publishLocked(Frame{Kind: FrameName, SessionID: s.durableID})
	s.lifecycleMu.Unlock()
	if frame := sub.next(t); frame.Kind != FrameName {
		t.Fatalf("uncorrelated failure was published more than once: %+v", frame)
	}
}

func TestReplacementSharesSendOwnerAndTerminalPublicationHasOneWinner(t *testing.T) {
	prior := &Session{durableID: "durable-shared", queueSize: DefaultQueueSize, readyPublished: true}
	prior.operationOwner()
	if err, duplicate := prior.beginSendOperation("shared-request"); err != nil || duplicate {
		t.Fatalf("begin operation = (%v, %v)", err, duplicate)
	}
	prior.recordSendOperation("shared-request", nil)

	replacement := &Session{durableID: "durable-shared", queueSize: DefaultQueueSize, readyPublished: true}
	replacement.operationOwner()
	replacement.inheritSendOperations(prior)
	priorSub := &synchronousLedgerRecorder{recorder: newRecorder(3)}
	replacementSub := &synchronousLedgerRecorder{recorder: newRecorder(3)}
	if _, err := prior.attachChecked(priorSub); err != nil {
		t.Fatal(err)
	}
	if _, err := replacement.attachChecked(replacementSub); err != nil {
		t.Fatal(err)
	}
	defer prior.broadcast.close(ErrSubscriberSessionEnd)
	defer replacement.broadcast.close(ErrSubscriberSessionEnd)
	priorSub.next(t)
	replacementSub.next(t)
	priorSub.next(t)       // admitted replay
	replacementSub.next(t) // admitted replay

	start := make(chan struct{})
	var wg sync.WaitGroup
	for _, sess := range []*Session{prior, replacement} {
		wg.Add(1)
		go func(sess *Session) {
			defer wg.Done()
			<-start
			sess.CompleteDetachedSend("shared-request", nil)
		}(sess)
	}
	close(start)
	wg.Wait()
	for name, sub := range map[string]*synchronousLedgerRecorder{"prior": priorSub, "replacement": replacementSub} {
		if frame := sub.next(t); frame.Kind != FrameAck || frame.RequestID != "shared-request" || frame.Phase != "completed" {
			t.Fatalf("%s completion = %+v", name, frame)
		}
	}

	// A late callback from either route observes the terminal state and must not
	// republish it. Per-route sentinels are queued after that publication attempt,
	// proving the asynchronous broadcaster pumps reached the assertion boundary.
	prior.CompleteDetachedSend("shared-request", errors.New("late failure"))
	for _, sess := range []*Session{prior, replacement} {
		sess.lifecycleMu.Lock()
		sess.publishLocked(Frame{Kind: FrameName, SessionID: sess.durableID, Data: map[string]any{"name": "sentinel"}})
		sess.lifecycleMu.Unlock()
	}
	for name, sub := range map[string]*synchronousLedgerRecorder{"prior": priorSub, "replacement": replacementSub} {
		if frame := sub.next(t); frame.Kind != FrameName {
			t.Fatalf("%s received republished terminal before sentinel: %+v", name, frame)
		}
	}
}

func TestDetachedCompletionGuardsEvictionUntilOutcomeAndRearmsIdle(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	mgr := NewManager(Config{Client: client, Store: newMemStore(), QueueSize: 8, IdleAfter: time.Hour})
	t.Cleanup(func() { _ = mgr.CloseAll(context.Background()) })
	s, _, _, err := mgr.Acquire(context.Background(), testChat{id: "completion-eviction-guard", cwd: t.TempDir()}, nil)
	if err != nil {
		t.Fatal(err)
	}

	entered := make(chan struct{})
	release := make(chan struct{})
	var guarded bool
	err = s.callDetachedMutation(context.Background(), omorpc.Abort{SessionID: s.RoutingID()}, func(_ *omorpc.Response, _ omorpc.EpochToken, callErr error) {
		if callErr != nil {
			t.Errorf("detached completion: %v", callErr)
		}
		s.lifecycleMu.Lock()
		s.idleAfter = time.Nanosecond
		s.lifecycleMu.Unlock()
		mgr.evict(s)
		_, guarded = mgr.Get(s.ChatID())
		close(entered)
		<-release
	})
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-entered:
	case <-time.After(testTimeout):
		t.Fatal("detached completion did not run")
	}
	if !guarded || d.RequestCount(omorpc.CmdCloseSession) != 0 {
		t.Fatal("idle eviction crossed detached completion handling")
	}
	close(release)
	if !d.AwaitRequestCount(omorpc.CmdCloseSession, 1, testTimeout) {
		t.Fatal("idle handling was not re-armed after detached completion")
	}
}

func TestNoIDDetachedRunMutationPreservesRecoveryAdmission(t *testing.T) {
	for _, tc := range []struct {
		name    string
		command string
		send    func(context.Context, *Session, func(error)) error
	}{
		{
			name:    "steer",
			command: omorpc.CmdSteer,
			send: func(ctx context.Context, s *Session, complete func(error)) error {
				return s.SendSteerDetachedWithRequestIDAndCompletion(ctx, "recovered steer", "", complete)
			},
		},
		{
			name:    "follow-up",
			command: omorpc.CmdFollowUp,
			send: func(ctx context.Context, s *Session, complete func(error)) error {
				return s.SendFollowUpDetachedWithRequestIDAndCompletion(ctx, "recovered follow-up", nil, "", complete)
			},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := newDaemon(t)
			client := dial(t, d)
			mgr := testManager(t, client, newMemStore(), 64)
			chat := testChat{id: "no-id-recovery-" + tc.name, cwd: t.TempDir()}
			stale, _, detach := acquire(t, mgr, chat, nil)
			defer detach()

			if !stale.PrepareDetachedSendRetry("", true) {
				t.Fatal("no-id detached retry was not prepared")
			}
			replacement := newSession(mgr, chat.id, chat.cwd, omorpc.OpenSessionData{
				SessionID: stale.RoutingID(),
				State: omorpc.SessionState{
					SessionID:   stale.ID(),
					SessionFile: stale.SessionFile(),
				},
			}, true, stale.epoch)
			replacement.inheritSendOperations(stale)
			defer replacement.releaseSendOperations()

			completed := make(chan error, 1)
			if err := tc.send(context.Background(), replacement, func(err error) { completed <- err }); err != nil {
				t.Fatalf("recovered no-id admission: %v", err)
			}
			select {
			case err := <-completed:
				if err != nil {
					t.Fatalf("recovered no-id completion: %v", err)
				}
			case <-time.After(testTimeout):
				t.Fatal("recovered no-id mutation did not complete")
			}
			if got := d.RequestCount(tc.command); got != 1 {
				t.Fatalf("recovered provider requests = %d, want 1", got)
			}
			if err := tc.send(context.Background(), replacement, nil); !errors.Is(err, ErrPromptInFlight) {
				t.Fatalf("consumed retry admission = %v, want ErrPromptInFlight", err)
			}
			if got := d.RequestCount(tc.command); got != 1 {
				t.Fatalf("one-shot admission repeated provider mutation: %d requests", got)
			}
		})
	}
}

func TestReplacementPreservesDetachedBackpressureAccounting(t *testing.T) {
	prior := &Session{durableID: "durable-backpressure"}
	owner := prior.operationOwner()
	owner.mu.Lock()
	owner.detachedMutations = DetachedMutationLimit
	owner.mu.Unlock()
	replacement := &Session{durableID: "durable-backpressure"}
	replacement.operationOwner()
	replacement.inheritSendOperations(prior)

	err := replacement.callDetachedMutation(context.Background(), nil, func(*omorpc.Response, omorpc.EpochToken, error) {})
	if !errors.Is(err, ErrSendBackpressure) {
		t.Fatalf("replacement detached admission = %v, want ErrSendBackpressure", err)
	}
}

func TestRetryAdmissionFailurePublishesStoredTerminalOutcome(t *testing.T) {
	s := &Session{durableID: "durable-retry-failure", queueSize: DefaultQueueSize, readyPublished: true}
	if err, stop := s.beginSendOperation("retry-failure"); err != nil || stop {
		t.Fatalf("begin operation = (%v, %v)", err, stop)
	}
	s.recordSendOperation("retry-failure", nil)
	if !s.PrepareDetachedSendRetry("retry-failure", false) {
		t.Fatal("retry was not claimed")
	}

	live := &synchronousLedgerRecorder{recorder: newRecorder(3)}
	if _, err := s.attachChecked(live); err != nil {
		t.Fatal(err)
	}
	defer s.broadcast.close(ErrSubscriberSessionEnd)
	live.next(t) // ready
	live.next(t) // retained admission

	forced := errors.New("forced retry admission failure")
	s.recordSendOperation("retry-failure", forced)
	operation := s.sendOwner.operations["retry-failure"]
	if operation.phase != sendOperationTerminal || operation.published {
		t.Fatalf("stored retry failure = %+v", operation)
	}
	s.CompleteDetachedSend("retry-failure", forced)
	if outcome := live.next(t); outcome.Kind != FrameError || outcome.RequestID != "retry-failure" || outcome.Command != "chat.send" {
		t.Fatalf("published retry failure = %+v", outcome)
	}
	if operation = s.sendOwner.operations["retry-failure"]; !operation.published {
		t.Fatalf("terminal publication was not recorded: %+v", operation)
	}
}

func TestSuccessfulProviderCompletionMarksSendOperationTerminalForReplay(t *testing.T) {
	s := &Session{durableID: "durable-success", queueSize: 1, readyPublished: true}
	if err, stop := s.beginSendOperation("successful-send"); err != nil || stop {
		t.Fatalf("begin operation = (%v, %v)", err, stop)
	}
	s.recordSendOperation("successful-send", nil)
	if operation := s.sendOwner.operations["successful-send"]; operation.phase != sendOperationAdmitted {
		t.Fatalf("admission phase = %v, want admitted", operation.phase)
	}

	// Detached completion callbacks publish the request-keyed terminal outcome
	// and retain it for reconnect replay.
	s.publishDetachedOutcome(nil, "chat.send", "successful-send")
	operation := s.sendOwner.operations["successful-send"]
	if operation.phase != sendOperationTerminal || operation.outcome.Kind != FrameAck || operation.outcome.Phase != "completed" {
		t.Fatalf("successful completion = %+v, want completed terminal ack", operation)
	}

	sub := &synchronousLedgerRecorder{recorder: newRecorder(2)}
	if _, err := s.attachChecked(sub); err != nil {
		t.Fatalf("attach completed operation: %v", err)
	}
	t.Cleanup(func() { s.broadcast.close(ErrSubscriberSessionEnd) })
	if ready := sub.next(t); ready.Kind != FrameReady {
		t.Fatalf("first replay frame = %+v, want ready", ready)
	}
	if outcome := sub.next(t); outcome.Kind != FrameAck || outcome.RequestID != "successful-send" || outcome.Phase != "completed" {
		t.Fatalf("successful replay outcome = %+v", outcome)
	}
}
func TestFailedNoIDRetryLeavesNoStaleAdmission(t *testing.T) {
	for _, tc := range []struct {
		name    string
		command string
		send    func(context.Context, *Session, func(error)) error
	}{
		{
			name:    "steer",
			command: omorpc.CmdSteer,
			send: func(ctx context.Context, s *Session, complete func(error)) error {
				return s.SendSteerDetachedWithRequestIDAndCompletion(ctx, "unrelated steer", "", complete)
			},
		},
		{
			name:    "follow-up",
			command: omorpc.CmdFollowUp,
			send: func(ctx context.Context, s *Session, complete func(error)) error {
				return s.SendFollowUpDetachedWithRequestIDAndCompletion(ctx, "unrelated follow-up", nil, "", complete)
			},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := newDaemon(t)
			client := dial(t, d)
			mgr := testManager(t, client, newMemStore(), 64)
			chat := testChat{id: "no-id-stale-" + tc.name, cwd: t.TempDir()}
			original, _, detach := acquire(t, mgr, chat, nil)
			defer detach()

			if !original.PrepareDetachedSendRetry("", true) {
				t.Fatal("no-id detached retry was not prepared")
			}
			original.CompleteDetachedSend("", errors.New("resume failed"))

			replacement := newSession(mgr, chat.id, chat.cwd, omorpc.OpenSessionData{
				SessionID: original.RoutingID(),
				State: omorpc.SessionState{
					SessionID:   original.ID(),
					SessionFile: original.SessionFile(),
				},
			}, true, original.epoch)
			replacement.inheritSendOperations(original)
			defer replacement.releaseSendOperations()

			if err := tc.send(context.Background(), replacement, nil); !errors.Is(err, ErrPromptInFlight) {
				t.Fatalf("idle send after failed no-id retry = %v, want ErrPromptInFlight", err)
			}
			if got := d.RequestCount(tc.command); got != 0 {
				t.Fatalf("idle send after failed no-id retry mutated provider: %d requests", got)
			}
		})
	}
}
