package session

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc/omorpctest"
)

func TestSendPromptClassifiesProviderRouteLossAsResumable(t *testing.T) {
	for _, code := range []string{omorpc.ErrCodeUnknownSession, omorpc.ErrCodeSessionClosing} {
		t.Run(code, func(t *testing.T) {
			d := newDaemon(t)
			client := dial(t, d)
			mgr := testManager(t, client, newMemStore(), 16)
			pane := newRecorder(16)
			s, _, detach := acquire(t, mgr, testChat{id: "route-loss-" + code, cwd: t.TempDir()}, pane)
			defer detach()
			_ = pane.drain()

			d.FailNext(omorpc.CmdPrompt, code)
			err := s.SendPrompt(context.Background(), "lost route", nil)
			if !errors.Is(err, ErrSessionResumable) {
				t.Fatalf("SendPrompt = %v, want ErrSessionResumable", err)
			}
			var stable *omorpc.StableError
			if !errors.As(err, &stable) || stable.Code != code {
				t.Fatalf("SendPrompt = %v, want wrapped stable code %q", err, code)
			}
			if !s.Resumable() || s.RunSnapshot().Streaming || s.RunSnapshot().Compacting {
				t.Fatalf("route-loss latches = resumable:%v run:%+v", s.Resumable(), s.RunSnapshot())
			}
			for _, frame := range pane.drain() {
				if frame.Kind == FrameError {
					t.Fatalf("route loss exposed an error frame: %+v", frame)
				}
			}
		})
	}
}

func TestSilentProviderEvictionResumesAndReplaysPromptWithoutErrorFrame(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	store := newMemStore()
	mgr := testManager(t, client, store, 64)
	chat := testChat{id: "silent-provider-eviction", cwd: t.TempDir()}
	pane := newRecorder(64)
	stale, _, staleDetach := acquire(t, mgr, chat, pane)
	defer staleDetach()

	d.SetPromptScript(stale.SessionFile(),
		map[string]any{"type": omorpctest.EventAgentStart},
		map[string]any{"type": omorpctest.EventAgentSettled, "reason": "end_turn"},
	)
	if err := stale.SendPrompt(context.Background(), "first prompt", nil); err != nil {
		t.Fatalf("initial prompt: %v", err)
	}
	_, _ = pane.await(t, FrameRunDone)
	_ = pane.drain()

	d.EvictUsedSessionOnNextRoutingCommand()
	const requestID = "prompt-after-silent-eviction"
	failedCompletion := make(chan error, 1)
	if err := stale.SendPromptDetachedWithRequestIDAndCompletion(context.Background(), "after eviction", nil, requestID, func(err error) {
		failedCompletion <- err
	}); err != nil {
		t.Fatalf("evicted prompt admission: %v", err)
	}
	var evictionErr error
	select {
	case evictionErr = <-failedCompletion:
	case <-time.After(testTimeout):
		t.Fatal("timed out waiting for eviction response")
	}
	if !errors.Is(evictionErr, ErrSessionResumable) {
		t.Fatalf("evicted prompt completion = %v, want ErrSessionResumable", evictionErr)
	}
	var stable *omorpc.StableError
	if !errors.As(evictionErr, &stable) || stable.Code != omorpc.ErrCodeUnknownSession {
		t.Fatalf("evicted prompt completion = %v, want wrapped unknown_session", evictionErr)
	}
	if !stale.Resumable() {
		t.Fatal("provider eviction did not latch the stale session resumable")
	}

	retryToken, prepared := stale.PrepareDetachedSendRetry(requestID, false)
	if !prepared {
		t.Fatal("evicted prompt was not available for transparent retry")
	}
	defer stale.RetireDetachedSendRetry(retryToken)
	d.SetPromptScript(stale.SessionFile(),
		map[string]any{"type": omorpctest.EventAgentStart},
		map[string]any{"type": omorpctest.EventAgentSettled, "reason": "end_turn"},
	)
	retryCompletion := make(chan error, 1)
	resumed, started, resumedDetach, err := mgr.ResumeInitializedCheckedAndRun(
		context.Background(), chat, pane, nil, func() error { return nil },
		func(acquired *Session) error {
			return acquired.SendPromptDetachedWithRequestIDAndCompletion(context.Background(), "after eviction", nil, requestID, func(err error) {
				acquired.CompleteDetachedSend(requestID, err)
				retryCompletion <- err
			})
		},
	)
	if err != nil {
		t.Fatalf("transparent resume and retry: %v", err)
	}
	defer resumedDetach()
	if !started || resumed == stale || resumed.RoutingID() == stale.RoutingID() || resumed.ID() != stale.ID() {
		t.Fatalf("replacement = (started=%v same=%v route=%q durable=%q), stale route=%q durable=%q", started, resumed == stale, resumed.RoutingID(), resumed.ID(), stale.RoutingID(), stale.ID())
	}

	select {
	case err := <-retryCompletion:
		if err != nil {
			t.Fatalf("retried prompt completion: %v", err)
		}
	case <-time.After(testTimeout):
		t.Fatal("timed out waiting for retried prompt response")
	}
	var frames []Frame
	runCompleted, outcomeCompleted := false, false
	deadline := time.After(testTimeout)
	for !runCompleted || !outcomeCompleted {
		select {
		case frame := <-pane.ch:
			frames = append(frames, frame)
			if frame.Kind == FrameError {
				t.Fatalf("transparent recovery exposed an error frame: %+v", frame)
			}
			if frame.Kind == FrameRunDone {
				runCompleted = true
			}
			if frame.Kind == FrameAck && frame.Command == "chat.send" && frame.RequestID == requestID && frame.Phase == "completed" {
				outcomeCompleted = true
			}
		case <-deadline:
			t.Fatalf("retried prompt did not finish without an error row: %+v", frames)
		}
	}
	if got := d.RequestCount(omorpc.CmdPrompt); got != 3 {
		t.Fatalf("prompt requests = %d, want initial + rejected + replayed", got)
	}
	if got := d.OpenCount(); got != 2 {
		t.Fatalf("open requests = %d, want initial + resumed", got)
	}
}
