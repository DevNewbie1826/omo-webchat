package session

import (
	"encoding/json"
	"testing"
)

func TestDelayedResponseKeepsNewerRetainedApproval(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	mgr := testManager(t, client, newMemStore(), 64)
	first := newRecorder(16)
	s, _, detach := acquire(t, mgr, testChat{id: "a", cwd: t.TempDir()}, first)
	t.Cleanup(detach)
	first.await(t, FrameReady)

	injectEvent(t, s, approvalEvent("a-1", "select"))
	first.await(t, FrameApproval)
	injectEvent(t, s, approvalEvent("b-1", "select"))
	first.await(t, FrameApproval)

	confirmed := true
	if err := s.RespondApproval("a-1", json.RawMessage(`"yes"`), &confirmed, false); err != nil {
		t.Fatal(err)
	}
	_, ack := first.await(t, FrameAck)
	if ack.ApprovalID != "a-1" {
		t.Fatalf("ack approval id = %q", ack.ApprovalID)
	}

	late := &synchronousApprovalRecorder{recorder: newRecorder(16)}
	lateDetach := s.Attach(late)
	t.Cleanup(lateDetach)
	if frames := drainSync(late.recorder); !hasApproval(frames, "b-1") {
		t.Fatalf("late attacher missed newer pending approval: %+v", frames)
	}
}
