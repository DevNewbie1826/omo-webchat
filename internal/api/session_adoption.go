package api

import (
	"errors"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/adoptcopy"
	"github.com/DevNewbie1826/omo-webchat/internal/cursorstore"
)

type adoptWorkspaceSessionRequest struct {
	ID             string `json:"id"`
	Name           string `json:"name"`
	ResumeIdentity string `json:"resumeIdentity"`
}

type adoptionErrorResponse struct {
	Error string         `json:"error"`
	Code  adoptcopy.Kind `json:"code"`
}

// handleAdoptWorkspaceSession resolves only rows in the workspace's discovered
// catalog. The source is passed solely to adoptcopy's read-only copy workflow;
// the resulting owned path is the only path persisted as the chat identity.
func (s *Server) handleAdoptWorkspaceSession(w http.ResponseWriter, r *http.Request) {
	ws, err := s.cursors.GetWorkspace(r.PathValue("wsId"))
	if err != nil {
		s.writeStoreError(w, err)
		return
	}
	var req adoptWorkspaceSessionRequest
	if decodeJSON(r, &req) != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	s.adoptionMu.Lock()
	defer s.adoptionMu.Unlock()

	source, ok := findDiskSession(ws.Path, strings.TrimSpace(req.ID), strings.TrimSpace(req.ResumeIdentity))
	if !ok {
		writeError(w, http.StatusBadRequest, "session does not belong to workspace catalog")
		return
	}
	result, err := adoptcopy.Adopt(r.Context(), source.Path, filepath.Join(s.cursors.StateDir(), "adopted"))
	if err != nil {
		s.writeAdoptionError(w, err)
		return
	}
	if result.SessionID != source.ID {
		s.writeAdoptionError(w, &adoptcopy.Error{Kind: adoptcopy.KindInvalidSource, Op: "validate catalog identity", Path: source.Path, Err: adoptcopy.ErrInvalidSource})
		return
	}

	for _, chat := range s.cursors.ListChats(ws.ID) {
		if chat.DurableSessionID != result.SessionID && !sessionMatchesChat(source, chat) {
			continue
		}
		if err := s.cursors.UpdateIdentity(chat.ID, result.Path, result.SessionID); err != nil {
			s.writeStoreError(w, err)
			return
		}
		chat, err = s.cursors.GetChat(chat.ID)
		if err != nil {
			s.writeStoreError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, projectChat(chat))
		return
	}

	name := strings.TrimSpace(req.Name)
	placeholder := name == ""
	if placeholder {
		name = readSessionName(source.Path)
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
		ID:                 id,
		WorkspaceID:        ws.ID,
		CWD:                ws.Path,
		Name:               name,
		NameSource:         cursorstore.NameSourceAuto,
		TitleIsPlaceholder: placeholder,
		CreatedAt:          time.Now().UnixMilli(),
	}
	if err := s.cursors.SaveChat(chat); err != nil {
		s.writeStoreError(w, err)
		return
	}
	if err := s.cursors.UpdateIdentity(chat.ID, result.Path, result.SessionID); err != nil {
		_ = s.cursors.DeleteChat(chat.ID)
		s.writeStoreError(w, err)
		return
	}
	chat, err = s.cursors.GetChat(chat.ID)
	if err != nil {
		s.writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, projectChat(chat))
}

func findDiskSession(cwd, id, path string) (diskSession, bool) {
	if id == "" && path == "" {
		return diskSession{}, false
	}
	for _, session := range listDiskSessions(cwd) {
		if id != "" && id != session.ID {
			continue
		}
		if path != "" && path != session.Path && path != session.ID {
			continue
		}
		return session, true
	}
	return diskSession{}, false
}

func (s *Server) writeAdoptionError(w http.ResponseWriter, err error) {
	var adoptionErr *adoptcopy.Error
	if !errors.As(err, &adoptionErr) {
		s.logger.Error("session adoption failed", "err", err)
		writeError(w, http.StatusInternalServerError, "session adoption failed")
		return
	}
	status := http.StatusInternalServerError
	switch adoptionErr.Kind {
	case adoptcopy.KindInvalidSource:
		status = http.StatusUnprocessableEntity
	case adoptcopy.KindTooLarge:
		status = http.StatusRequestEntityTooLarge
	case adoptcopy.KindHashMismatch, adoptcopy.KindCollision:
		status = http.StatusConflict
	case adoptcopy.KindIO:
		s.logger.Error("session adoption failed", "kind", adoptionErr.Kind, "err", err)
	}
	writeJSON(w, status, adoptionErrorResponse{Error: "session adoption failed", Code: adoptionErr.Kind})
}
