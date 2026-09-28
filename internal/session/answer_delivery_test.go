package session

import (
	"context"
	"errors"
	"testing"

	"github.com/DevNewbie1826/omo-webchat/internal/wscontract"
)

func TestAnswerDeliveryFailedWriteRetainsQuestionWithoutSuccessAck(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	manager := testManager(t, client, newMemStore(), 64)
	first := newRecorder(32)
	s, _, detach := acquire(t, manager, testChat{id: "failed-answer", cwd: t.TempDir()}, first)
	t.Cleanup(detach)
	first.await(t, FrameReady)
	d.EmitSession(s.SessionFile(), approvalEvent("ask", "question"))
	first.await(t, FrameApproval)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	err := s.RespondApprovalFrame(ctx, wscontract.ApprovalRespondFrame{ID: "ask"})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("write error=%v", err)
	}
	// IS-6: a local write failure is not evidence that the engine closed it.
	if s.pendingByID("ask") == nil {
		t.Fatal("failed write retired the unanswered question")
	}
	late := &synchronousApprovalRecorder{recorder: newRecorder(32)}
	t.Cleanup(s.Attach(late))
	if frames := drainSync(late.recorder); !hasApproval(frames, "ask") {
		t.Fatalf("failed write lost the answerable request: %+v", frames)
	}
}

func TestNonQuestionApprovalFailedWriteStillExpires(t *testing.T) {
	s, sub := acquireDrained(t, "failed-legacy-approval")
	injectEvent(t, s, approvalEvent("select-ask", "select"))
	sub.await(t, FrameApproval)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := s.RespondApprovalFrame(ctx, wscontract.ApprovalRespondFrame{ID: "select-ask"}); !errors.Is(err, context.Canceled) {
		t.Fatalf("write error=%v", err)
	}
	_, resolved := sub.await(t, FrameApprovalResolved)
	if data := resolved.Data.(map[string]any); data["id"] != "select-ask" || data["outcome"] != "expired" {
		t.Fatalf("non-question failed write changed semantics: %+v", resolved)
	}
}

func TestAnswerDeliveryResolvedOlderRequestKeepsLatestReplay(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	manager := testManager(t, client, newMemStore(), 64)
	first := newRecorder(32)
	s, _, detach := acquire(t, manager, testChat{id: "older-answer", cwd: t.TempDir()}, first)
	t.Cleanup(detach)
	first.await(t, FrameReady)
	d.EmitSession(s.SessionFile(), approvalEvent("older", "question"))
	first.await(t, FrameApproval)
	d.EmitSession(s.SessionFile(), approvalEvent("newer", "confirm"))
	first.await(t, FrameApproval)
	d.EmitSession(s.SessionFile(), map[string]any{"type": "question_resolved", "id": "older", "outcome": "timed_out"})
	first.await(t, FrameApprovalResolved)
	if err := s.RespondApprovalFrame(context.Background(), wscontract.ApprovalRespondFrame{ID: "older"}); !errors.Is(err, errApprovalExpired) {
		t.Fatalf("stale answer=%v", err)
	}
	late := &synchronousApprovalRecorder{recorder: newRecorder(32)}
	t.Cleanup(s.Attach(late))
	if frames := drainSync(late.recorder); !hasApproval(frames, "newer") || hasApproval(frames, "older") {
		t.Fatalf("replay=%+v", frames)
	}
}
