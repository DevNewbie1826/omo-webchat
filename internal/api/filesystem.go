package api

import (
	"errors"
	"io/fs"
	"net/http"
	"path/filepath"
	"time"
)

type dirEntry struct {
	Name    string    `json:"name"`
	IsDir   bool      `json:"isDir"`
	Size    int64     `json:"size"`
	ModTime time.Time `json:"modTime"`
}

func parentOf(dir string) any {
	parent := filepath.Dir(dir)
	if parent == dir {
		return nil
	}
	return parent
}

func (s *Server) writeFsError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, fs.ErrNotExist):
		writeError(w, http.StatusNotFound, "path not found")
	case errors.Is(err, fs.ErrPermission):
		writeError(w, http.StatusForbidden, "permission denied")
	default:
		s.logger.Error("filesystem operation failed", "err", err)
		writeError(w, http.StatusInternalServerError, "internal server error")
	}
}
