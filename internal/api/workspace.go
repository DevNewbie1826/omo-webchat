package api

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"path/filepath"
	"sort"
	"strings"

	"github.com/DevNewbie1826/omo-webchat/internal/cursorstore"
)

type createWorkspaceRequest struct {
	Name string `json:"name"`
	Path string `json:"path"`
}
type renameRequest struct {
	Name string `json:"name"`
}
type chatResponse struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	NameSource  string `json:"nameSource,omitempty"`
	WsID        string `json:"wsId"`
	CWD         string `json:"cwd"`
	PiSessionID string `json:"piSessionId,omitempty"`
	Provider    string `json:"provider"`
	CreatedAt   int64  `json:"createdAt"`
	LastUsedAt  int64  `json:"lastUsedAt,omitempty"`
}
type workspaceResponse struct {
	ID    string         `json:"id"`
	Name  string         `json:"name"`
	Path  string         `json:"path"`
	Chats []chatResponse `json:"chats"`
}

func projectChat(c cursorstore.Chat) chatResponse {
	identity := c.SessionFile
	if identity == "" {
		identity = c.DurableSessionID
	}
	return chatResponse{ID: c.ID, Name: c.Name, NameSource: c.NameSource, WsID: c.WorkspaceID, CWD: c.CWD, PiSessionID: identity, Provider: "omo", CreatedAt: c.CreatedAt, LastUsedAt: c.LastUsedAt}
}
func (s *Server) projectWorkspace(ws cursorstore.Workspace) workspaceResponse {
	rows := s.cursors.ListChats(ws.ID)
	sort.SliceStable(rows, func(i, j int) bool {
		ai, aj := cursorRecency(rows[i]), cursorRecency(rows[j])
		if ai != aj {
			return ai > aj
		}
		return rows[i].ID < rows[j].ID
	})
	chats := make([]chatResponse, len(rows))
	for i, c := range rows {
		chats[i] = projectChat(c)
	}
	return workspaceResponse{ID: ws.ID, Name: ws.Name, Path: ws.Path, Chats: chats}
}
func cursorRecency(c cursorstore.Chat) int64 {
	return cursorstore.RecencyMillis(c)
}

func (s *Server) handleListWorkspaces(w http.ResponseWriter, _ *http.Request) {
	rows := s.cursors.ListWorkspaces()
	out := make([]workspaceResponse, len(rows))
	for i, ws := range rows {
		out[i] = s.projectWorkspace(ws)
	}
	writeJSON(w, http.StatusOK, out)
}
func newID(prefix string) (string, error) {
	b := make([]byte, 4)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return prefix + hex.EncodeToString(b), nil
}
func (s *Server) handleCreateWorkspace(w http.ResponseWriter, r *http.Request) {
	var req createWorkspaceRequest
	if decodeJSON(r, &req) != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		writeError(w, http.StatusBadRequest, "name is required")
		return
	}
	path, err := s.resolvePath(req.Path)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	id, err := newID("ws-")
	if err != nil {
		s.writeStoreError(w, err)
		return
	}
	ws := cursorstore.Workspace{ID: id, Name: name, Path: path}
	if err = s.cursors.SaveWorkspace(ws); err != nil {
		s.writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, s.projectWorkspace(ws))
}
func (s *Server) handleDeleteWorkspace(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("wsId")

	// Serialize the complete stop-first transaction with chat opens. Metadata
	// must remain available until every provider route has reached a definitive
	// close outcome, so a transient stop failure can be retried safely.
	s.chatLifecycleMu.Lock()
	defer s.chatLifecycleMu.Unlock()
	chats := s.cursors.ListChats(id)
	for _, c := range chats {
		s.chatDeleting[c.ID] = true
		s.bumpChatLifecycleVersion(c.ID)
	}
	clearDeleting := func() {
		for _, c := range chats {
			delete(s.chatDeleting, c.ID)
		}
	}

	var stopErr error
	if s.manager != nil {
		for _, c := range chats {
			stopCtx, cancel := newChatStopContext(context.Background(), chatStopTimeout)
			err := s.manager.StopContext(stopCtx, c.ID)
			cancel()
			if err != nil && stopErr == nil {
				stopErr = err
			}
		}
	}
	if stopErr != nil {
		clearDeleting()
		writeError(w, http.StatusInternalServerError, "failed to stop workspace chats")
		return
	}
	if err := s.cursors.DeleteWorkspace(id); err != nil {
		clearDeleting()
		s.writeStoreError(w, err)
		return
	}
	clearDeleting()
	w.WriteHeader(http.StatusNoContent)
}
func (s *Server) handleRenameWorkspace(w http.ResponseWriter, r *http.Request) {
	var req renameRequest
	if decodeJSON(r, &req) != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		writeError(w, http.StatusBadRequest, "name is required")
		return
	}
	ws, err := s.cursors.RenameWorkspace(r.PathValue("wsId"), name)
	if err != nil {
		s.writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, s.projectWorkspace(ws))
}
func (s *Server) resolvePath(p string) (string, error) {
	if strings.TrimSpace(p) == "" {
		return s.cfg.Root, nil
	}
	cleaned := filepath.Clean(p)
	if !filepath.IsAbs(cleaned) {
		cleaned = filepath.Join(s.cfg.Root, cleaned)
	}
	resolved, err := filepath.EvalSymlinks(cleaned)
	if err != nil {
		return "", err
	}
	if resolved != s.cfg.Root && !strings.HasPrefix(resolved, s.cfg.Root+string(filepath.Separator)) {
		return "", errOutsideRoot
	}
	return resolved, nil
}

var errOutsideRoot = &pathError{msg: "path is outside the allowed root"}

type pathError struct{ msg string }

func (e *pathError) Error() string { return e.msg }
