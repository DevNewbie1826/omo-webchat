package session

import (
	"context"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

func TestReplacementActivityUsesAuthoritativeState(t *testing.T) {
	yes, no := true, false
	for _, tc := range []struct {
		name                           string
		streaming, compacting          *bool
		wantRun, wantCompact, wantWork bool
	}{
		{"running", &yes, &no, true, false, true},
		{"compacting", &no, &yes, false, true, true},
		{"settled", &no, &no, false, false, false},
		{"omitted", nil, nil, true, false, true},
		{"partial-idle", &no, nil, true, false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			prior := &Session{durableID: "same", sessionFile: "same.jsonl", cwd: "/same", workAtLoss: true}
			state := omorpc.SessionState{SessionID: prior.ID(), SessionFile: prior.SessionFile(), IsStreaming: tc.streaming, IsCompacting: tc.compacting}
			s := newSession(&Manager{}, "chat", prior.cwd, omorpc.OpenSessionData{State: state}, true, omorpc.EpochToken{})
			s.inheritWork(prior, state)
			if run := s.RunSnapshot(); run.Streaming != tc.wantRun || run.Compacting != tc.wantCompact || s.workAtLoss != tc.wantWork {
				t.Fatalf("replacement activity = %+v, ownership %v", run, s.workAtLoss)
			}
			s.invalidate("provider_disconnected", "second loss")
			if s.workAtLoss != tc.wantWork {
				t.Fatalf("second loss ownership = %v", s.workAtLoss)
			}
		})
	}
}

func TestRecoveryStateQueryCannotOverwriteLiveSettlement(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	mgr := testManager(t, client, newMemStore(), 64)
	recorder := newRecorder(16)
	s, _, detach := acquire(t, mgr, testChat{id: "hydrate-live", cwd: t.TempDir()}, recorder)
	defer detach()
	d.SetPromptScript(s.SessionFile(), map[string]any{"type": "agent_start"})
	if err := s.SendPrompt(context.Background(), "running", nil); err != nil {
		t.Fatal(err)
	}
	recorder.await(t, FrameRunStarted)
	// Model an open snapshot whose first authoritative query is still pending.
	s.lifecycleMu.Lock()
	s.workAtLoss, s.activityHydrationPending = true, true
	s.lifecycleMu.Unlock()
	// Engine get_state remains running, while its later live terminal wins.
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
	case <-time.After(time.Second):
		t.Fatal("get_state deadline")
	}
	if run := s.RunSnapshot(); run.Streaming || run.Compacting || s.workAtLoss {
		t.Fatalf("late state resurrected settled work: %+v, ownership %v", run, s.workAtLoss)
	}
}
