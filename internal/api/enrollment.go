package api

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"sync"

	"github.com/DevNewbie1826/omo-webchat/internal/cursorstore"
	"github.com/DevNewbie1826/omo-webchat/internal/rpcwatch"
)

func (s *Server) startRPCWatcher(caller rpcwatch.Caller) func() {
	ctx, cancel := context.WithCancel(s.ctx)
	s.rpcWatcher = rpcwatch.New(caller, rpcwatch.WithSnapshot(func(sessions []rpcwatch.Session) {
		if err := s.reconcileEnrollment(sessions); err != nil {
			s.logger.Error("enrolling daemon sessions", "err", err)
		}
		s.applyEnrollmentLive(ctx, sessions)
	}))
	done := make(chan struct{})
	go func() {
		defer close(done)
		s.rpcWatcher.Run(ctx)
	}()
	var once sync.Once
	return func() { once.Do(func() { cancel(); <-done }) }
}

// enrollmentPath compares directory aliases even before a path exists.
func enrollmentPath(path string) (string, error) {
	resolved, err := filepath.EvalSymlinks(path)
	if err == nil {
		return filepath.Abs(filepath.Clean(resolved))
	}
	absolute, err := filepath.Abs(filepath.Clean(path))
	if err != nil {
		return "", err
	}
	// Preserve the absolute fallback, but resolve existing parent aliases so
	// a missing suffix beneath an escaping symlink cannot bypass the root gate.
	if resolved, err := canonicalPathAllowMissing(absolute); err == nil {
		return resolved, nil
	}
	return absolute, nil
}

func (s *Server) reconcileEnrollment(sessions []rpcwatch.Session) error {
	root, err := enrollmentPath(s.cfg.Root)
	if err != nil {
		return err
	}
	// REST in-place registration and deletion use these same serialization
	// boundaries, so a tick cannot resurrect a chat between removal and tombstone.
	s.adoptionMu.Lock()
	defer s.adoptionMu.Unlock()
	s.chatLifecycleMu.Lock()
	defer s.chatLifecycleMu.Unlock()
	for _, live := range sessions {
		if live.Cwd == "" || live.DurableSessionID == "" || !filepath.IsAbs(live.SessionPath) || s.cursors.EnrollmentDeleted(live.DurableSessionID) {
			continue
		}
		cwd, err := enrollmentPath(live.Cwd)
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(root, cwd)
		if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			continue
		}
		var ws cursorstore.Workspace
		for _, candidate := range s.cursors.ListWorkspaces() {
			path, err := enrollmentPath(candidate.Path)
			if err == nil && path == cwd {
				ws = candidate
				break
			}
		}
		if ws.ID == "" {
			id, err := newID("ws-")
			if err != nil {
				return err
			}
			ws = cursorstore.Workspace{ID: id, Name: filepath.Base(cwd), Path: cwd}
			if err := s.cursors.SaveWorkspace(ws); err != nil {
				return err
			}
		}
		found := false
		for _, chat := range s.cursors.ListChats(ws.ID) {
			if !enrollmentMatches(chat, live) {
				continue
			}
			found = true
			if s.chatDeleting[chat.ID] {
				break
			}
			name := strings.TrimSpace(live.Name)
			if (chat.AutoEnrolled || chat.DurableSessionID == "") && (chat.SessionFile != live.SessionPath || chat.DurableSessionID != live.DurableSessionID) || chat.TitleIsPlaceholder && name != "" {
				if err := s.cursors.RefreshEnrollment(chat.ID, live.SessionPath, live.DurableSessionID, name); err != nil && !errors.Is(err, cursorstore.ErrNotFound) {
					return err
				}
			}
			break
		}
		if found {
			continue
		}
		id, err := newID("chat-")
		if err != nil {
			return err
		}
		name := strings.TrimSpace(live.Name)
		placeholder := name == ""
		if placeholder {
			name = "New session"
		}
		chat := cursorstore.Chat{ID: id, WorkspaceID: ws.ID, CWD: live.Cwd, SessionFile: live.SessionPath, DurableSessionID: live.DurableSessionID,
			SessionProvenance: cursorstore.SessionProvenanceInPlace, AutoEnrolled: true, Name: name, NameSource: cursorstore.NameSourceAuto,
			TitleIsPlaceholder: placeholder, CreatedAt: now().UnixMilli()}
		if err := s.cursors.SaveChat(chat); err != nil {
			return err
		}
	}
	return nil
}

func enrollmentMatches(chat cursorstore.Chat, live rpcwatch.Session) bool {
	if chat.DurableSessionID != "" && live.DurableSessionID != "" {
		// A different durable id is a replacement, even at the same path.
		return chat.DurableSessionID == live.DurableSessionID
	}
	if chat.SessionFile == "" || live.SessionPath == "" {
		return false
	}
	stored, err := enrollmentPath(chat.SessionFile)
	if err != nil {
		return false
	}
	observed, err := enrollmentPath(live.SessionPath)
	return err == nil && stored == observed
}
