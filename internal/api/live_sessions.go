package api

import "encoding/json"

type liveSessionResponse struct {
	ID    string          `json:"id"`
	Title string          `json:"title"`
	Task  json.RawMessage `json:"task"`
	Dag   json.RawMessage `json:"dag"`
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
