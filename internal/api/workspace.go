package api

import (
	"net/http"
	"path/filepath"
	"strings"
)

type createWorkspaceRequest struct {
	Name string `json:"name"`
	Path string `json:"path"`
}

type renameRequest struct {
	Name string `json:"name"`
}

func (s *Server) handleListWorkspaces(w http.ResponseWriter, _ *http.Request) {
	// Read-only: the store projects legacy launchable chats as omo and hides
	// unsupported ones in the returned copies without writing anything back.
	writeJSON(w, http.StatusOK, s.store.ListWorkspaces())
}

func (s *Server) handleCreateWorkspace(w http.ResponseWriter, r *http.Request) {
	var req createWorkspaceRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		writeError(w, http.StatusBadRequest, "name is required")
		return
	}
	absPath, err := s.resolvePath(req.Path)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	ws, err := s.store.CreateWorkspace(name, absPath)
	if err != nil {
		s.writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, ws)
}

func (s *Server) handleDeleteWorkspace(w http.ResponseWriter, r *http.Request) {
	wsID := r.PathValue("wsId")
	if s.beforeWorkspaceDelete != nil {
		s.beforeWorkspaceDelete()
	}
	s.chatLifecycleMu.Lock()
	removed, err := s.store.DeleteWorkspace(wsID)
	s.chatLifecycleMu.Unlock()
	if err != nil {
		s.writeStoreError(w, err)
		return
	}
	// Stop may wait on provider I/O. The store deletion is the lifecycle
	// linearization point; concurrent opens recheck it before attachment.
	for _, record := range removed.Chats {
		s.chats.Stop(record.ID)
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleRenameWorkspace(w http.ResponseWriter, r *http.Request) {
	var req renameRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		writeError(w, http.StatusBadRequest, "name is required")
		return
	}
	ws, err := s.store.RenameWorkspace(r.PathValue("wsId"), name)
	if err != nil {
		s.writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, ws)
}

// resolvePath cleans p (defaulting to --root when empty), resolves symlinks,
// and enforces the root boundary.
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
