package session

import (
	"context"
	"log/slog"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/wscontract"
)

const questionProgressInterval = time.Second

// ProgressApproval sends the latest draft once per interval, with an initial
// trailing timer that is not reset by subsequent edits.
func (s *Session) ProgressApproval(_ context.Context, frame wscontract.ApprovalProgressFrame) {
	s.lifecycleMu.Lock()
	defer s.lifecycleMu.Unlock()
	pending := s.pendingByID(frame.ID)
	if pending == nil || !pending.question() || pending.delivering {
		return
	}
	pending.progress = &omorpc.ExtensionUIProgress{
		ID: frame.ID, Answers: omorpc.NormalizeQuestionAnswers(frame.Answers), Comment: frame.Comment,
	}
	if pending.progressTimer != nil {
		return
	}
	pending.progressTimer = questionAfterFunc(questionProgressInterval, func() {
		s.lifecycleMu.Lock()
		defer s.lifecycleMu.Unlock()
		if s.pendingByID(frame.ID) != pending || pending.delivering {
			return
		}
		pending.progressTimer = nil
		progress := pending.progress
		pending.progress = nil
		route, err := s.routeLocked()
		if err != nil || progress == nil {
			return
		}
		progress.SessionID = route
		if err := s.client.Notify(context.Background(), *progress); err != nil {
			slog.Warn("question draft progress not delivered", "error", err)
		}
	})
}
