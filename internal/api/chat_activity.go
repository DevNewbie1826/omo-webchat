package api

import (
	"encoding/json"
	"net/http"

	"github.com/DevNewbie1826/omo-webchat/internal/cursorstore"
	"github.com/DevNewbie1826/omo-webchat/internal/session"
)

type chatActivityHistoryResponse struct {
	Task          json.RawMessage `json:"task"`
	Dag           json.RawMessage `json:"dag"`
	TaskOversized bool            `json:"task_oversized"`
	DagOversized  bool            `json:"dag_oversized"`
}

type chatActivityResponse struct {
	History       chatActivityHistoryResponse `json:"history"`
	Task          json.RawMessage             `json:"task"`
	Dag           json.RawMessage             `json:"dag"`
	TaskOversized bool                        `json:"task_oversized"`
	DagOversized  bool                        `json:"dag_oversized"`
	TaskDigest    *session.TaskDigest         `json:"task_digest"`
	DagDigest     *session.DagDigest          `json:"dag_digest"`
}

func (s *Server) handleGetChatActivity(w http.ResponseWriter, r *http.Request) {
	chat, err := s.cursors.GetChat(r.PathValue("chatId"))
	if err != nil || chat.WorkspaceID != r.PathValue("wsId") {
		s.writeStoreError(w, cursorstore.ErrNotFound)
		return
	}
	activity, err := session.ReadHistoricalActivity(chat.CWD, chat.DurableSessionID)
	if err != nil {
		s.logger.Error("reading chat activity history failed", "chat_id", chat.ID, "err", err)
		writeError(w, http.StatusInternalServerError, "internal server error")
		return
	}
	history := chatActivityHistoryResponse{
		Task: activity.ActivityPair.Task, Dag: activity.ActivityPair.Dag,
		TaskOversized: activity.TaskOversized, DagOversized: activity.DagOversized,
	}
	writeJSON(w, http.StatusOK, chatActivityResponse{
		History: history,
		Task:    history.Task, Dag: history.Dag,
		TaskOversized: history.TaskOversized, DagOversized: history.DagOversized,
		TaskDigest: activity.TaskDigest, DagDigest: activity.DagDigest,
	})
}
