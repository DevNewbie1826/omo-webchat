package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/DevNewbie1826/omo-webchat/internal/cursorstore"
	"github.com/DevNewbie1826/omo-webchat/internal/session"
)

type chatActivityResponse struct {
	Task          json.RawMessage     `json:"task"`
	Dag           json.RawMessage     `json:"dag"`
	TaskOversized bool                `json:"task_oversized"`
	DagOversized  bool                `json:"dag_oversized"`
	TaskDigest    *session.TaskDigest `json:"task_digest"`
	DagDigest     *session.DagDigest  `json:"dag_digest"`
}

func pathWithin(root, target string) bool {
	rel, err := filepath.Rel(root, target)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}

// validatedChatCWD validates that a chat's cwd is absolute, resolvable, and
// inside the workspace, returning the canonical path.
func validatedChatCWD(workspacePath, cwd string) (string, error) {
	if !filepath.IsAbs(workspacePath) || !filepath.IsAbs(cwd) {
		return "", errors.New("chat paths must be absolute")
	}
	workspace, err := filepath.EvalSymlinks(filepath.Clean(workspacePath))
	if err != nil {
		return "", err
	}
	canonicalCWD, err := filepath.EvalSymlinks(filepath.Clean(cwd))
	if err != nil || !pathWithin(workspace, canonicalCWD) {
		return "", errors.New("chat cwd is outside workspace")
	}
	return canonicalCWD, nil
}

// canonicalPathAllowMissing resolves every existing path component, retaining
// only a missing suffix. This catches a symlinked .omo or senpi-task even when
// the final store directories have not been created yet.
func canonicalPathAllowMissing(path string) (string, error) {
	missing := make([]string, 0)
	current := filepath.Clean(path)
	for {
		resolved, err := filepath.EvalSymlinks(current)
		if err == nil {
			for i := len(missing) - 1; i >= 0; i-- {
				resolved = filepath.Join(resolved, missing[i])
			}
			return filepath.Clean(resolved), nil
		}
		if !errors.Is(err, os.ErrNotExist) {
			return "", err
		}
		parent := filepath.Dir(current)
		if parent == current {
			return "", err
		}
		missing = append(missing, filepath.Base(current))
		current = parent
	}
}

func validatedActivityCWD(workspacePath, cwd string) (string, error) {
	canonicalCWD, err := validatedChatCWD(workspacePath, cwd)
	if err != nil {
		return "", err
	}
	store, err := canonicalPathAllowMissing(filepath.Join(canonicalCWD, ".omo", "senpi-task"))
	if err != nil {
		return "", err
	}
	workspace, err := filepath.EvalSymlinks(filepath.Clean(workspacePath))
	if err != nil {
		return "", err
	}
	if !pathWithin(workspace, store) {
		return "", errors.New("activity store is outside workspace")
	}
	return canonicalCWD, nil
}

func (s *Server) handleGetChatActivity(w http.ResponseWriter, r *http.Request) {
	workspace, err := s.cursors.GetWorkspace(r.PathValue("wsId"))
	if err != nil {
		s.writeStoreError(w, err)
		return
	}
	chat, err := s.cursors.GetChat(r.PathValue("chatId"))
	if err != nil || chat.WorkspaceID != workspace.ID {
		s.writeStoreError(w, cursorstore.ErrNotFound)
		return
	}
	cwd, err := validatedActivityCWD(workspace.Path, chat.CWD)
	if err != nil {
		s.logger.Warn("rejecting unconfined chat activity store", "chat_id", chat.ID, "err", err)
		s.writeStoreError(w, cursorstore.ErrNotFound)
		return
	}
	activity, err := session.ReadHistoricalActivity(r.Context(), cwd, chat.DurableSessionID)
	if err != nil {
		if errors.Is(err, r.Context().Err()) {
			return
		}
		s.logger.Error("reading chat activity history failed", "chat_id", chat.ID, "err", err)
		writeError(w, http.StatusInternalServerError, "internal server error")
		return
	}
	writeJSON(w, http.StatusOK, chatActivityResponse{
		Task: activity.ActivityPair.Task, Dag: activity.ActivityPair.Dag,
		TaskOversized: activity.TaskOversized, DagOversized: activity.DagOversized,
		TaskDigest: activity.TaskDigest, DagDigest: activity.DagDigest,
	})
}
