package api

import (
	"net/http"

	"github.com/DevNewbie1826/omo-webchat/internal/session"
)

type liveSessionResponse struct {
	ID               string `json:"id"`
	DurableSessionID string `json:"durableSessionId,omitempty"`
	BindingID        string `json:"bindingId,omitempty"`
	Title            string `json:"title"`
	Active           bool   `json:"active"`
	session.LiveValues
}
type liveSessionsResponse struct {
	InstanceID string                `json:"instanceId"`
	Sessions   []liveSessionResponse `json:"sessions"`
}

func (s *Server) handleListLiveSessions(w http.ResponseWriter, _ *http.Request) {
	if s.manager == nil {
		writeJSON(w, http.StatusOK, liveSessionsResponse{Sessions: []liveSessionResponse{}})
		return
	}
	summaries := s.manager.LiveSummaries()
	rows := make([]liveSessionResponse, 0, len(summaries))
	for _, x := range summaries {
		rows = append(rows, liveSessionResponse{
			ID: x.ChatID, DurableSessionID: x.DurableSessionID, BindingID: x.BindingID,
			Title: x.Title, Active: x.Active, LiveValues: x.LiveValues(),
		})
	}
	writeJSON(w, http.StatusOK, liveSessionsResponse{InstanceID: s.manager.InstanceID(), Sessions: rows})
}
