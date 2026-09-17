package session

import (
	"context"
	"errors"
	"testing"

	"github.com/DevNewbie1826/omo-webchat/internal/wscontract"
)

func TestAnswerDeliveryFailedWriteRetiresWithoutSuccessAck(t *testing.T) {
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
	preceding, terminal := first.await(t, FrameApprovalResolved)
	for _, frame := range preceding {
		if frame.Kind == FrameAck {
			t.Fatalf("failed write acknowledged: %+v", frame)
		}
	}
	if terminal.Data.(map[string]any)["id"] != "ask" {
		t.Fatalf("resolution=%+v", terminal)
	}
	late := &synchronousApprovalRecorder{recorder: newRecorder(32)}
	t.Cleanup(s.Attach(late))
	if frames := drainSync(late.recorder); hasApproval(frames, "ask") {
		t.Fatalf("failed answer replayed: %+v", frames)
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
	first.await(t, FrameApprovalResolved)
	late := &synchronousApprovalRecorder{recorder: newRecorder(32)}
	t.Cleanup(s.Attach(late))
	if frames := drainSync(late.recorder); !hasApproval(frames, "newer") || hasApproval(frames, "older") {
		t.Fatalf("replay=%+v", frames)
	}
}
