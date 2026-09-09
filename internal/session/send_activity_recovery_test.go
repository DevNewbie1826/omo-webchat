package session

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

func TestUnresolvedSendOwnershipRequiresItsOwnOutcome(t *testing.T) {
	for _, outcome := range []error{nil, errors.New("authoritative rejection")} {
		t.Run(fmt.Sprintf("rejected=%v", outcome != nil), func(t *testing.T) {
			d := newDaemon(t)
			mgr := testManager(t, dial(t, d), newMemStore(), 64)
			s, _, detach := acquire(t, mgr, testChat{id: "send-owner", cwd: t.TempDir()}, nil)
			detach()
			owner := s.operationOwner()
			write := &sendWrite{requestID: "unresolved"}
			owner.mu.Lock()
			owner.unresolvedWrites = map[*sendWrite]struct{}{write: {}}
			owner.unresolvedWriteCount.Store(1)
			owner.mu.Unlock()
			if err, duplicate := s.beginSendOperation(write.requestID); err != nil || duplicate {
				t.Fatalf("admission = %v, %v", err, duplicate)
			}
			if _, err := s.QueryState(context.Background()); err != nil {
				t.Fatal(err)
			}
			injectEvent(t, s, map[string]any{"type": "agent_settled"})
			injectEvent(t, s, map[string]any{"type": "compaction_done", "requestId": "unrelated"})
			s.CompleteDetachedSend("unrelated", nil)
			s.CompleteDetachedSend("", errors.New("unrelated no-ID control failure"))
			s.lifecycleMu.Lock()
			owned, hydration := s.recoveryWorkLocked(), s.activityHydrationPending
			s.lifecycleMu.Unlock()
			if !owned || !hydration {
				t.Fatalf("unrelated terminals retired send ownership=%v hydration=%v", owned, hydration)
			}
			mgr.evict(s) // exercise the idle callback's revalidation, not its timer
			if got := d.RequestCount(omorpc.CmdCloseSession); got != 0 {
				t.Fatalf("idle eviction crossed unresolved ownership: %d closes", got)
			}
			s.CompleteDetachedSend(write.requestID, outcome)
			s.lifecycleMu.Lock()
			owned = s.recoveryWorkLocked()
			s.lifecycleMu.Unlock()
			if owned {
				t.Fatal("own terminal did not retire send ownership")
			}
			mgr.evict(s)
			if got := d.RequestCount(omorpc.CmdCloseSession); got != 1 {
				t.Fatalf("settled ownership did not release idle eviction: %d closes", got)
			}
		})
	}
}

func TestUnresolvedSendLateQueryCannotOverwriteLiveSettlement(t *testing.T) {
	d := newDaemon(t)
	mgr := testManager(t, dial(t, d), newMemStore(), 64)
	sub := newRecorder(32)
	s, _, detach := acquire(t, mgr, testChat{id: "send-late-query", cwd: t.TempDir()}, sub)
	defer detach()
	owner := s.operationOwner()
	owner.mu.Lock()
	owner.unresolvedWrites = map[*sendWrite]struct{}{{requestID: "held"}: {}}
	owner.unresolvedWriteCount.Store(1)
	owner.mu.Unlock()
	d.EmitSession(s.SessionFile(), map[string]any{"type": "agent_start"})
	sub.await(t, FrameRunStarted)
	release := d.BlockHandler(omorpc.CmdGetState)
	defer release()
	before := d.RequestCount(omorpc.CmdGetState)
	result := make(chan error, 1)
	go func() { _, err := s.QueryState(context.Background()); result <- err }()
	if !d.AwaitRequestCount(omorpc.CmdGetState, before+1, time.Second) {
		t.Fatal("missing get_state")
	}
	injectEvent(t, s, map[string]any{"type": "agent_settled", "reason": "end_turn"})
	release()
	select {
	case err := <-result:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(testTimeout):
		t.Fatal("get_state deadline")
	}
	if run := s.RunSnapshot(); run.Streaming || run.Compacting {
		t.Fatalf("late query resurrected settled activity: %+v", run)
	}
	s.lifecycleMu.Lock()
	owned, hydration := s.recoveryWorkLocked(), s.activityHydrationPending
	s.lifecycleMu.Unlock()
	if !owned || !hydration {
		t.Fatalf("live terminal retired unresolved send ownership=%v hydration=%v", owned, hydration)
	}
}
