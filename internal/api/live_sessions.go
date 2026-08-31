package api

import (
	"encoding/json"

	"github.com/DevNewbie1826/omo-webchat/internal/chat"
)

type liveSessionResponse struct {
	ID            string          `json:"id"`
	Title         string          `json:"title"`
	Task          json.RawMessage `json:"task"`
	Dag           json.RawMessage `json:"dag"`
	TaskOversized bool            `json:"task_oversized"`
	DagOversized  bool            `json:"dag_oversized"`
}

func liveSessionFromSummary(summary chat.LiveSummary, title string) liveSessionResponse {
	return liveSessionResponse{
		ID:            summary.ID,
		Title:         title,
		Task:          rawOrNull(summary.Pair.Task),
		Dag:           rawOrNull(summary.Pair.Dag),
		TaskOversized: summary.TaskOversized,
		DagOversized:  summary.DagOversized,
	}
}

type liveSessionsResponse struct {
	Sessions []liveSessionResponse `json:"sessions"`
}

func rawOrNull(data json.RawMessage) json.RawMessage {
	if len(data) == 0 {
		return nil
	}
	return data
}

func (s *Server) liveChatTitles() map[string]string {
	titles := make(map[string]string)
	if s.store == nil {
		return titles
	}
	for _, ws := range s.store.ListWorkspaces() {
		for _, c := range ws.Chats {
			titles[c.ID] = c.Name
		}
	}
	return titles
}
