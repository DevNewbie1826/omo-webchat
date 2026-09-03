package api

import (
	"errors"
	"net/http"

	"github.com/DevNewbie1826/omo-webchat/internal/cursorstore"
	"github.com/DevNewbie1826/omo-webchat/internal/session"
)

type chatGoalResponse struct {
	Goal *session.GoalState `json:"goal"`
}

// handleGetChatGoal serves the live goal state for one catalog chat. It is
// protected, catalog-scoped, and confined exactly like the stage-12 activity
// reader: the chat must belong to the workspace and its cwd must resolve
// inside the workspace. The goal document itself lives in the coding agent
// dir keyed by the encoded cwd and the chat's durable session id (layout
// verified by live protocol probing), so the raw chat cwd is what gets
// encoded — matching the path the engine wrote.
func (s *Server) handleGetChatGoal(w http.ResponseWriter, r *http.Request) {
	workspace, err := s.cursors.GetWorkspace(r.PathValue("wsId"))
	if err != nil {
		s.writeStoreError(w, err)
		return
	}
	chat, err := s.cursors.GetChat(r.PathValue("chatId"))
	if err != nil || chat.WorkspaceID != workspace.ID {
		s.writeStoreError(w, cursorstore.ErrNotFound)
		return
	}
	if _, err := validatedChatCWD(workspace.Path, chat.CWD); err != nil {
		s.logger.Warn("rejecting unconfined chat goal lookup", "chat_id", chat.ID, "err", err)
		s.writeStoreError(w, cursorstore.ErrNotFound)
		return
	}
	goal, err := session.ReadGoalState(r.Context(), session.CodingAgentDir(), chat.CWD, chat.DurableSessionID)
	if err != nil {
		if errors.Is(err, r.Context().Err()) {
			return
		}
		s.logger.Error("reading chat goal state failed", "chat_id", chat.ID, "err", err)
		writeError(w, http.StatusInternalServerError, "internal server error")
		return
	}
	writeJSON(w, http.StatusOK, chatGoalResponse{Goal: goal})
}
