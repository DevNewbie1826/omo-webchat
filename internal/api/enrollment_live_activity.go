package api

import (
	"context"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/rpcwatch"
	"github.com/DevNewbie1826/omo-webchat/internal/session"
)

// Disk I/O runs on the watcher goroutine, never under the manager mutex.
func (s *Server) applyEnrollmentLive(ctx context.Context, snapshot []rpcwatch.Session) {
	if s.manager == nil {
		return
	}
	bound := make(map[string]bool)
	for _, row := range s.manager.LiveSummaries() {
		if row.BindingID != "" {
			bound[row.ChatID], bound[row.DurableSessionID] = true, true
		}
	}
	sessions := make([]session.DaemonSession, 0, len(snapshot))
	for _, live := range snapshot {
		s.chatLifecycleMu.Lock()
		chat, resolved := s.cursors.ChatForDurable(live.DurableSessionID)
		eligible := resolved && !s.chatDeleting[chat.ID] && !s.cursors.EnrollmentDeleted(live.DurableSessionID)
		s.chatLifecycleMu.Unlock()
		if !eligible {
			continue
		}
		next := session.DaemonSession{DurableSessionID: live.DurableSessionID, Status: live.Status}
		if !bound[chat.ID] && !bound[live.DurableSessionID] {
			readCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
			activity, err := session.ReadHistoricalActivity(readCtx, chat.CWD, live.DurableSessionID)
			cancel()
			if err == nil {
				next.Activity = &activity
			} else {
				s.logger.Debug("reading daemon activity", "durable", live.DurableSessionID, "err", err)
			}
		}
		sessions = append(sessions, next)
	}
	if ctx.Err() == nil {
		s.manager.ApplyDaemonSessions(sessions)
	}
}
