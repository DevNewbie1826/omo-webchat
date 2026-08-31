package api

import (
	"bytes"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"sort"
)

const (
	maxReadBytes    = 2 << 20 // 2 MiB
	binaryScanBytes = 1024
)

func (s *Server) handleBrowse(w http.ResponseWriter, r *http.Request) {
	dir, err := s.resolvePath(r.URL.Query().Get("path"))
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		s.writeFsError(w, err)
		return
	}
	dirs := make([]string, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() {
			dirs = append(dirs, e.Name())
		}
	}
	sort.Strings(dirs)
	writeJSON(w, http.StatusOK, map[string]any{
		"path":   dir,
		"parent": parentOf(dir),
		"dirs":   dirs,
	})
}

func (s *Server) handleList(w http.ResponseWriter, r *http.Request) {
	if r.URL.Query().Has("cwd") {
		s.handleListMention(w, r)
		return
	}
	dir, err := s.resolvePath(r.URL.Query().Get("path"))
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		s.writeFsError(w, err)
		return
	}
	list := make([]dirEntry, 0, len(entries))
	for _, e := range entries {
		info, err := e.Info()
		if err != nil {
			s.logger.Warn("stat failed", "path", filepath.Join(dir, e.Name()), "err", err)
			continue
		}
		list = append(list, dirEntry{
			Name:    e.Name(),
			IsDir:   e.IsDir(),
			Size:    info.Size(),
			ModTime: info.ModTime(),
		})
	}
	sort.Slice(list, func(i, j int) bool {
		if list[i].IsDir != list[j].IsDir {
			return list[i].IsDir
		}
		return list[i].Name < list[j].Name
	})
	writeJSON(w, http.StatusOK, map[string]any{
		"path":    dir,
		"parent":  parentOf(dir),
		"entries": list,
	})
}

func (s *Server) handleDownload(w http.ResponseWriter, r *http.Request) {
	target, err := s.resolvePath(r.URL.Query().Get("path"))
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	info, err := os.Stat(target)
	if err != nil {
		s.writeFsError(w, err)
		return
	}
	if info.IsDir() {
		writeError(w, http.StatusBadRequest, "path is a directory")
		return
	}
	f, err := os.Open(target)
	if err != nil {
		s.writeFsError(w, err)
		return
	}
	defer func() { _ = f.Close() }()
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": filepath.Base(target)}))
	w.Header().Set("Content-Type", "application/octet-stream")
	http.ServeContent(w, r, filepath.Base(target), info.ModTime(), f)
}

func (s *Server) handleReadFile(w http.ResponseWriter, r *http.Request) {
	target, err := s.resolvePath(r.URL.Query().Get("path"))
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	info, err := os.Stat(target)
	if err != nil {
		s.writeFsError(w, err)
		return
	}
	if info.IsDir() {
		writeError(w, http.StatusBadRequest, "path is a directory")
		return
	}
	f, err := os.Open(target)
	if err != nil {
		s.writeFsError(w, err)
		return
	}
	defer func() { _ = f.Close() }()
	// Limit reads if the file grows after the stat.
	data, err := io.ReadAll(io.LimitReader(f, maxReadBytes+1))
	if err != nil {
		s.writeFsError(w, err)
		return
	}
	if len(data) > maxReadBytes {
		writeError(w, http.StatusRequestEntityTooLarge, "file too large to edit")
		return
	}
	if isBinary(data) {
		writeError(w, http.StatusUnsupportedMediaType, "binary file cannot be edited")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"content": string(data), "size": len(data)})
}

func isBinary(data []byte) bool {
	head := data
	if len(head) > binaryScanBytes {
		head = head[:binaryScanBytes]
	}
	return bytes.IndexByte(head, 0) >= 0
}
