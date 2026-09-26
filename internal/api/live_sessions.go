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

func (s *Server) handleListLiveSessions(w http.ResponseWriter, _ *http.Request) {
	if s.manager == nil {
		writeJSON(w, http.StatusOK, liveSessionsResponse{Sessions: []liveSessionResponse{}})
		return
	}
	summaries := s.manager.LiveSummaries()
	rows := make([]liveSessionResponse, 0, len(summaries))
	for _, x := range summaries {
		rows = append(rows, liveSessionResponse{ID: x.ChatID, Title: x.Title, Active: x.Active, LiveValues: x.LiveValues()})
	}
	writeJSON(w, http.StatusOK, liveSessionsResponse{Sessions: rows})
}
