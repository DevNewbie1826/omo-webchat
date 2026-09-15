package session

import (
	"context"
	"reflect"
	"testing"

	"github.com/DevNewbie1826/omo-webchat/internal/wscontract"
)

func structuredLifecycleRequest() map[string]any {
	return map[string]any{
		"type": "extension_ui_request", "id": "structured-ask", "method": "question",
		"questions": []any{
			map[string]any{"id": "stack", "multiSelect": true, "options": []any{
				map[string]any{"label": "Go", "description": "Backend services"},
				map[string]any{"label": "TS", "description": "Frontend app"},
			}},
			map[string]any{"id": "region", "multiSelect": false, "options": []any{
				map[string]any{"label": "east", "description": "East coast"},
				map[string]any{"label": "west", "description": "West coast"},
			}},
		},
	}
}

func TestStructuredQuestionReconnectReplayRemainsAnswerable(t *testing.T) {
	s, first := acquireDrained(t, "structured-reconnect")
	request := structuredLifecycleRequest()
	injectEvent(t, s, request)
	_, live := first.await(t, FrameApproval)
	if !reflect.DeepEqual(live.Data.(map[string]any)["questions"], request["questions"]) {
		t.Fatalf("live questions = %+v, want %+v", live.Data, request["questions"])
	}

	// Disconnect and replace a subscriber while the request is unanswered.
	previous := &synchronousApprovalRecorder{recorder: newRecorder(16)}
	detach := s.Attach(previous)
	drainSync(previous.recorder)
	detach()
	reconnected := &synchronousApprovalRecorder{recorder: newRecorder(16)}
	t.Cleanup(s.Attach(reconnected))
	frames := drainSync(reconnected.recorder)
	var replay *Frame
	for i := range frames {
		if frames[i].Kind == FrameApproval {
			if replay != nil {
				t.Fatal("reconnect duplicated the pending request")
			}
			replay = &frames[i]
		}
	}
	if replay == nil || replay.ApprovalID != "structured-ask" || !reflect.DeepEqual(replay.Data, live.Data) {
		t.Fatalf("replay = %+v, want intact live request %+v", replay, live)
	}
	if s.pendingApproval == nil || s.pendingApproval.ApprovalID != "structured-ask" {
		t.Fatal("replayed structured request is no longer pending")
	}
	answers := map[string]wscontract.QuestionAnswer{
		"stack":  {Selected: []string{"Go", "TS"}},
		"region": {Selected: []string{"west"}},
	}
	if err := s.RespondApprovalFrame(context.Background(), wscontract.ApprovalRespondFrame{ID: "structured-ask", Answers: &answers}); err != nil {
		t.Fatal(err)
	}
	_, ack := reconnected.await(t, FrameAck)
	if ack.ApprovalID != "structured-ask" || s.pendingApproval != nil {
		t.Fatalf("answer did not settle replayed request: ack=%+v pending=%+v", ack, s.pendingApproval)
	}
	_, siblingAck := first.await(t, FrameAck)
	if siblingAck.ApprovalID != "structured-ask" {
		t.Fatalf("other client acknowledgement = %+v", siblingAck)
	}
	after := &synchronousApprovalRecorder{recorder: newRecorder(16)}
	t.Cleanup(s.Attach(after))
	if frames := drainSync(after.recorder); hasApproval(frames, "structured-ask") {
		t.Fatalf("answered structured request replayed: %+v", frames)
	}
}

func TestStructuredQuestionDeadlineRefreshPublishesAndReplays(t *testing.T) {
	s, first := acquireDrained(t, "structured-deadline")
	request := structuredLifecycleRequest()
	request["deadlineAtMs"] = 1000
	request["remainingMs"] = 500
	injectEvent(t, s, request)
	_, live := first.await(t, FrameApproval)
	injectEvent(t, s, map[string]any{"type": "question_updated", "id": "different", "deadlineAtMs": 9000})
	// A same-stream barrier proves the mismatched update emitted no frame.
	s.lifecycleMu.Lock()
	s.publishLocked(Frame{Kind: FrameAck, ApprovalID: "deadline-barrier"})
	s.lifecycleMu.Unlock()
	if frame := first.next(t); frame.Kind != FrameAck || frame.ApprovalID != "deadline-barrier" {
		t.Fatalf("mismatched deadline published a frame before the barrier: %+v", frame)
	}
	injectEvent(t, s, map[string]any{"type": "question_updated", "id": "structured-ask", "deadlineAtMs": 5000, "remainingMs": 4000})
	updated := first.next(t)
	if updated.Kind != FrameApproval {
		t.Fatalf("structured deadline refresh = %+v, want approval", updated)
	}
	want := make(map[string]any)
	for key, value := range live.Data.(map[string]any) {
		want[key] = value
	}
	want["deadlineAtMs"], want["remainingMs"] = float64(5000), float64(4000)
	if updated.ApprovalID != "structured-ask" || !reflect.DeepEqual(updated.Data, want) {
		t.Fatalf("deadline refresh = %+v, want %+v", updated, want)
	}
	if live.Data.(map[string]any)["deadlineAtMs"] != float64(1000) || live.Data.(map[string]any)["remainingMs"] != float64(500) {
		t.Fatalf("deadline refresh mutated original delivery: %+v", live)
	}
	late := &synchronousApprovalRecorder{recorder: newRecorder(16)}
	t.Cleanup(s.Attach(late))
	for _, frame := range drainSync(late.recorder) {
		if frame.Kind == FrameApproval {
			if !reflect.DeepEqual(frame, updated) {
				t.Fatalf("refreshed replay = %+v, want %+v", frame, updated)
			}
			return
		}
	}
	t.Fatal("refreshed structured request missing from replay")
}
