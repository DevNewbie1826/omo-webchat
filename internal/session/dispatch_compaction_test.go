package session

import (
	"context"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc/omorpctest"
)

func TestDispatchEmptyCompactionEndClearsAutomaticLatch(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	mgr := testManager(t, client, newMemStore(), 64)
	sub := newRecorder(32)
	s, _, _ := acquire(t, mgr, testChat{id: "empty-end", cwd: t.TempDir()}, sub)
	sub.next(t)

	injectEvent(t, s, map[string]any{"type": "compaction_start", "reason": "threshold", "requestId": "X"})
	sub.await(t, FrameCompactionStart)
	injectEvent(t, s, map[string]any{"type": "compaction_end"})
	sub.await(t, FrameCompactionDone)
	if s.RunSnapshot().Compacting {
		t.Fatal("empty compaction_end left the automatic latch set")
	}

	d.SetPromptScript(s.SessionFile(),
		map[string]any{"type": omorpctest.EventAgentStart},
		map[string]any{"type": omorpctest.EventAgentSettled, "reason": "end_turn"},
	)
	if err := s.SendPrompt(context.Background(), "after empty end", nil); err != nil {
		t.Fatalf("prompt after empty compaction_end: %v", err)
	}
}

func TestDispatchRunSettleClearsStaleAutomaticCompactionLatch(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	mgr := testManager(t, client, newMemStore(), 64)
	sub := newRecorder(32)
	s, _, _ := acquire(t, mgr, testChat{id: "settle-compact", cwd: t.TempDir()}, sub)
	sub.next(t)

	injectEvent(t, s, map[string]any{"type": "agent_start"})
	sub.await(t, FrameRunStarted)
	injectEvent(t, s, map[string]any{"type": "compaction_start", "reason": "threshold", "requestId": "auto-gen"})
	sub.await(t, FrameCompactionStart)
	injectEvent(t, s, map[string]any{"type": "agent_settled", "reason": "end_turn"})
	sub.await(t, FrameRunDone)
	if s.RunSnapshot().Compacting {
		t.Fatal("settled run left automatic compaction latch set")
	}

	d.SetPromptScript(s.SessionFile(),
		map[string]any{"type": omorpctest.EventAgentStart},
		map[string]any{"type": omorpctest.EventAgentSettled, "reason": "end_turn"},
	)
	if err := s.SendPrompt(context.Background(), "after stale compact settle", nil); err != nil {
		t.Fatalf("prompt after settled compaction latch: %v", err)
	}
}

func TestDispatchDelayedEmptyEndDoesNotFinishManualSuccessor(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	mgr := testManager(t, client, newMemStore(), 64)
	sub := newRecorder(64)
	s, _, _ := acquire(t, mgr, testChat{id: "blocked-response-successor", cwd: t.TempDir()}, sub)
	sub.next(t)

	release := d.BlockHandler(omorpc.CmdCompact)
	defer release()
	aResult := make(chan error, 1)
	go func() { aResult <- s.Compact(context.Background()) }()
	if !d.AwaitRequestCount(omorpc.CmdCompact, 1, testTimeout) {
		t.Fatal("manual compact A did not reach the provider")
	}
	_, startedA := sub.await(t, FrameCompactionStart)

	injectEvent(t, s, map[string]any{"type": "compaction_start", "reason": "manual", "requestId": "provider-a"})
	injectEvent(t, s, map[string]any{"type": "compaction_end", "requestId": "provider-a"})
	_, doneA := sub.await(t, FrameCompactionDone)
	if doneA.RequestID != "provider-a" {
		t.Fatalf("manual compact A terminal = %q, want provider-a", doneA.RequestID)
	}

	bResult := make(chan error, 1)
	go func() { bResult <- s.Compact(context.Background()) }()
	if !d.AwaitRequestCount(omorpc.CmdCompact, 2, testTimeout) {
		t.Fatal("manual compact B did not reach the provider")
	}
	_, startedB := sub.await(t, FrameCompactionStart)
	if startedB.RequestID == startedA.RequestID {
		t.Fatalf("manual successor reused request id %q", startedB.RequestID)
	}

	injectEvent(t, s, map[string]any{"type": "compaction_end"})
	if !s.RunSnapshot().Compacting {
		t.Fatal("delayed empty end finished manual compact B")
	}
	if got := counts(publishCompactionMarker(t, s, sub))[FrameCompactionDone]; got != 0 {
		t.Fatalf("delayed empty end emitted %d terminal frames for manual compact B", got)
	}

	release()
	awaitCompactionCall(t, aResult)
	awaitCompactionCall(t, bResult)
	_, doneB := sub.await(t, FrameCompactionDone)
	if doneB.RequestID != startedB.RequestID {
		t.Fatalf("manual compact B terminal = %q, want %q", doneB.RequestID, startedB.RequestID)
	}
	if got := counts(publishCompactionMarker(t, s, sub))[FrameCompactionDone]; got != 0 {
		t.Fatalf("manual compact responses emitted %d extra terminal frames", got)
	}
}

func TestDispatchRunSettleDoesNotFinishManualCompaction(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	mgr := testManager(t, client, newMemStore(), 64)
	sub := newRecorder(64)
	s, _, _ := acquire(t, mgr, testChat{id: "manual-wake-run", cwd: t.TempDir()}, sub)
	sub.next(t)

	release := d.BlockHandler(omorpc.CmdCompact)
	defer release()
	result := make(chan error, 1)
	go func() { result <- s.Compact(context.Background()) }()
	if !d.AwaitRequestCount(omorpc.CmdCompact, 1, testTimeout) {
		t.Fatal("manual compact did not reach the provider")
	}
	_, started := sub.await(t, FrameCompactionStart)

	injectEvent(t, s, map[string]any{"type": "agent_start"})
	sub.await(t, FrameRunStarted)
	injectEvent(t, s, map[string]any{"type": "agent_settled", "reason": "end_turn"})
	prior, _ := sub.await(t, FrameRunDone)
	if !s.RunSnapshot().Compacting {
		t.Fatal("settled provider run finished manual compaction")
	}
	prior = append(prior, publishCompactionMarker(t, s, sub)...)
	if got := counts(prior)[FrameCompactionDone]; got != 0 {
		t.Fatalf("settled provider run emitted %d manual compaction terminal frames", got)
	}

	release()
	awaitCompactionCall(t, result)
	_, done := sub.await(t, FrameCompactionDone)
	if done.RequestID != started.RequestID {
		t.Fatalf("manual compaction terminal = %q, want %q", done.RequestID, started.RequestID)
	}
}

func TestDispatchMatchedManualCompactionEmitsExactlyOneDone(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	mgr := testManager(t, client, newMemStore(), 64)
	sub := newRecorder(32)
	s, _, _ := acquire(t, mgr, testChat{id: "matched-manual", cwd: t.TempDir()}, sub)
	sub.next(t)

	release := d.BlockHandler(omorpc.CmdCompact)
	defer release()
	result := make(chan error, 1)
	go func() { result <- s.Compact(context.Background()) }()
	if !d.AwaitRequestCount(omorpc.CmdCompact, 1, testTimeout) {
		t.Fatal("manual compact did not reach the provider")
	}
	sub.await(t, FrameCompactionStart)

	injectEvent(t, s, map[string]any{"type": "compaction_start", "reason": "manual", "requestId": "provider-matched"})
	injectEvent(t, s, map[string]any{"type": "compaction_end", "requestId": "provider-matched"})
	_, done := sub.await(t, FrameCompactionDone)
	if done.RequestID != "provider-matched" {
		t.Fatalf("matched manual terminal = %q, want provider-matched", done.RequestID)
	}

	release()
	awaitCompactionCall(t, result)
	if got := counts(publishCompactionMarker(t, s, sub))[FrameCompactionDone]; got != 0 {
		t.Fatalf("matched manual pairing emitted %d extra terminal frames", got)
	}
	if s.RunSnapshot().Compacting {
		t.Fatal("matched manual pairing left the latch set")
	}
}

func publishCompactionMarker(t *testing.T, s *Session, sub *recorder) []Frame {
	t.Helper()
	s.lifecycleMu.Lock()
	s.publishLocked(Frame{Kind: FrameState, SessionID: s.ID()})
	s.lifecycleMu.Unlock()
	prior, _ := sub.await(t, FrameState)
	return prior
}

func awaitCompactionCall(t *testing.T, result <-chan error) {
	t.Helper()
	select {
	case err := <-result:
		if err != nil {
			t.Fatalf("compact call failed: %v", err)
		}
	case <-time.After(testTimeout):
		t.Fatal("timed out waiting for compact call")
	}
}
