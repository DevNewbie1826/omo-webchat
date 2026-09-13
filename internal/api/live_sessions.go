package api

import (
	"net/http"

	"github.com/DevNewbie1826/omo-webchat/internal/session"
)

type liveSessionResponse struct {
	ID     string `json:"id"`
	Title  string `json:"title"`
	Active bool   `json:"active"`
	session.LiveValues
}
type liveSessionsResponse struct {
	Sessions []liveSessionResponse `json:"sessions"`
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
		rows = append(rows, liveSessionResponse{ID: x.ChatID, Title: title, Active: x.Active, LiveValues: x.LiveValues()})
	}
	writeJSON(w, http.StatusOK, liveSessionsResponse{Sessions: rows})
}
