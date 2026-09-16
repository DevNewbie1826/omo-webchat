package wsbridge

import (
	"reflect"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

func TestQuestionPayloadReachesWebsocketWhenEngineRequests(t *testing.T) {
	// Given
	h := newInPlaceBridgeHarness(t, "question-request")
	conn, frames := h.connect(t)
	attachAndAwaitHistory(t, conn, frames, "question-request")
	questions := []any{map[string]any{"id": "q1", "header": "Stack", "question": "Which?", "multiSelect": true, "options": []any{map[string]any{"label": "Go", "description": "Backend"}}}}
	// When
	h.daemon.EmitSession(h.path, map[string]any{"type": "extension_ui_request", "id": "ask", "method": "question", "questions": questions})
	// Then
	got := frames.next(t, "approval")
	if got["method"] != "question" || !reflect.DeepEqual(got["questions"], questions) {
		t.Fatalf("question payload lost: %v", got)
	}
}

func TestQuestionAnswersReachEngineWhenBrowserResponds(t *testing.T) {
	// Given
	h := newInPlaceBridgeHarness(t, "question-response")
	conn, frames := h.connect(t)
	attachAndAwaitHistory(t, conn, frames, "question-response")
	answers := map[string]any{"q1": map[string]any{"selected": []any{"Go", "TS"}}, "q2": map[string]any{"selected": []any{}, "text": "custom"}}
	// When
	writeClient(t, conn, map[string]any{"type": "approval.respond", "sessionId": "question-response", "id": "ask", "requestId": "browser", "answers": answers, "comment": "overall"})
	// Then
	ack := frames.next(t, "ack")
	if ack["requestId"] != "browser" || ack["id"] != "ask" {
		t.Fatalf("correlation lost: %v", ack)
	}
	if !h.daemon.AwaitRequestCount(omorpc.CmdExtensionUIResponse, 1, 5*time.Second) {
		t.Fatal("response not delivered")
	}
	got := h.daemon.LastRequest(omorpc.CmdExtensionUIResponse)
	if !reflect.DeepEqual(got["answers"], answers) || got["comment"] != "overall" {
		t.Fatalf("structured response lost: %v", got)
	}
}
