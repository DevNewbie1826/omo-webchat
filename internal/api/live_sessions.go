package api

import (
	"encoding/json"
	"net/http"
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
	out := map[string]string{}
	for _, ws := range s.cursors.ListWorkspaces() {
		for _, c := range s.cursors.ListChats(ws.ID) {
			out[c.ID] = c.Name
		}
	}
	return out
}
func (s *Server) handleListLiveSessions(w http.ResponseWriter, _ *http.Request) {
	titles := s.liveChatTitles()
	if s.manager == nil {
		writeJSON(w, http.StatusOK, liveSessionsResponse{Sessions: []liveSessionResponse{}})
		return
	}
	summaries := s.manager.LiveSummaries()
	rows := make([]liveSessionResponse, 0, len(summaries))
	for _, x := range summaries {
		title := titles[x.ChatID]
		if title == "" {
			title = x.Title
		}
		row := liveSessionResponse{ID: x.ChatID, Title: title, Task: rawOrNull(x.ActivityPair.Task), Dag: rawOrNull(x.ActivityPair.Dag), TaskOversized: x.TaskOversized, DagOversized: x.DagOversized}
		if x.TaskDigest != nil {
			row.TaskDigest = x.TaskDigest
		}
		if x.DagDigest != nil {
			row.DagDigest = x.DagDigest
		}
		rows = append(rows, row)
	}
	writeJSON(w, http.StatusOK, liveSessionsResponse{Sessions: rows})
}
