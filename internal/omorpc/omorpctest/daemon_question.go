package omorpctest

import (
	"fmt"
	"net"
	"strings"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

const questionIdleDuration = 30 * time.Minute

func questionIndex(rec *daemonSession, id string) int {
	for i, question := range rec.pendingQuestions {
		if question["id"] == id {
			return i
		}
	}
	return -1
}

func copyQuestion(question map[string]any) map[string]any {
	copy := make(map[string]any, len(question))
	for key, value := range question {
		copy[key] = value
	}
	return copy
}

// applyQuestionEventLocked keeps scripted and directly injected question
// events in the same authoritative state returned by open_session/get_state.
// Callers hold d.mu.
func applyQuestionEventLocked(rec *daemonSession, event map[string]any) {
	id, _ := event["id"].(string)
	if id == "" {
		return
	}
	switch event["type"] {
	case "extension_ui_request":
		if event["method"] != "question" {
			if rec.otherApprovalIDs == nil {
				rec.otherApprovalIDs = make(map[string]struct{})
			}
			rec.otherApprovalIDs[id] = struct{}{}
			return
		}
		question := make(map[string]any)
		for _, key := range []string{"id", "requestId", "questions", "deadlineAtMs", "remainingMs", "waitForAnswer", "askedAtMs"} {
			if value, ok := event[key]; ok {
				question[key] = value
			}
		}
		index := questionIndex(rec, id)
		if index < 0 {
			if requestID, _ := event["requestId"].(string); requestID != "" {
				for i, pending := range rec.pendingQuestions {
					if pending["requestId"] == requestID {
						index = i
						break
					}
				}
			}
		}
		if index < 0 {
			rec.pendingQuestions = append(rec.pendingQuestions, question)
		} else {
			rec.pendingQuestions[index] = question
		}
	case "question_resolved":
		if index := questionIndex(rec, id); index >= 0 {
			rec.pendingQuestions = append(rec.pendingQuestions[:index], rec.pendingQuestions[index+1:]...)
		}
	case "question_updated":
		if index := questionIndex(rec, id); index >= 0 {
			updated := copyQuestion(rec.pendingQuestions[index])
			for _, key := range []string{"deadlineAtMs", "remainingMs"} {
				if value, ok := event[key]; ok {
					updated[key] = value
				}
			}
			rec.pendingQuestions[index] = updated
		}
	}
}

func pendingQuestionsLocked(rec *daemonSession) []any {
	questions := make([]any, 0, len(rec.pendingQuestions))
	for _, question := range rec.pendingQuestions {
		questions = append(questions, copyQuestion(question))
	}
	return questions
}

// reaskQuestionsLocked mimics the host's new bridge ids after a full restart
// while preserving the tool's stable requestId and the pending order.
func (d *Daemon) reaskQuestionsLocked(rec *daemonSession) []map[string]any {
	if !rec.reaskQuestions {
		return nil
	}
	rec.reaskQuestions = false
	events := make([]map[string]any, 0, len(rec.pendingQuestions))
	for i, question := range rec.pendingQuestions {
		d.questionCounter++
		updated := copyQuestion(question)
		updated["id"] = fmt.Sprintf("question-%d", d.questionCounter)
		rec.pendingQuestions[i] = updated
		event := copyQuestion(updated)
		event["type"] = "extension_ui_request"
		event["method"] = "question"
		event["sessionId"] = rec.rpcID
		events = append(events, event)
	}
	return events
}

func (d *Daemon) handleQuestionResponse(conn net.Conn, rec *daemonSession, req map[string]any) {
	id, _ := req["id"].(string)
	d.mu.Lock()
	if _, otherApproval := rec.otherApprovalIDs[id]; otherApproval {
		d.mu.Unlock()
		return
	}
	index := questionIndex(rec, id)
	drop := index >= 0 && d.dropQuestionResponse
	if drop {
		d.dropQuestionResponse = false
		d.notify(d.questionDropFeed)
	}
	if index >= 0 && !drop {
		answers, _ := req["answers"].(map[string]any)
		comment, _ := req["comment"].(string)
		if len(answers) > 0 || strings.TrimSpace(comment) != "" || req["cancelled"] == true {
			rec.pendingQuestions = append(rec.pendingQuestions[:index], rec.pendingQuestions[index+1:]...)
		}
	}
	sid := rec.rpcID
	d.mu.Unlock()
	if drop {
		return
	}
	if index < 0 {
		d.write(conn, map[string]any{
			"id": id, "type": "response", "command": omorpc.CmdExtensionUIResponse,
			"sessionId": sid, "success": false, "error": "question_already_resolved",
		})
		return
	}
	answers, _ := req["answers"].(map[string]any)
	comment, _ := req["comment"].(string)
	outcome := "answered"
	switch {
	case req["cancelled"] == true:
		outcome = "cancelled"
	case len(answers) == 0 && strings.TrimSpace(comment) == "":
		d.write(conn, map[string]any{
			"id": id, "type": "response", "command": omorpc.CmdExtensionUIResponse,
			"sessionId": sid, "success": false, "error": "question_incomplete",
		})
		return
	case len(answers) == 0:
		outcome = "comment-submitted"
	}
	d.write(conn, map[string]any{"type": "question_resolved", "sessionId": sid, "id": id, "outcome": outcome})
}

func (d *Daemon) handleQuestionProgress(conn net.Conn, rec *daemonSession, req map[string]any) {
	id, _ := req["id"].(string)
	d.mu.Lock()
	index := questionIndex(rec, id)
	sid := rec.rpcID
	if index >= 0 {
		deadline := time.Now().Add(questionIdleDuration).UnixMilli()
		updated := copyQuestion(rec.pendingQuestions[index])
		updated["deadlineAtMs"] = deadline
		updated["remainingMs"] = questionIdleDuration.Milliseconds()
		rec.pendingQuestions[index] = updated
		d.mu.Unlock()
		d.write(conn, map[string]any{
			"type": "question_updated", "sessionId": sid, "id": id,
			"deadlineAtMs": deadline, "remainingMs": questionIdleDuration.Milliseconds(),
		})
		return
	}
	d.mu.Unlock()
}

// DropNextQuestionResponse simulates a lost provider reply/event while
// leaving the question pending for recovery or a later re-ask.
func (d *Daemon) DropNextQuestionResponse() {
	d.mu.Lock()
	d.dropQuestionResponse = true
	d.mu.Unlock()
}

// AwaitQuestionResponseDrop observes consumption of the armed drop, not
// merely receipt of a request on the daemon's connection.
func (d *Daemon) AwaitQuestionResponseDrop(timeout time.Duration) bool {
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-d.questionDropFeed:
		return true
	case <-timer.C:
		return false
	}
}

// ResolveQuestionSilently models a question that closed while its client was
// disconnected. The next open_session snapshot is the authoritative signal.
func (d *Daemon) ResolveQuestionSilently(path, id string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if rec := d.registry[path]; rec != nil {
		if index := questionIndex(rec, id); index >= 0 {
			rec.pendingQuestions = append(rec.pendingQuestions[:index], rec.pendingQuestions[index+1:]...)
		}
	}
}

// ExpireQuestionsAt advances the fixture's idle deadline without sleeping.
// Only questions whose currently recorded deadline has elapsed are resolved.
func (d *Daemon) ExpireQuestionsAt(now time.Time) {
	d.mu.Lock()
	var expired []struct{ path, id string }
	for path, rec := range d.registry {
		for _, question := range rec.pendingQuestions {
			var deadline int64
			switch value := question["deadlineAtMs"].(type) {
			case int64:
				deadline = value
			case float64:
				deadline = int64(value)
			}
			if deadline > 0 && deadline <= now.UnixMilli() {
				expired = append(expired, struct{ path, id string }{path: path, id: question["id"].(string)})
			}
		}
	}
	d.mu.Unlock()
	for _, question := range expired {
		d.EmitSession(question.path, map[string]any{
			"type": "question_resolved", "id": question.id, "outcome": "timed_out",
		})
	}
}
