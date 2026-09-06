package api

import (
	"net/http"

	"github.com/DevNewbie1826/omo-webchat/internal/cursorstore"
)

// handleTouchChat records explicit UI activation only. Binding, recovery and
// reconnect do not imply user intent, and this route never opens an engine.
func (s *Server) handleTouchChat(w http.ResponseWriter, r *http.Request) {
	s.chatLifecycleMu.Lock()
	defer s.chatLifecycleMu.Unlock()
	ws, err := s.cursors.GetWorkspace(r.PathValue("wsId"))
	if err != nil {
		s.writeStoreError(w, err)
		return
	}
	chat, err := s.cursors.GetChat(r.PathValue("chatId"))
	if err != nil || chat.WorkspaceID != ws.ID || !cursorstore.IsLaunchableProvider(chat.Provider) {
		s.writeStoreError(w, cursorstore.ErrNotFound)
		return
	}
	if s.chatDeleting[chat.ID] {
		writeError(w, http.StatusConflict, "chat deletion is already in progress")
		return
	}
	if err := s.cursors.TouchLastUsed(chat.ID); err != nil {
		s.writeStoreError(w, err)
		return
	}
	chat, err = s.cursors.GetChat(chat.ID)
	if err != nil {
		s.writeStoreError(w, err)
		return
	}
	recency := chatRecencyMs(chat)
	disk, _ := listDiskSessions(ws.Path)
	for _, sess := range disk {
		if sessionMatchesChat(sess, chat) {
			recency = max(recency, sess.RecencyMs)
		}
	}
	writeJSON(w, http.StatusOK, struct {
		RecencyMs int64 `json:"recencyMs"`
	}{recency})
}
