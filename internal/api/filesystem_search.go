package api

import (
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const (
	searchMaxResults = 50
	searchMaxWalked  = 20000
)

var searchIgnoreDirs = map[string]bool{
	".git": true, "node_modules": true, "dist": true, "build": true,
	"target": true, ".next": true, ".nuxt": true, ".cache": true,
	".svn": true, ".hg": true, "__pycache__": true, ".venv": true,
	"venv": true, "env": true, ".idea": true, ".vscode": true,
	".turbo": true, ".parcel-cache": true, "coverage": true,
}

type fileSearchResult struct {
	Path     string `json:"path"`
	Name     string `json:"name"`
	IsDir    bool   `json:"isDir"`
	IsParent bool   `json:"isParent,omitempty"`
}

func (s *Server) handleSearch(w http.ResponseWriter, r *http.Request) {
	root, err := s.resolvePath(r.URL.Query().Get("path"))
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	query := strings.TrimSpace(strings.ToLower(r.URL.Query().Get("q")))
	var results []fileSearchResult
	if query == "" {
		// Bare "@" — surface the most recently touched files so the palette
		// isn't empty before the user types a filter.
		results = recentFiles(root)
	} else {
		results = searchFilesIn(root, query)
	}
	writeJSON(w, http.StatusOK, map[string]any{"path": root, "results": results})
}

func searchFilesIn(root, query string) []fileSearchResult {
	results := make([]fileSearchResult, 0, searchMaxResults)
	walked := 0
	_ = filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			if path != root && searchIgnoreDirs[d.Name()] {
				return filepath.SkipDir
			}
			return nil
		}
		walked++
		if walked > searchMaxWalked {
			return filepath.SkipAll
		}
		name := d.Name()
		if !strings.Contains(strings.ToLower(name), query) {
			return nil
		}
		rel, relErr := filepath.Rel(root, path)
		if relErr != nil {
			return nil
		}
		results = append(results, fileSearchResult{Path: filepath.ToSlash(rel), Name: name})
		if len(results) >= searchMaxResults {
			return filepath.SkipAll
		}
		return nil
	})
	sort.Slice(results, func(i, j int) bool {
		if len(results[i].Path) != len(results[j].Path) {
			return len(results[i].Path) < len(results[j].Path)
		}
		return results[i].Path < results[j].Path
	})
	return results
}

// recentFiles returns the most recently modified files under root (ignoring the
// same dependency directories as search), newest first. It populates the
// @-mention palette before the user has typed a filter, so a bare "@" is never
// an empty dead-end.
func recentFiles(root string) []fileSearchResult {
	type recentEntry struct {
		path  string
		name  string
		mtime int64
	}
	found := make([]recentEntry, 0, searchMaxResults*2)
	walked := 0
	_ = filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			if path != root && searchIgnoreDirs[d.Name()] {
				return filepath.SkipDir
			}
			return nil
		}
		walked++
		if walked > searchMaxWalked {
			return filepath.SkipAll
		}
		info, infoErr := d.Info()
		if infoErr != nil {
			return nil
		}
		rel, relErr := filepath.Rel(root, path)
		if relErr != nil {
			return nil
		}
		found = append(found, recentEntry{path: filepath.ToSlash(rel), name: d.Name(), mtime: info.ModTime().UnixNano()})
		if len(found) == searchMaxResults*2 {
			sort.Slice(found, func(i, j int) bool { return found[i].mtime > found[j].mtime })
			found = found[:searchMaxResults]
		}
		return nil
	})
	sort.Slice(found, func(i, j int) bool { return found[i].mtime > found[j].mtime })
	if len(found) > searchMaxResults {
		found = found[:searchMaxResults]
	}
	results := make([]fileSearchResult, 0, len(found))
	for i := range found {
		results = append(results, fileSearchResult{Path: found[i].path, Name: found[i].name})
	}
	return results
}
