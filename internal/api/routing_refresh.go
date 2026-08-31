package api

// handleActivityRefresh replays the attached session's cached activity
// snapshot frames (task then dag, the same prefix attach replay sends) to the
// REQUESTING websocket only. It never touches the provider subprocess and
// never broadcasts: sibling subscribers' streams are untouched.
func (s *Server) handleActivityRefresh(h *connHandler) {
	h.mu.Lock()
	sess := h.session
	h.mu.Unlock()
	if sess == nil {
		h.sendError("no_session", "create a chat session first")
		return
	}
	sess.ReplayActivitySnapshot(h)
}
