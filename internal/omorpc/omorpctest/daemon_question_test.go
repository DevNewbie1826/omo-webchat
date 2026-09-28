package omorpctest

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc/omorpctest/transport"
)

func askQuestion(q *queueTest, id, requestID string) {
	q.t.Helper()
	q.d.EmitSession(q.path, map[string]any{
		"type": "extension_ui_request", "method": "question",
		"id": id, "requestId": requestID,
		"questions":    []any{map[string]any{"id": "q1", "header": "Choice"}},
		"deadlineAtMs": int64(100), "remainingMs": int64(50),
	})
	if event := q.nextEvent(); event.Type != "extension_ui_request" {
		q.t.Fatalf("request event = %q", event.Type)
	}
}

func questionState(t *testing.T, response *omorpc.Response) []map[string]any {
	t.Helper()
	var data struct {
		PendingQuestions []map[string]any `json:"pendingQuestions"`
	}
	if err := json.Unmarshal(response.Data, &data); err != nil {
		t.Fatal(err)
	}
	if data.PendingQuestions == nil {
		t.Fatal("pendingQuestions must be an array")
	}
	return data.PendingQuestions
}

func TestDaemonQuestionRequestRetainedInBothStateSurfaces(t *testing.T) {
	q := newQueueTest(t)
	q.d.SetPromptScript(q.path, map[string]any{
		"type": "extension_ui_request", "method": "question",
		"id": "ask-1", "requestId": "tool-1",
		"questions": []any{map[string]any{"id": "q1", "header": "Choice"}},
	})
	q.call(omorpc.Prompt{SessionID: q.rpc, Message: "ask"})
	q.expectEvent("extension_ui_request")

	first := questionState(t, q.call(omorpc.GetState{SessionID: q.rpc}))
	if len(first) != 1 || first[0]["id"] != "ask-1" || first[0]["requestId"] != "tool-1" {
		t.Fatalf("get_state pendingQuestions = %+v", first)
	}
	opened := q.call(omorpc.OpenSession{SessionPath: q.path})
	var data struct {
		State struct {
			PendingQuestions []map[string]any `json:"pendingQuestions"`
		} `json:"state"`
	}
	if err := json.Unmarshal(opened.Data, &data); err != nil {
		t.Fatal(err)
	}
	if len(data.State.PendingQuestions) != 1 || data.State.PendingQuestions[0]["id"] != "ask-1" {
		t.Fatalf("open_session pendingQuestions = %+v", data.State.PendingQuestions)
	}
}

func TestDaemonQuestionResponsesResolveOrReject(t *testing.T) {
	tests := []struct {
		name      string
		answers   *map[string]omorpc.QuestionAnswer
		comment   *string
		cancelled bool
		outcome   string
		errCode   string
	}{
		{name: "selected answer", answers: &map[string]omorpc.QuestionAnswer{"q1": {Selected: []string{"A"}}}, outcome: "answered"},
		{name: "comment only", comment: new("Because"), outcome: "comment-submitted"},
		{name: "cancelled", cancelled: true, outcome: "cancelled"},
		{name: "empty answer", answers: &map[string]omorpc.QuestionAnswer{}, errCode: "question_incomplete"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			q := newQueueTest(t)
			askQuestion(q, "ask-1", "tool-1")

			if err := q.c.Notify(t.Context(), omorpc.ExtensionUIResponse{
				SessionID: q.rpc, ID: "ask-1", Answers: tt.answers, Comment: tt.comment, Cancelled: tt.cancelled,
			}); err != nil {
				t.Fatal(err)
			}
			event := q.nextEvent()
			var frame map[string]any
			if err := json.Unmarshal(event.Raw, &frame); err != nil {
				t.Fatal(err)
			}
			if tt.errCode != "" {
				if frame["command"] != omorpc.CmdExtensionUIResponse || frame["error"] != tt.errCode || frame["id"] != "ask-1" {
					t.Fatalf("incomplete response = %+v", frame)
				}
			} else if frame["type"] != "question_resolved" || frame["id"] != "ask-1" || frame["outcome"] != tt.outcome {
				t.Fatalf("resolution event = %+v", frame)
			}
			remaining := questionState(t, q.call(omorpc.GetState{SessionID: q.rpc}))
			want := 0
			if tt.errCode != "" {
				want = 1
			}
			if len(remaining) != want {
				t.Fatalf("pending after response = %+v, want %d", remaining, want)
			}
			if tt.errCode == "" {
				if err := q.c.Notify(t.Context(), omorpc.ExtensionUIResponse{
					SessionID: q.rpc, ID: "ask-1", Answers: tt.answers,
				}); err != nil {
					t.Fatal(err)
				}
				already := q.nextEvent()
				if err := json.Unmarshal(already.Raw, &frame); err != nil {
					t.Fatal(err)
				}
				if frame["error"] != "question_already_resolved" || frame["id"] != "ask-1" {
					t.Fatalf("repeat response = %+v", frame)
				}
			}
		})
	}
}

func TestDaemonQuestionUnknownIDReturnsAlreadyResolved(t *testing.T) {
	q := newQueueTest(t)
	askQuestion(q, "ask-1", "tool-1")
	if err := q.c.Notify(t.Context(), omorpc.ExtensionUIResponse{
		SessionID: q.rpc, ID: "missing", Comment: new("answer"),
	}); err != nil {
		t.Fatal(err)
	}
	var frame map[string]any
	if err := json.Unmarshal(q.nextEvent().Raw, &frame); err != nil {
		t.Fatal(err)
	}
	if frame["error"] != "question_already_resolved" || frame["id"] != "missing" {
		t.Fatalf("unknown question response = %+v", frame)
	}
	if pending := questionState(t, q.call(omorpc.GetState{SessionID: q.rpc})); len(pending) != 1 || pending[0]["id"] != "ask-1" {
		t.Fatalf("unknown id modified pending questions: %+v", pending)
	}
}

func TestDaemonQuestionProgressUpdatesDeadlineAndState(t *testing.T) {
	q := newQueueTest(t)
	askQuestion(q, "ask-1", "tool-1")
	conn, err := transport.Dial(context.Background(), q.d.SocketPath())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	if err := json.NewEncoder(conn).Encode(map[string]any{
		"type": "extension_ui_progress", "sessionId": q.rpc, "id": "ask-1",
		"answers": map[string]any{"q1": map[string]any{"selected": []any{"A"}}},
	}); err != nil {
		t.Fatal(err)
	}
	if err := conn.SetReadDeadline(time.Now().Add(queueTestAwait)); err != nil {
		t.Fatal(err)
	}
	var updated map[string]any
	if err := json.NewDecoder(conn).Decode(&updated); err != nil {
		t.Fatal(err)
	}
	if updated["type"] != "question_updated" || updated["id"] != "ask-1" || updated["remainingMs"] != float64(questionIdleDuration.Milliseconds()) {
		t.Fatalf("progress event = %+v", updated)
	}
	pending := questionState(t, q.call(omorpc.GetState{SessionID: q.rpc}))
	if len(pending) != 1 || pending[0]["deadlineAtMs"] != updated["deadlineAtMs"] {
		t.Fatalf("progress state = %+v, event = %+v", pending, updated)
	}
}

func TestDaemonQuestionProgressPreventsShortIdleTimeout(t *testing.T) {
	q := newQueueTest(t)
	askQuestion(q, "ask-1", "tool-1") // the initial deadline is Unix ms 100
	if err := q.c.Notify(t.Context(), omorpc.ExtensionUIProgress{SessionID: q.rpc, ID: "ask-1"}); err != nil {
		t.Fatal(err)
	}
	q.expectEvent("question_updated")
	q.d.ExpireQuestionsAt(time.UnixMilli(101))
	pending := questionState(t, q.call(omorpc.GetState{SessionID: q.rpc}))
	if len(pending) != 1 {
		t.Fatalf("progress failed to extend idle deadline: %+v", pending)
	}
	q.d.ExpireQuestionsAt(time.UnixMilli(int64(pending[0]["deadlineAtMs"].(float64))))
	q.expectEvent("question_resolved")
}

func TestDaemonQuestionDroppedResponseReaskedWithNewIDAfterRestart(t *testing.T) {
	q := newQueueTest(t)
	askQuestion(q, "ask-1", "tool-1")
	q.d.DropNextQuestionResponse()
	answers := map[string]omorpc.QuestionAnswer{"q1": {Selected: []string{"A"}}}
	if err := q.c.Notify(context.Background(), omorpc.ExtensionUIResponse{
		SessionID: q.rpc, ID: "ask-1", Answers: &answers,
	}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-q.d.questionDropFeed:
	case <-time.After(queueTestAwait):
		t.Fatal("dropped response was not processed")
	}
	if pending := questionState(t, q.call(omorpc.GetState{SessionID: q.rpc})); len(pending) != 1 {
		t.Fatalf("dropped answer removed question: %+v", pending)
	}

	q.d.Restart()
	client, err := omorpc.DialWithConfig(t.Context(), q.d.SocketPath(), omorpc.Config{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close() })
	q.c = client
	var opened omorpc.OpenSessionData
	openResponse := q.call(omorpc.OpenSession{SessionPath: q.path})
	if err := json.Unmarshal(openResponse.Data, &opened); err != nil {
		t.Fatal(err)
	}
	q.rpc = opened.SessionID
	var snapshot struct {
		State struct {
			PendingQuestions []map[string]any `json:"pendingQuestions"`
		} `json:"state"`
	}
	if err := json.Unmarshal(openResponse.Data, &snapshot); err != nil {
		t.Fatal(err)
	}
	pending := questionState(t, q.call(omorpc.GetState{SessionID: q.rpc}))
	if len(pending) != 1 || pending[0]["id"] == "ask-1" || pending[0]["requestId"] != "tool-1" {
		t.Fatalf("reasked question state = %+v", pending)
	}
	if len(snapshot.State.PendingQuestions) != 1 || snapshot.State.PendingQuestions[0]["id"] != pending[0]["id"] {
		t.Fatalf("reasked open_session state = %+v", snapshot.State.PendingQuestions)
	}
	reask := q.nextEvent()
	var frame map[string]any
	if err := json.Unmarshal(reask.Raw, &frame); err != nil {
		t.Fatal(err)
	}
	if frame["type"] != "extension_ui_request" || frame["id"] != pending[0]["id"] || frame["requestId"] != "tool-1" {
		t.Fatalf("reask event = %+v", frame)
	}
	newID := pending[0]["id"].(string)
	if err := q.c.Notify(t.Context(), omorpc.ExtensionUIResponse{
		SessionID: q.rpc, ID: newID, Answers: &answers,
	}); err != nil {
		t.Fatal(err)
	}
	resolved := q.nextEvent()
	if err := json.Unmarshal(resolved.Raw, &frame); err != nil {
		t.Fatal(err)
	}
	if frame["id"] != newID || frame["outcome"] != "answered" {
		t.Fatalf("resend resolution = %+v", frame)
	}
}

func TestDaemonQuestionReissuedRequestReplacesInPlace(t *testing.T) {
	q := newQueueTest(t)
	askQuestion(q, "ask-1", "tool-1")
	askQuestion(q, "ask-2", "tool-2")
	askQuestion(q, "ask-3", "tool-1")
	questions := questionState(t, q.call(omorpc.GetState{SessionID: q.rpc}))
	if len(questions) != 2 || questions[0]["id"] != "ask-3" || questions[1]["id"] != "ask-2" {
		t.Fatalf("reissue changed pending order: %+v", questions)
	}
}
