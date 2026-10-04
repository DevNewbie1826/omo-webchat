package api

import (
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/adoptcopy"
	"github.com/DevNewbie1826/omo-webchat/internal/cursorstore"
	"github.com/DevNewbie1826/omo-webchat/internal/rpcwatch"
)

type rpcSessionResponse struct {
	rpcwatch.Session
	WorkspaceID string `json:"workspaceId"`
	ChatID      string `json:"chatId,omitempty"`
}

type rpcPathCache map[string]string

func (paths rpcPathCache) canonical(path string) string {
	clean := filepath.Clean(path)
	if canonical, ok := paths[clean]; ok {
		return canonical
	}
	canonical, err := filepath.EvalSymlinks(clean)
	if err != nil {
		canonical = clean
	}
	paths[clean] = canonical
	return canonical
}

func (s *Server) handleListRPCSessions(w http.ResponseWriter, r *http.Request) {
	rows := make([]rpcSessionResponse, 0)
	paths := make(rpcPathCache)
	if s.rpcWatcher != nil {
		workspaces := s.cursors.ListWorkspaces()
		for _, live := range s.rpcWatcher.Sessions() {
			for _, ws := range workspaces {
				if paths.canonical(live.Cwd) != paths.canonical(ws.Path) {
					continue
				}
				row := rpcSessionResponse{Session: live, WorkspaceID: ws.ID}
				excluded := false
				for _, chat := range s.cursors.ListChats(ws.ID) {
					if chat.SessionFile == "" || paths.canonical(chat.SessionFile) != paths.canonical(live.SessionPath) {
						continue
					}
					if !cursorstore.IsInPlaceSession(chat) {
						excluded = true
						break
					}
					row.ChatID = chat.ID
				}
				if !excluded {
					rows = append(rows, row)
				}
				break
			}
		}
	}
	writeJSON(w, http.StatusOK, struct {
		Sessions []rpcSessionResponse `json:"sessions"`
	}{rows})
}

func (s *Server) handleOpenRPCSession(w http.ResponseWriter, r *http.Request) {
	ws, err := s.cursors.GetWorkspace(r.PathValue("wsId"))
	if err != nil {
		s.writeStoreError(w, err)
		return
	}
	var req struct {
		SessionID string `json:"sessionId"`
	}
	if decodeJSON(r, &req) != nil || strings.TrimSpace(req.SessionID) == "" {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	s.adoptionMu.Lock()
	defer s.adoptionMu.Unlock()
	if s.rpcWatcher == nil {
		writeError(w, http.StatusNotFound, "RPC session not found")
		return
	}
	live, ok := s.rpcWatcher.Lookup(req.SessionID)
	if !ok || live.Status == "closed" {
		writeError(w, http.StatusNotFound, "RPC session not found")
		return
	}
	paths := make(rpcPathCache)
	if paths.canonical(live.Cwd) != paths.canonical(ws.Path) {
		writeError(w, http.StatusBadRequest, "RPC session cwd does not match workspace")
		return
	}
	for _, chat := range s.cursors.ListChats(ws.ID) {
		if chat.SessionFile != "" && paths.canonical(chat.SessionFile) == paths.canonical(live.SessionPath) {
			if cursorstore.IsInPlaceSession(chat) {
				s.authorizeInPlaceOpen(chat.ID, true)
			}
			writeJSON(w, http.StatusOK, projectChat(chat))
			return
		}
	}
	_, statErr := os.Lstat(live.SessionPath)
	if statErr == nil {
		if _, err := adoptcopy.Validate(r.Context(), live.SessionPath, live.DurableSessionID); err != nil {
			s.writeAdoptionError(w, err)
			return
		}
	} else if !errors.Is(statErr, os.ErrNotExist) {
		s.writeAdoptionError(w, statErr)
		return
	}
	name := strings.TrimSpace(live.Name)
	established := name != ""
	if name == "" && statErr == nil {
		name, established = readSessionNameSource(live.SessionPath)
	}
	if name == "" {
		name = s.defaultChatName(ws)
	}
	id, err := newID("chat-")
	if err != nil {
		s.writeStoreError(w, err)
		return
	}
	chat := cursorstore.Chat{
		ID: id, WorkspaceID: ws.ID, CWD: ws.Path,
		SessionFile: live.SessionPath, DurableSessionID: live.DurableSessionID,
		SessionProvenance: cursorstore.SessionProvenanceInPlace,
		Name:              name, NameSource: cursorstore.NameSourceAuto,
		TitleIsPlaceholder: !established, CreatedAt: time.Now().UnixMilli(),
	}
	s.authorizeInPlaceOpen(id, true)
	if err := s.cursors.SaveChat(chat); err != nil {
		s.writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, projectChat(chat))
}
