package api

import (
	"errors"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// handleMakeDir creates a single directory inside the root. The parent is
// resolved through resolvePath (which enforces the root boundary after
// symlink evaluation) and only a validated leaf name is appended, because
// EvalSymlinks cannot resolve a path whose final segment does not exist yet.
func (s *Server) handleMakeDir(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Path string `json:"path"`
		Name string `json:"name"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	parent, err := s.resolvePath(req.Path)
	if err != nil {
		switch {
		case errors.Is(err, errOutsideRoot):
			writeError(w, http.StatusBadRequest, err.Error())
		case errors.Is(err, fs.ErrNotExist):
			writeError(w, http.StatusNotFound, "parent directory not found")
		default:
			writeError(w, http.StatusBadRequest, err.Error())
		}
		return
	}
	leaf, err := newLeafName(req.Name)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	created := filepath.Join(parent, leaf)
	if err := os.Mkdir(created, 0o755); err != nil {
		switch {
		case errors.Is(err, os.ErrExist):
			writeError(w, http.StatusConflict, "directory already exists")
		case errors.Is(err, fs.ErrNotExist):
			writeError(w, http.StatusNotFound, "parent directory not found")
		default:
			s.writeFsError(w, err)
		}
		return
	}
	writeJSON(w, http.StatusCreated, map[string]string{"path": created})
}

// newLeafName validates a single new path segment: non-empty, not . or ..,
// and free of separators, so the created directory cannot escape the
// resolved parent.
func newLeafName(name string) (string, error) {
	leaf := strings.TrimSpace(name)
	if leaf == "" || leaf == "." || leaf == ".." {
		return "", errors.New("invalid folder name")
	}
	if strings.ContainsAny(leaf, string(os.PathSeparator)+`/\`+"\x00") {
		return "", errors.New("invalid folder name")
	}
	return leaf, nil
}
