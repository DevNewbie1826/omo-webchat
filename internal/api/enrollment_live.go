package api

import "github.com/DevNewbie1826/omo-webchat/internal/cursorstore"

func (s *Server) enrollmentLive(chat cursorstore.Chat) bool {
	if s.rpcWatcher == nil {
		return false
	}
	for _, live := range s.rpcWatcher.Sessions() {
		if !enrollmentMatches(chat, live) {
			continue
		}
		switch live.Status {
		case "idle", "working", "blocked", "done":
			return true
		}
	}
	return false
}
