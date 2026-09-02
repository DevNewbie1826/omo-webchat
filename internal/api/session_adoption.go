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

var (
	saveAdoptedChat = func(store *cursorstore.Store, chat cursorstore.Chat) error {
		return store.SaveChat(chat)
	}
	afterAdoptionInvalidated = func(string) {}
)

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
	ownedDir := s.cursors.OwnedSessionDir()
	destination := filepath.Join(ownedDir, adoptcopy.DestinationName(source.ID))
	var existing *cursorstore.Chat
	for _, candidate := range s.cursors.ListChats(ws.ID) {
		candidate := candidate
		if candidate.DurableSessionID == source.ID && candidate.SessionFile == destination && cursorstore.IsOwnedSession(candidate, ownedDir) {
			info, statErr := os.Lstat(destination)
			if statErr == nil && info.Mode().IsRegular() {
				writeJSON(w, http.StatusOK, projectChat(candidate))
				return
			}
			if statErr != nil && !errors.Is(statErr, os.ErrNotExist) {
				s.writeAdoptionError(w, &adoptcopy.Error{Kind: adoptcopy.KindIO, Op: "inspect owned copy", Path: destination, Err: statErr})
				return
			}
			existing = &candidate
			break
		}
		if existing == nil && (candidate.DurableSessionID == source.ID || candidate.SessionFile == source.Path) {
			existing = &candidate
		}
	}

	if existing != nil {
		chat, transitionErr := s.adoptExistingChat(r, *existing, source, ownedDir)
		if transitionErr != nil {
			s.writeAdoptionTransitionError(w, transitionErr)
			return
		}
		writeJSON(w, http.StatusOK, projectChat(chat))
		return
	}

	result, err := adoptcopy.Adopt(r.Context(), source.Path, ownedDir, source.ID)
	if err != nil {
		s.writeAdoptionError(w, err)
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
		SessionFile:        result.Path,
		DurableSessionID:   result.SessionID,
		SessionProvenance:  cursorstore.SessionProvenanceAdopted,
		Name:               name,
		NameSource:         cursorstore.NameSourceAuto,
		TitleIsPlaceholder: placeholder,
		CreatedAt:          time.Now().UnixMilli(),
	}
	if err := saveAdoptedChat(s.cursors, chat); err != nil {
		s.writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, projectChat(chat))
}

func (s *Server) adoptExistingChat(r *http.Request, chat cursorstore.Chat, source diskSession, ownedDir string) (cursorstore.Chat, error) {
	s.chatLifecycleMu.Lock()
	current, err := s.cursors.GetChat(chat.ID)
	if err != nil || current.WorkspaceID != chat.WorkspaceID || s.chatDeleting[chat.ID] {
		s.chatLifecycleMu.Unlock()
		return cursorstore.Chat{}, cursorstore.ErrNotFound
	}
	s.bumpChatLifecycleVersion(chat.ID)
	s.chatLifecycleMu.Unlock()
	afterAdoptionInvalidated(chat.ID)

	install := func() error {
		result, copyErr := adoptcopy.Adopt(r.Context(), source.Path, ownedDir, source.ID)
		if copyErr != nil {
			return copyErr
		}
		return s.cursors.UpdateOwnedIdentity(chat.ID, result.Path, result.SessionID)
	}
	if s.manager != nil {
		err = s.manager.StopAndMutateContext(r.Context(), chat.ID, install)
	} else {
		err = install()
	}
	if err != nil {
		return cursorstore.Chat{}, err
	}
	return s.cursors.GetChat(chat.ID)
}

func (s *Server) writeAdoptionTransitionError(w http.ResponseWriter, err error) {
	var adoptionErr *adoptcopy.Error
	if errors.As(err, &adoptionErr) {
		s.writeAdoptionError(w, err)
		return
	}
	s.writeStoreError(w, err)
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
