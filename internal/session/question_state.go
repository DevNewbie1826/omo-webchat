package session

import (
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

var (
	questionConfirmTimeout = 30 * time.Second
	questionAfterFunc      = time.AfterFunc
)

type pendingApproval struct {
	frame         Frame
	confirmTimer  *time.Timer
	progressTimer *time.Timer
	progress      *omorpc.ExtensionUIProgress
	delivering    bool
	submitted     map[string]any
}

func (p *pendingApproval) question() bool {
	data, ok := p.frame.Data.(map[string]any)
	return ok && data["method"] == "question"
}

func (p *pendingApproval) key() string {
	if p.frame.RequestID != "" {
		return p.frame.RequestID
	}
	return p.frame.ApprovalID
}

func (p *pendingApproval) stopTimers() {
	if p.confirmTimer != nil {
		p.confirmTimer.Stop()
		p.confirmTimer = nil
	}
	if p.progressTimer != nil {
		p.progressTimer.Stop()
		p.progressTimer = nil
	}
	p.progress = nil
}

func (s *Session) pendingByID(id string) *pendingApproval {
	for _, pending := range s.pendingApprovals {
		if pending.frame.ApprovalID == id {
			return pending
		}
	}
	return nil
}

func (s *Session) upsertApprovalLocked(frame Frame) *pendingApproval {
	for _, pending := range s.pendingApprovals {
		if pending.frame.ApprovalID == frame.ApprovalID || (frame.RequestID != "" && pending.frame.RequestID == frame.RequestID) {
			pending.stopTimers()
			if pending.delivering {
				pending.delivering = false
				s.setQuestionDeliveryLocked(pending, "failed", "unconfirmed")
			}
			data := frame.Data.(map[string]any)
			old := pending.frame.Data.(map[string]any)
			if old["delivery"] != nil {
				data["delivery"] = old["delivery"]
				data["deliveryError"] = old["deliveryError"]
				data["submittedAnswer"] = old["submittedAnswer"]
			}
			pending.frame = frame
			return pending
		}
	}
	pending := &pendingApproval{frame: frame}
	s.pendingApprovals = append(s.pendingApprovals, pending)
	return pending
}

func (s *Session) removeApprovalLocked(id string) *pendingApproval {
	for i, pending := range s.pendingApprovals {
		if pending.frame.ApprovalID == id {
			pending.stopTimers()
			s.pendingApprovals = append(s.pendingApprovals[:i], s.pendingApprovals[i+1:]...)
			return pending
		}
	}
	return nil
}

func (s *Session) setQuestionDeliveryLocked(pending *pendingApproval, delivery, reason string) {
	data := cloneAnyMap(pending.frame.Data.(map[string]any))
	data["delivery"] = delivery
	if reason != "" {
		data["deliveryError"] = reason
	} else {
		delete(data, "deliveryError")
	}
	if pending.submitted != nil {
		data["submittedAnswer"] = pending.submitted
	}
	pending.frame.Data = data
	s.publishLocked(pending.frame)
}

func (s *Session) failQuestionsOnLossLocked() {
	for i := len(s.pendingApprovals) - 1; i >= 0; i-- {
		pending := s.pendingApprovals[i]
		if !pending.question() {
			s.resolveApprovalLocked(pending.frame.ApprovalID, "", "expired", errApprovalExpired.Error())
			continue
		}
		pending.stopTimers()
		if pending.delivering {
			pending.delivering = false
			s.setQuestionDeliveryLocked(pending, "failed", "unconfirmed")
		}
	}
}

func (s *Session) stopQuestionTimersLocked() {
	for _, pending := range s.pendingApprovals {
		pending.stopTimers()
	}
}

func (s *Session) questionReplayLocked() []Frame {
	frames := make([]Frame, 0, len(s.pendingApprovals)+1)
	ids := make([]string, 0)
	for _, pending := range s.pendingApprovals {
		frames = append(frames, pending.frame)
		if pending.question() {
			ids = append(ids, pending.key())
		}
	}
	return append(frames, Frame{Kind: FrameQuestionsSnapshot, SessionID: s.durableID, Data: map[string]any{"ids": ids}})
}

// A replacement Session reuses the old stable tool request but accepts only
// the engine's current dialog id. The engine may mint a new id on resume.
func (s *Session) inheritQuestions(prior *Session, state omorpc.SessionState) {
	if prior != nil && prior.durableID == s.durableID && prior.sessionFile == s.sessionFile && prior.cwd == s.cwd {
		s.reconcilePriorQuestions(prior, state)
	}
	for _, q := range state.PendingQuestions {
		if s.pendingByID(q.ID) != nil {
			continue
		}
		data := map[string]any{"id": q.ID, "method": "question", "requestId": q.RequestID,
			"questions": q.Questions, "deadlineAtMs": q.DeadlineAtMs, "remainingMs": q.RemainingMs}
		s.upsertApprovalLocked(Frame{Kind: FrameApproval, SessionID: s.durableID, ApprovalID: q.ID, RequestID: q.RequestID, Data: data})
	}
}

func (s *Session) reconcilePriorQuestions(prior *Session, state omorpc.SessionState) {
	prior.lifecycleMu.Lock()
	defer prior.lifecycleMu.Unlock()
	for _, old := range append([]*pendingApproval(nil), prior.pendingApprovals...) {
		if !old.question() {
			continue
		}
		var current *omorpc.PendingQuestion
		for i := range state.PendingQuestions {
			q := &state.PendingQuestions[i]
			if q.RequestID != "" && q.RequestID == old.frame.RequestID || q.RequestID == "" && q.ID == old.frame.ApprovalID {
				current = q
				break
			}
		}
		if current == nil {
			data := old.frame.Data.(map[string]any)
			headers := make([]string, 0)
			if questions, ok := data["questions"].([]any); ok {
				for _, item := range questions {
					if q, ok := item.(map[string]any); ok {
						if header, ok := q["header"].(string); ok {
							headers = append(headers, header)
						}
					}
				}
			}
			s.manager.PublishNotice(s.chatID, map[string]any{
				"kind": "question_closed_while_disconnected", "requestId": old.frame.RequestID,
				"id": old.frame.ApprovalID, "headers": headers, "hadSubmittedAnswer": old.submitted != nil,
			})
			prior.resolveApprovalLocked(old.frame.ApprovalID, "", "closed_while_disconnected", "")
			continue
		}
		data := cloneAnyMap(old.frame.Data.(map[string]any))
		data["id"] = current.ID
		data["requestId"] = current.RequestID
		data["questions"] = current.Questions
		data["deadlineAtMs"] = current.DeadlineAtMs
		data["remainingMs"] = current.RemainingMs
		pending := s.upsertApprovalLocked(Frame{Kind: FrameApproval, SessionID: s.durableID, ApprovalID: current.ID, RequestID: current.RequestID, Data: data})
		pending.submitted = old.submitted
		if old.delivering {
			s.setQuestionDeliveryLocked(pending, "failed", "unconfirmed")
		}
	}
}
