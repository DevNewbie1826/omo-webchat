package session

import (
	"encoding/json"
	"testing"
)

type synchronousApprovalRecorder struct {
	*recorder
}

func (*synchronousApprovalRecorder) SynchronousAttach() {}

func approvalEvent(id, method string) map[string]any {
	return map[string]any{
		"type":    "extension_ui_request",
		"id":      id,
		"method":  method,
		"title":   "Pick one",
		"options": []any{"yes", "no"},
	}
}

// drainSync collects every already-delivered frame without waiting; attach with
// a SynchronousAttach subscriber delivers the complete initial set before
// Attach returns, so an absent frame is a verdict, not a race.
func drainSync(r *recorder) []Frame {
	var out []Frame
	for {
		select {
		case f := <-r.ch:
			out = append(out, f)
		default:
			return out
		}
	}
}

func hasApproval(frames []Frame, id string) bool {
	for _, f := range frames {
		if f.Kind == FrameApproval && f.ApprovalID == id {
			return true
		}
	}
	return false
}

func TestAttachReplaysPendingApproval(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	mgr := testManager(t, client, newMemStore(), 64)
	first := newRecorder(16)
	s, _, detach := acquire(t, mgr, testChat{id: "a", cwd: t.TempDir()}, first)
	t.Cleanup(detach)
	first.await(t, FrameReady)

	injectEvent(t, s, approvalEvent("approval-1", "select"))
	_, live := first.await(t, FrameApproval)
	if live.ApprovalID != "approval-1" {
		t.Fatalf("live approval id = %q", live.ApprovalID)
	}

	// A client that attaches after the broadcast must still see the ask.
	late := &synchronousApprovalRecorder{recorder: newRecorder(16)}
	lateDetach := s.Attach(late)
	t.Cleanup(lateDetach)
	if frames := drainSync(late.recorder); !hasApproval(frames, "approval-1") {
		t.Fatalf("late attacher missed pending approval: %+v", frames)
	}
}

func TestApprovalResponseClearsReplayForLaterAttach(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	mgr := testManager(t, client, newMemStore(), 64)
	first := newRecorder(16)
	s, _, detach := acquire(t, mgr, testChat{id: "a", cwd: t.TempDir()}, first)
	t.Cleanup(detach)
	first.await(t, FrameReady)

	injectEvent(t, s, approvalEvent("approval-1", "select"))
	first.await(t, FrameApproval)

	confirmed := true
	if err := s.RespondApproval("approval-1", json.RawMessage(`"yes"`), &confirmed, false); err != nil {
		t.Fatal(err)
	}
	_, ack := first.await(t, FrameAck)
	if ack.ApprovalID != "approval-1" {
		t.Fatalf("ack approval id = %q", ack.ApprovalID)
	}

	after := &synchronousApprovalRecorder{recorder: newRecorder(16)}
	afterDetach := s.Attach(after)
	t.Cleanup(afterDetach)
	if frames := drainSync(after.recorder); hasApproval(frames, "approval-1") {
		t.Fatalf("answered approval replayed to a new attacher: %+v", frames)
	}
}

func TestApprovalReplaySkipsFireAndForgetMethods(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	mgr := testManager(t, client, newMemStore(), 64)
	first := newRecorder(16)
	s, _, detach := acquire(t, mgr, testChat{id: "a", cwd: t.TempDir()}, first)
	t.Cleanup(detach)
	first.await(t, FrameReady)

	// notify is fire-and-forget: broadcast live, never retained for replay.
	injectEvent(t, s, approvalEvent("notice-1", "notify"))
	_, live := first.await(t, FrameApproval)
	if live.ApprovalID != "notice-1" {
		t.Fatalf("live notify frame id = %q", live.ApprovalID)
	}

	late := &synchronousApprovalRecorder{recorder: newRecorder(16)}
	lateDetach := s.Attach(late)
	t.Cleanup(lateDetach)
	if frames := drainSync(late.recorder); hasApproval(frames, "notice-1") {
		t.Fatalf("fire-and-forget request retained for replay: %+v", frames)
	}
}

func TestQuestionResolvedClearsPendingApproval(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	mgr := testManager(t, client, newMemStore(), 64)
	first := newRecorder(16)
	s, _, detach := acquire(t, mgr, testChat{id: "a", cwd: t.TempDir()}, first)
	t.Cleanup(detach)
	first.await(t, FrameReady)

	injectEvent(t, s, approvalEvent("q-1", "question"))
	first.await(t, FrameApproval)

	injectEvent(t, s, map[string]any{"type": "question_resolved", "id": "q-1", "outcome": "timed_out"})
	if s.pendingApproval != nil {
		t.Fatalf("question_resolved left pending approval %q", s.pendingApproval.ApprovalID)
	}

	late := &synchronousApprovalRecorder{recorder: newRecorder(16)}
	lateDetach := s.Attach(late)
	t.Cleanup(lateDetach)
	if frames := drainSync(late.recorder); hasApproval(frames, "q-1") {
		t.Fatalf("resolved question replayed to a new attacher: %+v", frames)
	}
}

func TestProviderUnloadDropsPendingApproval(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	mgr := testManager(t, client, newMemStore(), 64)
	first := newRecorder(16)
	s, _, detach := acquire(t, mgr, testChat{id: "a", cwd: t.TempDir()}, first)
	t.Cleanup(detach)
	first.await(t, FrameReady)

	injectEvent(t, s, approvalEvent("approval-1", "select"))
	first.await(t, FrameApproval)

	// Provider unload cancels its pending UI requests; the retained ask must
	// not resurface when a client reattaches after the route comes back.
	s.lifecycleMu.Lock()
	s.markProviderUnloadedLocked()
	s.lifecycleMu.Unlock()
	if s.pendingApproval != nil {
		t.Fatalf("provider unload left pending approval %q", s.pendingApproval.ApprovalID)
	}
}
