package session

import (
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

func TestReviewOmittedActivityCompactionTerminal(t *testing.T) {
	for _, tc := range []struct {
		name, rpcID string
		running     bool
	}{
		{name: "standalone-automatic"},
		{name: "standalone-manual", rpcID: "compact-7"},
		{name: "run-and-compaction", running: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			prior := &Session{durableID: "same", sessionFile: "same.jsonl", cwd: "/same",
				providerRunActive: tc.running, compactionActive: true, compactSeq: 7,
				compactRPCID: tc.rpcID, compactProviderID: "owned-compaction", compactPhase: "manual"}
			prior.invalidate("provider_disconnected", "lost")
			settled := make(chan struct{}, 2)
			mgr := &Manager{cfg: Config{IdleAfter: time.Hour, OnRunSettled: func(string, *Session) { settled <- struct{}{} }}}
			state := omorpc.SessionState{SessionID: prior.ID(), SessionFile: prior.SessionFile()}
			s := newSession(mgr, "chat", prior.cwd, omorpc.OpenSessionData{State: state}, true, omorpc.EpochToken{})
			s.inheritWork(prior, state)
			defer func() {
				s.lifecycleMu.Lock()
				s.cancelIdleLocked()
				s.lifecycleMu.Unlock()
			}()
			if run := s.RunSnapshot(); run.Streaming != tc.running || !run.Compacting || !s.workAtLoss {
				t.Fatalf("unknown activity lost work kind: %+v, ownership %v", run, s.workAtLoss)
			}
			if s.compactRPCID != tc.rpcID || s.compactProviderID != "owned-compaction" || s.compactSeq != 7 {
				t.Fatalf("lost compaction correlation: RPC=%q provider=%q sequence=%d", s.compactRPCID, s.compactProviderID, s.compactSeq)
			}
			injectEvent(t, s, map[string]any{"type": "compaction_done", "requestId": "unrelated"})
			if tc.rpcID != "" {
				injectEvent(t, s, map[string]any{"type": "compaction_done"})
			}
			if !s.RunSnapshot().Compacting || !s.activityHydrationPending {
				t.Fatal("unmatched terminal retired compaction ownership or hydration")
			}
			select {
			case <-settled:
				t.Fatal("unmatched terminal unblocked queue draining")
			default:
			}
			injectEvent(t, s, map[string]any{"type": "compaction_done", "requestId": "owned-compaction", "reason": "manual"})
			if run := s.RunSnapshot(); run.Compacting || run.Streaming != tc.running {
				t.Fatalf("matched terminal did not settle only compaction: %+v", run)
			}
			if tc.running {
				select {
				case <-settled:
					t.Fatal("compaction terminal drained a still-running queue")
				default:
				}
				injectEvent(t, s, map[string]any{"type": "agent_settled"})
			}
			select {
			case <-settled:
			case <-time.After(testTimeout):
				t.Fatal("terminal did not unblock queue draining")
			}
			s.invalidate("provider_disconnected", "later loss")
			if s.workAtLoss || s.runAtLoss || s.compactionAtLoss {
				t.Fatal("terminal left at-loss ownership behind")
			}
		})
	}
}

func TestRecoveredCompactionHonorsExplicitSettledSnapshot(t *testing.T) {
	prior := &Session{durableID: "same", sessionFile: "same.jsonl", cwd: "/same", compactionActive: true,
		compactRPCID: "compact-7", compactProviderID: "settled-compaction"}
	prior.invalidate("provider_disconnected", "lost")
	no := false
	state := omorpc.SessionState{SessionID: prior.ID(), SessionFile: prior.SessionFile(), IsStreaming: &no, IsCompacting: &no}
	s := newSession(&Manager{}, "chat", prior.cwd, omorpc.OpenSessionData{State: state}, true, omorpc.EpochToken{})
	s.inheritWork(prior, state)
	if run := s.RunSnapshot(); run.Streaming || run.Compacting || s.workAtLoss || s.runAtLoss || s.compactionAtLoss {
		t.Fatalf("explicit settled snapshot retained compaction: %+v", run)
	}
	if s.compactRPCID != "" || s.compactProviderID != "" {
		t.Fatal("settled compaction correlation could bind a later snapshot's successor")
	}
}
