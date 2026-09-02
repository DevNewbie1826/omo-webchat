package api

import (
	"encoding/json"
	"errors"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"

	"github.com/DevNewbie1826/omo-webchat/internal/cursorstore"
)

const (
	maxUploadBytes = 100 << 20 // 100 MiB
	// The write limit must cover any file the editor can read.
	maxWriteBytes = maxReadBytes
)

func (s *Server) handleWriteFile(w http.ResponseWriter, r *http.Request) {
	target, err := s.resolvePath(r.URL.Query().Get("path"))
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	// The client sends content as JSON; escaping can inflate a max-size
	// payload to 6x (control chars become \u00XX). The body cap must absorb
	// that or valid editor-readable files fail to save; the post-decode
	// length check below is the real limit.
	r.Body = http.MaxBytesReader(w, r.Body, 6*maxWriteBytes+4096)
	var req struct {
		Content string `json:"content"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		var maxBytesErr *http.MaxBytesError
		if errors.As(err, &maxBytesErr) {
			writeError(w, http.StatusRequestEntityTooLarge, "content too large to save")
			return
		}
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if len(req.Content) > maxWriteBytes {
		writeError(w, http.StatusRequestEntityTooLarge, "content too large to save")
		return
	}
	if err := writeFileAtomic(target, []byte(req.Content)); err != nil {
		s.writeFsError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func writeFileAtomic(path string, data []byte) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, ".th-edit-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer func() {
		if tmpName != "" {
			_ = os.Remove(tmpName)
		}
	}()
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	mode := os.FileMode(0o644)
	if info, err := os.Stat(path); err == nil {
		mode = info.Mode().Perm()
	}
	if err := os.Chmod(tmpName, mode); err != nil {
		return err
	}
	if err := os.Rename(tmpName, path); err != nil {
		return err
	}
	tmpName = ""
	// Best-effort directory sync persists the rename.
	if d, err := os.Open(dir); err == nil {
		_ = d.Sync()
		_ = d.Close()
	}
	return nil
}

func (s *Server) handleUpload(w http.ResponseWriter, r *http.Request) {
	ws, err := s.cursors.GetWorkspace(r.PathValue("wsId"))
	if err != nil {
		s.writeStoreError(w, err)
		return
	}
	chatID := r.PathValue("chatId")
	chat, err := s.cursors.GetChat(chatID)
	if err != nil || chat.WorkspaceID != ws.ID {
		s.writeStoreError(w, cursorstore.ErrNotFound)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxUploadBytes)
	if err := r.ParseMultipartForm(32 << 20); err != nil {
		writeError(w, http.StatusBadRequest, "invalid multipart form")
		return
	}
	files := r.MultipartForm.File["files"]
	if len(files) == 0 {
		writeError(w, http.StatusBadRequest, `no "files" field in multipart form`)
		return
	}
	uploaded := make([]string, 0, len(files))
	for _, fh := range files {
		if err := saveUpload(fh, ws.Path); err != nil {
			s.logger.Error("saving upload", "file", fh.Filename, "err", err)
			writeError(w, http.StatusInternalServerError, "failed to save "+fh.Filename)
			return
		}
		uploaded = append(uploaded, filepath.Base(fh.Filename))
	}
	writeJSON(w, http.StatusOK, map[string]any{"uploaded": uploaded})
}

func saveUpload(fh *multipart.FileHeader, destDir string) error {
	src, err := fh.Open()
	if err != nil {
		return err
	}
	defer func() { _ = src.Close() }()
	name := filepath.Base(filepath.Clean(fh.Filename))
	if name == "" || name == "." || name == ".." {
		return errors.New("invalid filename")
	}
	dst, err := os.OpenFile(filepath.Join(destDir, name), os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	defer func() { _ = dst.Close() }()
	_, err = io.Copy(dst, src)
	return err
}
