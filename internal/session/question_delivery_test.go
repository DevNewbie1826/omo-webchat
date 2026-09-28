package session

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc/omorpctest"
	"github.com/DevNewbie1826/omo-webchat/internal/wscontract"
)

func questionHarness(t *testing.T, chatID string) (*Session, *recorder, *omorpctest.Daemon) {
	t.Helper()
	d := newDaemon(t)
	mgr := testManager(t, dial(t, d), newMemStore(), 64)
	sub := newRecorder(64)
	s, _, detach := acquire(t, mgr, testChat{id: chatID, cwd: t.TempDir()}, sub)
	t.Cleanup(detach)
	sub.await(t, FrameReady)
	return s, sub, d
}

func askQuestion(t *testing.T, d *omorpctest.Daemon, s *Session, sub *recorder, id, requestID string, wait bool) {
	t.Helper()
	d.EmitSession(s.SessionFile(), map[string]any{
		"type": "extension_ui_request", "method": "question", "id": id,
		"requestId": requestID, "waitForAnswer": wait,
		"questions": []any{map[string]any{"id": "q1", "header": "Stack"}},
	})
	sub.await(t, FrameApproval)
}

func TestQuestionWaitForAnswerMapsBothValues(t *testing.T) {
	s, sub := acquireDrained(t, "question-wait-mapping")
	for _, tc := range []struct {
		id, requestID string
		wait          bool
	}{
		{"blocking", "tool-1", true},
		{"nonblocking", "tool-2", false},
	} {
		injectEvent(t, s, map[string]any{
			"type": "extension_ui_request", "method": "question", "id": tc.id,
			"requestId": tc.requestID, "waitForAnswer": tc.wait,
		})
		_, frame := sub.await(t, FrameApproval)
		if frame.Data.(map[string]any)["nonBlocking"] != !tc.wait {
			t.Fatalf("waitForAnswer=%v approval=%+v", tc.wait, frame)
		}
	}
}

func TestQuestionResolvedAfterWriteClosesWithoutExpiredMessage(t *testing.T) {
	for _, outcome := range []string{"answered", "comment-submitted"} {
		t.Run(outcome, func(t *testing.T) {
			s, sub, d := questionHarness(t, "resolved-after-"+outcome)
			askQuestion(t, d, s, sub, "ask", "tool-call", true)
			d.DropNextQuestionResponse()
			comment := "hello"
			if err := s.RespondApprovalFrame(context.Background(), wscontract.ApprovalRespondFrame{
				ID: "ask", Comment: &comment,
			}); err != nil {
				t.Fatal(err)
			}
			_, sending := sub.await(t, FrameApproval)
			if sending.Data.(map[string]any)["delivery"] != "sending" ||
				sending.Data.(map[string]any)["submittedAnswer"] == nil {
				t.Fatalf("write was not retained for confirmation: %+v", sending)
			}
			sub.await(t, FrameAck)
			if !d.AwaitQuestionResponseDrop(5 * time.Second) {
				t.Fatal("engine did not consume the dropped reply")
			}
			if s.pendingByID("ask") == nil {
				t.Fatal("write retired the question before engine confirmation")
			}
			injectEvent(t, s, map[string]any{"type": "question_resolved", "id": "ask", "outcome": outcome})
			_, resolved := sub.await(t, FrameApprovalResolved)
			if data := resolved.Data.(map[string]any); data["outcome"] != outcome || data["message"] != nil {
				t.Fatalf("confirmed answer reported as expiry: %+v", data)
			}
			if s.pendingByID("ask") != nil {
				t.Fatal("confirmed question remains pending")
			}
		})
	}
}

func TestQuestionSecondSendWhileDeliveringRefusesDuplicate(t *testing.T) {
	s, sub, d := questionHarness(t, "question-second-send")
	askQuestion(t, d, s, sub, "ask", "tool-call", true)
	d.DropNextQuestionResponse()
	response := wscontract.ApprovalRespondFrame{ID: "ask"}
	if err := s.RespondApprovalFrame(context.Background(), response); err != nil {
		t.Fatal(err)
	}
	sub.await(t, FrameApproval)
	sub.await(t, FrameAck)
	if !d.AwaitQuestionResponseDrop(5 * time.Second) {
		t.Fatal("engine did not consume the dropped reply")
	}
	if err := s.RespondApprovalFrame(context.Background(), response); !errors.Is(err, errQuestionDelivering) {
		t.Fatalf("duplicate response err=%v", err)
	}
}

func TestQuestionIncompleteRestoresSubmittedDraft(t *testing.T) {
	s, sub, d := questionHarness(t, "question-incomplete")
	askQuestion(t, d, s, sub, "ask", "tool-call", true)
	d.DropNextQuestionResponse()
	text := "custom"
	answers := map[string]wscontract.QuestionAnswer{"q1": {Text: &text}}
	if err := s.RespondApprovalFrame(context.Background(), wscontract.ApprovalRespondFrame{ID: "ask", Answers: &answers}); err != nil {
		t.Fatal(err)
	}
	sub.await(t, FrameApproval)
	sub.await(t, FrameAck)
	if !d.AwaitQuestionResponseDrop(5 * time.Second) {
		t.Fatal("engine did not consume the dropped reply")
	}
	wireAnswer := d.LastRequest(omorpc.CmdExtensionUIResponse)["answers"].(map[string]any)["q1"].(map[string]any)
	if selected, ok := wireAnswer["selected"].([]any); !ok || len(selected) != 0 || wireAnswer["text"] != text {
		t.Fatalf("text-only answer missing selected:[] on engine wire: %+v", wireAnswer)
	}
	injectEvent(t, s, map[string]any{"type": "response", "command": "extension_ui_response",
		"id": "ask", "success": false, "error": "question_incomplete"})
	_, failed := sub.await(t, FrameApproval)
	data := failed.Data.(map[string]any)
	if data["delivery"] != "failed" || data["deliveryError"] != "question_incomplete" ||
		data["submittedAnswer"] == nil || s.pendingByID("ask") == nil {
		t.Fatalf("incomplete response lost the draft: %+v", data)
	}
}

func TestQuestionAlreadyResolvedAfterOwnWriteSucceeds(t *testing.T) {
	s, sub, d := questionHarness(t, "question-already-resolved")
	askQuestion(t, d, s, sub, "ask", "tool-call", true)
	d.DropNextQuestionResponse()
	if err := s.RespondApprovalFrame(context.Background(), wscontract.ApprovalRespondFrame{ID: "ask"}); err != nil {
		t.Fatal(err)
	}
	sub.await(t, FrameApproval)
	sub.await(t, FrameAck)
	if !d.AwaitQuestionResponseDrop(5 * time.Second) {
		t.Fatal("engine did not consume the dropped reply")
	}
	injectEvent(t, s, map[string]any{"type": "response", "command": "extension_ui_response",
		"id": "ask", "success": false, "error": "question_already_resolved"})
	_, resolved := sub.await(t, FrameApprovalResolved)
	if data := resolved.Data.(map[string]any); data["outcome"] != "answered" || data["message"] != nil {
		t.Fatalf("own already-resolved write was not accepted: %+v", data)
	}
}

func TestQuestionAlreadyResolvedWithoutOwnWriteReportsClosure(t *testing.T) {
	s, sub, d := questionHarness(t, "question-foreign-resolution")
	askQuestion(t, d, s, sub, "ask", "tool-call", true)
	injectEvent(t, s, map[string]any{"type": "response", "command": "extension_ui_response",
		"id": "ask", "success": false, "error": "question_already_resolved"})
	_, resolved := sub.await(t, FrameApprovalResolved)
	if data := resolved.Data.(map[string]any); data["outcome"] != "already_resolved" {
		t.Fatalf("unowned resolution was reported as accepted: %+v", data)
	}
}

func TestQuestionConfirmTimeoutRestoresAndLateResolutionCloses(t *testing.T) {
	oldAfter := questionAfterFunc
	var confirm func()
	var timers []*time.Timer
	questionAfterFunc = func(_ time.Duration, callback func()) *time.Timer {
		if confirm == nil {
			confirm = callback
		}
		timer := time.NewTimer(time.Hour)
		timers = append(timers, timer)
		return timer
	}
	t.Cleanup(func() {
		questionAfterFunc = oldAfter
		for _, timer := range timers {
			timer.Stop()
		}
	})
	s, sub, d := questionHarness(t, "question-confirm-timeout")
	askQuestion(t, d, s, sub, "ask", "tool-call", true)
	d.DropNextQuestionResponse()
	if err := s.RespondApprovalFrame(context.Background(), wscontract.ApprovalRespondFrame{ID: "ask"}); err != nil {
		t.Fatal(err)
	}
	sub.await(t, FrameApproval)
	sub.await(t, FrameAck)
	if !d.AwaitQuestionResponseDrop(5 * time.Second) {
		t.Fatal("engine did not consume the dropped reply")
	}
	if confirm == nil {
		t.Fatal("confirm timer was not armed")
	}
	confirm()
	_, failed := sub.await(t, FrameApproval)
	if data := failed.Data.(map[string]any); data["delivery"] != "failed" || data["deliveryError"] != "unconfirmed" {
		t.Fatalf("confirm timeout lost question: %+v", data)
	}
	injectEvent(t, s, map[string]any{"type": "question_resolved", "id": "ask", "outcome": "answered"})
	_, resolved := sub.await(t, FrameApprovalResolved)
	if resolved.Data.(map[string]any)["outcome"] != "answered" {
		t.Fatalf("late resolution ignored: %+v", resolved)
	}
}

func TestQuestionsReplayInArrivalOrderAndUpdateOlder(t *testing.T) {
	s, sub, d := questionHarness(t, "question-ordered-replay")
	askQuestion(t, d, s, sub, "first", "tool-first", true)
	askQuestion(t, d, s, sub, "second", "tool-second", false)
	injectEvent(t, s, map[string]any{"type": "question_updated", "id": "first", "remainingMs": 4200})
	_, updated := sub.await(t, FrameApproval)
	if updated.ApprovalID != "first" || updated.Data.(map[string]any)["remainingMs"] != float64(4200) {
		t.Fatalf("older question update lost: %+v", updated)
	}
	late := &synchronousApprovalRecorder{recorder: newQuestionRecorder(32)}
	t.Cleanup(s.Attach(late))
	var got []string
	var snapshot []string
	for _, frame := range drainSync(late.recorder) {
		switch frame.Kind {
		case FrameApproval:
			got = append(got, frame.ApprovalID)
		case FrameQuestionsSnapshot:
			snapshot = frame.Data.(map[string]any)["ids"].([]string)
		}
	}
	if !reflect.DeepEqual(got, []string{"first", "second"}) ||
		!reflect.DeepEqual(snapshot, []string{"tool-first", "tool-second"}) {
		t.Fatalf("ordered replay=%v snapshot=%v", got, snapshot)
	}
}

func TestQuestionProgressCoalescesLatestDraft(t *testing.T) {
	oldAfter := questionAfterFunc
	var fire func()
	var timers []*time.Timer
	questionAfterFunc = func(interval time.Duration, callback func()) *time.Timer {
		if interval != questionProgressInterval {
			t.Fatalf("progress interval=%v", interval)
		}
		fire = callback
		timer := time.NewTimer(time.Hour)
		timers = append(timers, timer)
		return timer
	}
	t.Cleanup(func() {
		questionAfterFunc = oldAfter
		for _, timer := range timers {
			timer.Stop()
		}
	})
	d := newDaemon(t)
	mgr := testManager(t, dial(t, d), newMemStore(), 64)
	sub := newRecorder(32)
	s, _, detach := acquire(t, mgr, testChat{id: "question-progress", cwd: t.TempDir()}, sub)
	t.Cleanup(detach)
	sub.await(t, FrameReady)
	askQuestion(t, d, s, sub, "ask", "tool-call", true)
	for _, draft := range []string{"a", "ab", "abc", "abcd"} {
		s.ProgressApproval(context.Background(), wscontract.ApprovalProgressFrame{ID: "ask", Comment: &draft})
	}
	if fire == nil {
		t.Fatal("progress timer not armed")
	}
	fire()
	if !d.AwaitRequestCount(omorpc.CmdExtensionUIProgress, 1, 5*time.Second) {
		t.Fatal("latest progress not delivered")
	}
	if got := d.LastRequest(omorpc.CmdExtensionUIProgress); got["comment"] != "abcd" || got["sessionId"] != s.RoutingID() {
		t.Fatalf("coalesced draft=%v", got)
	}
	final := "abcde"
	text := "custom"
	answers := map[string]wscontract.QuestionAnswer{"q1": {Text: &text}}
	s.ProgressApproval(context.Background(), wscontract.ApprovalProgressFrame{ID: "ask", Comment: &final, Answers: &answers})
	fire()
	if !d.AwaitRequestCount(omorpc.CmdExtensionUIProgress, 2, 5*time.Second) {
		t.Fatal("second trailing progress not delivered")
	}
	if got := d.LastRequest(omorpc.CmdExtensionUIProgress); got["comment"] != final {
		t.Fatalf("second draft=%v", got)
	} else if answer := got["answers"].(map[string]any)["q1"].(map[string]any); answer["text"] != text {
		t.Fatalf("progress omitted custom text: %v", answer)
	} else if selected, ok := answer["selected"].([]any); !ok || len(selected) != 0 {
		t.Fatalf("progress omitted selected:[]: %v", answer)
	}
	if count := d.RequestCount(omorpc.CmdExtensionUIProgress); count != 2 {
		t.Fatalf("multiple progress notifications: %d", count)
	}
	s.ProgressApproval(context.Background(), wscontract.ApprovalProgressFrame{ID: "absent"})
	if count := d.RequestCount(omorpc.CmdExtensionUIProgress); count != 2 {
		t.Fatalf("unknown question forwarded progress: %d", count)
	}
}

func TestQuestionReplacementUsesEngineCurrentIDAndKeepsUnconfirmedDraft(t *testing.T) {
	prior, sub, d := questionHarness(t, "question-replacement")
	askQuestion(t, d, prior, sub, "old-dialog", "stable-tool", true)
	d.DropNextQuestionResponse()
	comment := "draft before disconnect"
	if err := prior.RespondApprovalFrame(context.Background(), wscontract.ApprovalRespondFrame{
		ID: "old-dialog", Comment: &comment,
	}); err != nil {
		t.Fatal(err)
	}
	sub.await(t, FrameApproval)
	sub.await(t, FrameAck)
	if !d.AwaitQuestionResponseDrop(5 * time.Second) {
		t.Fatal("engine did not consume the dropped reply")
	}
	prior.lifecycleMu.Lock()
	prior.markProviderUnloadedLocked()
	prior.lifecycleMu.Unlock()
	_, failed := sub.await(t, FrameApproval)
	if failed.Data.(map[string]any)["deliveryError"] != "unconfirmed" {
		t.Fatalf("disconnect retired an unconfirmed answer: %+v", failed)
	}

	replacement := newSession(prior.manager, prior.chatID, prior.cwd,
		omorpc.OpenSessionData{SessionID: "new-route", State: omorpc.SessionState{
			SessionID: prior.ID(), SessionFile: prior.SessionFile(),
			PendingQuestions: []omorpc.PendingQuestion{{ID: "new-dialog", RequestID: "stable-tool"}},
		}}, true, prior.epoch)
	replacement.inheritQuestions(prior, omorpc.SessionState{
		PendingQuestions: []omorpc.PendingQuestion{{ID: "new-dialog", RequestID: "stable-tool"}},
	})
	pending := replacement.pendingByID("new-dialog")
	if pending == nil || replacement.pendingByID("old-dialog") != nil {
		t.Fatalf("replacement still targets the stale engine id: %+v", replacement.pendingApprovals)
	}
	data := pending.frame.Data.(map[string]any)
	if data["delivery"] != "failed" || data["deliveryError"] != "unconfirmed" ||
		data["submittedAnswer"].(map[string]any)["comment"] != comment {
		t.Fatalf("replacement did not retain answer: %+v", data)
	}
	replacement.lifecycleMu.Lock()
	replacement.publishLocked(Frame{Kind: FrameReady, SessionID: replacement.ID()})
	replacement.lifecycleMu.Unlock()
	late := &synchronousApprovalRecorder{recorder: newRecorder(32)}
	t.Cleanup(replacement.Attach(late))
	if frames := drainSync(late.recorder); !hasApproval(frames, "new-dialog") || hasApproval(frames, "old-dialog") {
		t.Fatalf("replacement replay omitted the current id: %+v", frames)
	}
}

func TestQuestionClosedWhileDisconnectedReplaysJournalAndEmptySnapshot(t *testing.T) {
	prior, sub, d := questionHarness(t, "question-closed-disconnected")
	askQuestion(t, d, prior, sub, "old-dialog", "stable-tool", true)
	prior.lifecycleMu.Lock()
	prior.markProviderUnloadedLocked()
	prior.lifecycleMu.Unlock()
	replacement := newSession(prior.manager, prior.chatID, prior.cwd,
		omorpc.OpenSessionData{SessionID: "new-route", State: omorpc.SessionState{
			SessionID: prior.ID(), SessionFile: prior.SessionFile(),
		}}, true, prior.epoch)
	replacement.inheritQuestions(prior, omorpc.SessionState{})
	replacement.lifecycleMu.Lock()
	replacement.publishLocked(Frame{Kind: FrameReady, SessionID: replacement.ID()})
	replacement.lifecycleMu.Unlock()
	late := &synchronousApprovalRecorder{recorder: newQuestionRecorder(32)}
	t.Cleanup(replacement.Attach(late))
	foundNotice, foundSnapshot := false, false
	for _, frame := range drainSync(late.recorder) {
		switch frame.Kind {
		case FrameNotice:
			if data := frame.Data.(map[string]any); data["kind"] == "question_closed_while_disconnected" &&
				data["requestId"] == "stable-tool" {
				foundNotice = true
			}
		case FrameQuestionsSnapshot:
			if ids := frame.Data.(map[string]any)["ids"].([]string); len(ids) == 0 {
				foundSnapshot = true
			}
		}
	}
	if !foundNotice || !foundSnapshot {
		t.Fatalf("closed question not reconciled: notice=%v snapshot=%v", foundNotice, foundSnapshot)
	}
}

func TestQuestionReaskWithSameRequestReplacesIDInPlace(t *testing.T) {
	s, sub, d := questionHarness(t, "question-reask")
	askQuestion(t, d, s, sub, "old", "stable-tool", true)
	askQuestion(t, d, s, sub, "other", "other-tool", true)
	askQuestion(t, d, s, sub, "new", "stable-tool", true)
	if s.pendingByID("old") != nil || s.pendingByID("new") == nil ||
		len(s.pendingApprovals) != 2 || s.pendingApprovals[0].frame.ApprovalID != "new" {
		t.Fatalf("reask discarded order or kept stale id: %+v", s.pendingApprovals)
	}
}

func TestQuestionColdOpenSeedsAuthoritativePendingSnapshot(t *testing.T) {
	prior, _, _ := questionHarness(t, "question-cold-open")
	state := omorpc.SessionState{SessionID: prior.ID(), SessionFile: prior.SessionFile(),
		PendingQuestions: []omorpc.PendingQuestion{{ID: "engine-dialog", RequestID: "tool-call"}}}
	cold := newSession(prior.manager, prior.chatID, prior.cwd,
		omorpc.OpenSessionData{SessionID: "cold-route", State: state}, true, prior.epoch)
	cold.inheritQuestions(nil, state)
	late := &synchronousApprovalRecorder{recorder: newQuestionRecorder(32)}
	t.Cleanup(cold.Attach(late))
	if initial := drainSync(late.recorder); len(initial) != 0 {
		t.Fatalf("questions preceded ready: %+v", initial)
	}
	cold.lifecycleMu.Lock()
	cold.publishLocked(Frame{Kind: FrameReady, SessionID: cold.ID()})
	cold.lifecycleMu.Unlock()
	first, second, third := late.next(t), late.next(t), late.next(t)
	if first.Kind != FrameReady || second.ApprovalID != "engine-dialog" || third.Kind != FrameQuestionsSnapshot {
		t.Fatalf("cold open replay order = %+v, %+v, %+v", first, second, third)
	}
}

func TestQuestionProviderLossKeepsPendingAndRestoresDelivering(t *testing.T) {
	s, sub, d := questionHarness(t, "question-provider-loss")
	askQuestion(t, d, s, sub, "pending", "tool-pending", true)
	askQuestion(t, d, s, sub, "delivering", "tool-delivering", true)
	d.DropNextQuestionResponse()
	comment := "keep my answer"
	if err := s.RespondApprovalFrame(context.Background(), wscontract.ApprovalRespondFrame{
		ID: "delivering", Comment: &comment,
	}); err != nil {
		t.Fatal(err)
	}
	sub.await(t, FrameApproval)
	sub.await(t, FrameAck)
	if !d.AwaitQuestionResponseDrop(5 * time.Second) {
		t.Fatal("engine did not consume the dropped reply")
	}
	s.lifecycleMu.Lock()
	s.markProviderUnloadedLocked()
	s.lifecycleMu.Unlock()
	_, failed := sub.await(t, FrameApproval)
	if failed.ApprovalID != "delivering" || failed.Data.(map[string]any)["deliveryError"] != "unconfirmed" {
		t.Fatalf("provider loss retired delivering question: %+v", failed)
	}
	pending := s.pendingByID("pending")
	if pending == nil || pending.frame.Data.(map[string]any)["delivery"] != nil {
		t.Fatalf("provider loss retired untouched question: %+v", pending)
	}
}

func TestFailedQuestionProgressDoesNotChangeQuestionState(t *testing.T) {
	s, sub, d := questionHarness(t, "question-progress-failure")
	askQuestion(t, d, s, sub, "ask", "tool-call", true)
	injectEvent(t, s, map[string]any{"type": "response", "command": "extension_ui_progress",
		"id": "ask", "success": false, "error": "question_not_found"})
	if pending := s.pendingByID("ask"); pending == nil || pending.frame.Data.(map[string]any)["delivery"] != nil {
		t.Fatalf("progress failure changed the question: %+v", pending)
	}
}

func TestQuestionDroppedResponseReacquiresNewIDAndResends(t *testing.T) {
	oldAfter := questionAfterFunc
	var confirm func()
	var timers []*time.Timer
	questionAfterFunc = func(_ time.Duration, callback func()) *time.Timer {
		if confirm == nil {
			confirm = callback
		}
		timer := time.NewTimer(time.Hour)
		timers = append(timers, timer)
		return timer
	}
	t.Cleanup(func() {
		questionAfterFunc = oldAfter
		for _, timer := range timers {
			timer.Stop()
		}
	})
	prior, sub, d := questionHarness(t, "question-manager-replacement")
	chat := testChat{id: prior.ChatID(), cwd: prior.cwd}
	askQuestion(t, d, prior, sub, "old-dialog", "stable-tool", true)
	comment := "persist across replacement"
	d.DropNextQuestionResponse()
	if err := prior.RespondApprovalFrame(context.Background(), wscontract.ApprovalRespondFrame{ID: "old-dialog", Comment: &comment}); err != nil {
		t.Fatal(err)
	}
	sub.await(t, FrameApproval)
	sub.await(t, FrameAck)
	if !d.AwaitQuestionResponseDrop(5 * time.Second) {
		t.Fatal("engine did not consume the intentionally dropped reply")
	}
	confirm()
	_, failed := sub.await(t, FrameApproval)
	if failed.Data.(map[string]any)["deliveryError"] != "unconfirmed" {
		t.Fatalf("dropped response not marked unconfirmed: %+v", failed)
	}

	d.EvictSessionWithEvent(prior.SessionFile(), "session_unloaded")
	_, oldEvents := prior.client.CurrentEpoch()
	d.Restart()
	timeout := time.After(testTimeout)
waitForEpochLoss:
	for {
		select {
		case _, ok := <-oldEvents:
			if !ok {
				break waitForEpochLoss
			}
		case <-timeout:
			t.Fatal("old epoch did not close")
		}
	}
	replacement, started, detach := acquire(t, prior.manager, chat, nil)
	t.Cleanup(detach)
	if !started || replacement == prior {
		t.Fatal("transport loss did not replace the Session")
	}
	late := &synchronousApprovalRecorder{recorder: newRecorder(64)}
	t.Cleanup(replacement.Attach(late))
	frames := drainSync(late.recorder)
	var newID string
	for _, frame := range frames {
		if frame.Kind == FrameApproval && frame.RequestID == "stable-tool" {
			newID = frame.ApprovalID
			data := frame.Data.(map[string]any)
			if data["delivery"] != "failed" || data["submittedAnswer"].(map[string]any)["comment"] != comment {
				t.Fatalf("replay lost failed answer: %+v", data)
			}
		}
	}
	if newID == "" || newID == "old-dialog" {
		t.Fatalf("engine id was not renewed after restart: %q frames=%+v", newID, frames)
	}
	if err := replacement.RespondApprovalFrame(context.Background(), wscontract.ApprovalRespondFrame{ID: newID, Comment: &comment}); err != nil {
		t.Fatal(err)
	}
	if !d.AwaitRequestCount(omorpc.CmdExtensionUIResponse, 2, 5*time.Second) {
		t.Fatalf("resend did not reach engine: request=%v", d.LastRequest(omorpc.CmdExtensionUIResponse))
	}
	_, resolved := late.await(t, FrameApprovalResolved)
	if data := resolved.Data.(map[string]any); data["id"] != newID || data["outcome"] != "comment-submitted" {
		t.Fatalf("resend did not resolve the current dialog: %+v", resolved)
	}
}

func TestQuestionReacquireJournalsClosureWhenEngineHasNoPendingQuestion(t *testing.T) {
	prior, sub, d := questionHarness(t, "question-manager-closed")
	askQuestion(t, d, prior, sub, "old-dialog", "stable-tool", true)
	d.DropNextQuestionResponse()
	comment := "answer before disconnect"
	if err := prior.RespondApprovalFrame(context.Background(), wscontract.ApprovalRespondFrame{ID: "old-dialog", Comment: &comment}); err != nil {
		t.Fatal(err)
	}
	sub.await(t, FrameApproval)
	sub.await(t, FrameAck)
	if !d.AwaitQuestionResponseDrop(5 * time.Second) {
		t.Fatal("engine did not consume the dropped reply")
	}
	d.EvictSessionSilently(prior.SessionFile())
	prior.lifecycleMu.Lock()
	prior.markProviderUnloadedLocked()
	prior.lifecycleMu.Unlock()
	sub.await(t, FrameApproval)
	// The daemon's state changes without delivering a live resolution to the
	// stale route; reconciliation must create a durable notice on replacement.
	d.ResolveQuestionSilently(prior.SessionFile(), "old-dialog")
	replacement, started, detach := acquire(t, prior.manager,
		testChat{id: prior.ChatID(), cwd: prior.cwd}, nil)
	t.Cleanup(detach)
	if !started || replacement == prior {
		t.Fatal("provider unload did not replace the Session")
	}
	late := &synchronousApprovalRecorder{recorder: newQuestionRecorder(64)}
	t.Cleanup(replacement.Attach(late))
	var foundNotice, foundSnapshot bool
	for _, frame := range drainSync(late.recorder) {
		switch frame.Kind {
		case FrameNotice:
			if data := frame.Data.(map[string]any); data["kind"] == "question_closed_while_disconnected" &&
				data["requestId"] == "stable-tool" && data["hadSubmittedAnswer"] == true {
				foundNotice = true
			}
		case FrameQuestionsSnapshot:
			if ids := frame.Data.(map[string]any)["ids"].([]string); len(ids) == 0 {
				foundSnapshot = true
			}
		}
	}
	if !foundNotice || !foundSnapshot {
		t.Fatalf("attach after reconciliation lost notice=%v snapshot=%v", foundNotice, foundSnapshot)
	}
}
