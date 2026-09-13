package session

import "testing"

func TestQuestionUpdateDoesNotMutateDeliveredFrame(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	mgr := testManager(t, client, newMemStore(), 64)
	first := newRecorder(16)
	s, _, detach := acquire(t, mgr, testChat{id: "a", cwd: t.TempDir()}, first)
	t.Cleanup(detach)
	first.await(t, FrameReady)

	approval := approvalEvent("q-1", "question")
	approval["deadlineAtMs"] = 1000
	injectEvent(t, s, approval)
	_, live := first.await(t, FrameApproval)
	data, ok := live.Data.(map[string]any)
	if !ok {
		t.Fatalf("live approval data type = %T", live.Data)
	}

	injectEvent(t, s, map[string]any{"type": "question_updated", "id": "q-1", "deadlineAtMs": 5000, "remainingMs": 4000})
	if got := data["deadlineAtMs"]; got != float64(1000) {
		t.Fatalf("delivered frame deadlineAtMs = %v, want 1000", got)
	}

	late := &synchronousApprovalRecorder{recorder: newRecorder(16)}
	lateDetach := s.Attach(late)
	t.Cleanup(lateDetach)
	frames := drainSync(late.recorder)
	for _, frame := range frames {
		if frame.Kind == FrameApproval && frame.ApprovalID == "q-1" {
			updated, ok := frame.Data.(map[string]any)
			if !ok {
				t.Fatalf("late approval data type = %T", frame.Data)
			}
			if got := updated["deadlineAtMs"]; got != float64(5000) {
				t.Fatalf("late frame deadlineAtMs = %v, want 5000", got)
			}
			return
		}
	}
	t.Fatal("late attacher missed pending question")
}
