package api

import (
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/cursorstore"
)

// handleOpenRPCSession registers a live route without adopting or replacing its
// source. Provider acquisition stays in the ordinary chat.create path.
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
	if s.rpcWatcher == nil {
		writeError(w, http.StatusNotFound, "session not found")
		return
	}
	live, ok := s.rpcWatcher.Lookup(strings.TrimSpace(req.SessionID))
	if !ok {
		writeError(w, http.StatusNotFound, "session not found")
		return
	}
	cwd, cwdOK := canonicalSessionCWD(live.Cwd)
	workspaceCWD, wsOK := canonicalSessionCWD(ws.Path)
	if !cwdOK || !wsOK || cwd != workspaceCWD {
		writeError(w, http.StatusBadRequest, "session cwd does not match workspace")
		return
	}
	sourcePath, err := canonicalPathAllowMissing(live.SessionPath)
	if err != nil || !filepath.IsAbs(live.SessionPath) {
		writeError(w, http.StatusBadRequest, "invalid session path")
		return
	}

	s.adoptionMu.Lock()
	defer s.adoptionMu.Unlock()
	for _, chat := range s.cursors.ListChats(ws.ID) {
		if chat.SessionFile == "" {
			continue
		}
		boundPath, err := canonicalPathAllowMissing(chat.SessionFile)
		if err != nil || boundPath != sourcePath {
			continue
		}
		if chat.DurableSessionID != "" && live.DurableSessionID != "" && chat.DurableSessionID != live.DurableSessionID {
			// A same-path replacement is a distinct identity. Leave the old
			// chat untouched, even when it already owns a provider route.
			continue
		}
		if cursorstore.IsInPlaceSession(chat) {
			s.authorizeInPlaceOpen(chat.ID, true)
		}
		writeJSON(w, http.StatusOK, projectChat(chat))
		return
	}

	name := strings.TrimSpace(live.Name)
	established := name != ""
	if name == "" {
		name, established = readSessionNameSource(sourcePath)
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
	if err := s.cursors.SaveChat(chat); err != nil {
		s.writeStoreError(w, err)
		return
	}
	s.authorizeInPlaceOpen(chat.ID, true)
	writeJSON(w, http.StatusCreated, projectChat(chat))
}
