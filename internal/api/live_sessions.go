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
	TaskDigest    any             `json:"task_digest,omitempty"`
	DagDigest     any             `json:"dag_digest,omitempty"`
}

func liveSessionFromSummary(summary chat.LiveSummary, title string) liveSessionResponse {
	row := liveSessionResponse{
		ID:            summary.ID,
		Title:         title,
		Task:          rawOrNull(summary.Pair.Task),
		Dag:           rawOrNull(summary.Pair.Dag),
		TaskOversized: summary.TaskOversized,
		DagOversized:  summary.DagOversized,
	}
	if summary.TaskDigest != nil {
		row.TaskDigest = summary.TaskDigest
	}
	if summary.DagDigest != nil {
		row.DagDigest = summary.DagDigest
	}
	return row
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
	if _, cursors := s.v2Stack(); cursors != nil {
		for _, ws := range cursors.ListWorkspaces() {
			for _, c := range cursors.ListChats(ws.ID) {
				titles[c.ID] = c.Name
			}
		}
	}
	if s.store != nil {
		for _, ws := range s.store.ListWorkspaces() {
			for _, c := range ws.Chats {
				// Legacy metadata remains authoritative for overlapping IDs.
				titles[c.ID] = c.Name
			}
		}
	}
	return titles
}
