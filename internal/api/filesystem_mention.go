package api

import (
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// handleListMention serves the path-browsing variant of GET /api/fs/list,
// selected by the presence of a `cwd` query parameter. It resolves the
// browse target relative to the cwd (or the workspace root for absolute
// queries), enforces the root boundary, and returns a cwd-relative
// directory listing with a synthetic `..` parent entry.
func (s *Server) handleListMention(w http.ResponseWriter, r *http.Request) {
	cwd := r.URL.Query().Get("cwd")
	path := r.URL.Query().Get("path")

	cwdAbs, err := s.resolvePath(cwd)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	// A leading "/" is workspace-root-relative, so don't strip a bare "/" down to
	// "." (which would resolve to the cwd). Only trim trailing slashes from
	// relative queries.
	rel := path
	if !strings.HasPrefix(rel, "/") {
		rel = strings.TrimRight(rel, "/")
	}
	if rel == "" {
		rel = "."
	}

	resolved, err := resolveUnder(s.cfg.Root, cwdAbs, rel)
	if err != nil {
		if errors.Is(err, errOutsideRoot) {
			writeError(w, http.StatusBadRequest, err.Error())
		} else {
			s.writeFsError(w, err)
		}
		return
	}

	entries, err := os.ReadDir(resolved)
	if err != nil {
		s.writeFsError(w, err)
		return
	}

	out, capped := listMentionDir(s.cfg.Root, cwdAbs, resolved, entries)
	relPathField := filepath.ToSlash(mustRel(cwdAbs, resolved))
	writeJSON(w, http.StatusOK, map[string]any{
		"path":    relPathField,
		"entries": out,
		"capped":  capped,
	})
}

// resolveUnder resolves rel against base (the cwd) — or against root for
// workspace-absolute queries — then evaluates symlinks and enforces that
// the result stays within root. It mirrors the root-boundary semantics of
// Server.resolvePath but resolves relative to an arbitrary in-root base.
func resolveUnder(root, base, rel string) (string, error) {
	cleaned := filepath.Clean(rel)
	var start string
	switch {
	case cleaned == "" || cleaned == ".":
		start = base
	case filepath.IsAbs(cleaned):
		// A leading `/` is workspace-root-relative, NOT filesystem-absolute.
		start = filepath.Join(root, cleaned)
	default:
		start = filepath.Join(base, cleaned)
	}

	resolved, err := filepath.EvalSymlinks(start)
	if err != nil {
		return "", err
	}

	if resolved != root && !strings.HasPrefix(resolved, root+string(filepath.Separator)) {
		return "", errOutsideRoot
	}
	return resolved, nil
}

// listMentionDir builds the mention picker entry list: a synthetic `..`
// parent (only when not at the workspace root), then subdirs (respecting
// searchIgnoreDirs), then files — each group alpha-sorted, cwd-relative
// paths, capped at searchMaxResults non-parent entries.
func listMentionDir(root, cwdAbs, resolved string, entries []os.DirEntry) (out []fileSearchResult, capped bool) {
	out = make([]fileSearchResult, 0, searchMaxResults+1)

	if resolved != root {
		if parentRel, err := filepath.Rel(cwdAbs, filepath.Dir(resolved)); err == nil {
			out = append(out, fileSearchResult{
				Path:     filepath.ToSlash(parentRel),
				Name:     "..",
				IsDir:    true,
				IsParent: true,
			})
		}
	}

	var dirs, files []fileSearchResult
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() {
			if searchIgnoreDirs[name] {
				continue
			}
		}
		if len(dirs)+len(files) >= searchMaxResults {
			capped = true
			continue
		}
		entryAbs := filepath.Join(resolved, name)
		entryRel := mustRel(cwdAbs, entryAbs)
		res := fileSearchResult{
			Path:  filepath.ToSlash(entryRel),
			Name:  name,
			IsDir: e.IsDir(),
		}
		if e.IsDir() {
			dirs = append(dirs, res)
		} else {
			files = append(files, res)
		}
	}

	sort.Slice(dirs, func(i, j int) bool { return dirs[i].Name < dirs[j].Name })
	sort.Slice(files, func(i, j int) bool { return files[i].Name < files[j].Name })

	out = append(out, dirs...)
	out = append(out, files...)
	return out, capped
}

// mustRel returns filepath.Rel(base, target), falling back to target when
// the relative path cannot be computed.
func mustRel(base, target string) string {
	rel, err := filepath.Rel(base, target)
	if err != nil {
		return target
	}
	return rel
}
