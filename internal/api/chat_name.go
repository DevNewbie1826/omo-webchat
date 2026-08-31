package api

import (
	"encoding/json"

	"github.com/DevNewbie1826/omo-webchat/internal/chat"
	"github.com/DevNewbie1826/omo-webchat/internal/store"
)

// autoTitleFromPrompt renames a still-default-named chat after a plain
// prompt: the derived title is persisted, announced to the attached client,
// and forwarded best-effort to the live provider session. Slash prompts and
// empty titles leave the record untouched, and every failure is dropped so it
// can never fail the chat.send path that called in.
func (s *Server) autoTitleFromPrompt(h *connHandler, prompt string) {
	title := chat.DeriveSessionTitle(prompt)
	if title == "" {
		return
	}
	h.mu.Lock()
	wsID, chatID := h.wsID, h.chatID
	h.mu.Unlock()
	record, err := s.store.GetChat(wsID, chatID)
	if err != nil {
		return
	}
	if store.NormalizeNameSource(record.NameSource) != "default" {
		return
	}
	if _, err := s.store.UpdateChat(wsID, chatID, func(c *store.Chat) {
		c.Name = title
		c.NameSource = "auto"
	}); err != nil {
		s.logger.Warn("auto-title persist failed", "err", err, "chatId", chatID)
		return
	}
	frame, _ := json.Marshal(chat.NameFrame{Type: "chat.name", SessionID: chatID, Name: title, Origin: "auto"})
	_ = h.WriteJSON(frame)
	if sess := s.chats.Get(chatID); sess != nil {
		_ = sess.SetSessionName(title)
	}
}
