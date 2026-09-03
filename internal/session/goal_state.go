package session

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"
)

const (
	// maxGoalStateBytes bounds a single goal-state file read. Files observed
	// by live protocol probing stay a few KiB even with the longest
	// objectives; the bound only rejects damaged or hostile files.
	maxGoalStateBytes = 512 << 10
	// maxGoalObjectiveBytes bounds the objective surfaced on the wire;
	// objectiveTruncated reports that the source text exceeded it.
	maxGoalObjectiveBytes = 8 << 10
)

// GoalState is the projected live goal for one chat, read from the coding
// agent's per-session goal file (layout verified by live protocol probing:
// <agentDir>/sessions/<encoded-cwd>/extensions/goal/<sessionID>.json, written
// atomically via a .tmp sibling). Timestamps are unix seconds.
type GoalState struct {
	Objective          string `json:"objective"`
	ObjectiveTruncated bool   `json:"objectiveTruncated,omitempty"`
	Status             string `json:"status"`
	BlockedReason      string `json:"blockedReason,omitempty"`
	CreatedAt          *int64 `json:"createdAt,omitempty"`
	UpdatedAt          *int64 `json:"updatedAt,omitempty"`
	CompletedAt        *int64 `json:"completedAt,omitempty"`
}

// storedGoalState mirrors the on-disk goal document.
type storedGoalState struct {
	Version int `json:"version"`
	Goal    *struct {
		ThreadID      string `json:"threadId"`
		Objective     string `json:"objective"`
		Status        string `json:"status"`
		BlockedReason string `json:"blockedReason"`
		CreatedAt     *int64 `json:"createdAt"`
		UpdatedAt     *int64 `json:"updatedAt"`
		CompletedAt   *int64 `json:"completedAt"`
	} `json:"goal"`
}

// CodingAgentDir resolves the omo coding agent dir: an explicit environment
// override wins, otherwise ~/.omo/agent.
func CodingAgentDir() string {
	if v := os.Getenv("OMO_CODING_AGENT_DIR"); v != "" {
		return v
	}
	if v := os.Getenv("SENPI_CODING_AGENT_DIR"); v != "" {
		return v
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".omo", "agent")
}

// SessionDirNameForCwd encodes an absolute working directory the way omo
// names per-cwd folders under <agentDir>/sessions/: strip surrounding slashes,
// replace every remaining "/" with "-", then wrap with "--" on both ends.
// Example: /Volumes/storage/workspace/omo-webchat becomes
// --Volumes-storage-workspace-omo-webchat--.
func SessionDirNameForCwd(cwd string) string {
	trimmed := strings.Trim(filepath.Clean(cwd), "/")
	return "--" + strings.ReplaceAll(trimmed, "/", "-") + "--"
}

// GoalStatePath returns the live goal file for one session under agentDir.
// ok is false when agentDir is empty, cwd is not absolute, or sessionID is
// not a single safe path component: the caller-supplied sessionID is the
// only client-influenced path fragment, so it can never introduce a
// separator or relative hop.
func GoalStatePath(agentDir, cwd, sessionID string) (string, bool) {
	if agentDir == "" || !filepath.IsAbs(cwd) || sessionID == "" {
		return "", false
	}
	if sessionID != filepath.Base(sessionID) || sessionID == "." || sessionID == ".." ||
		strings.ContainsRune(sessionID, filepath.Separator) {
		return "", false
	}
	return filepath.Join(agentDir, "sessions", SessionDirNameForCwd(cwd), "extensions", "goal", sessionID+".json"), true
}

// ReadGoalState reads one chat's live goal document. Missing, symlinked,
// oversized, corrupt, concurrently replaced, or miskeyed files yield
// (nil, nil): the goal is optional chrome, never an error surface. Only
// context cancellation is reported as an error.
func ReadGoalState(ctx context.Context, agentDir, cwd, sessionID string) (*GoalState, error) {
	goal, _, err := ReadGoalStateSnapshot(ctx, agentDir, cwd, sessionID)
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return nil, ctxErr
		}
		return nil, nil
	}
	return goal, nil
}

var errGoalStateTransient = errors.New("goal state changed while being read")

// ReadGoalStateSnapshot distinguishes an absent goal document from a present
// document that could not be read stably. On success, info identifies the
// exact file version that produced goal; info is nil only when the path is
// absent. A valid document with no projectable goal returns (nil, info, nil).
func ReadGoalStateSnapshot(ctx context.Context, agentDir, cwd, sessionID string) (*GoalState, os.FileInfo, error) {
	if err := ctx.Err(); err != nil {
		return nil, nil, err
	}
	path, ok := GoalStatePath(agentDir, cwd, sessionID)
	if !ok {
		return nil, nil, nil
	}
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil, nil
	}
	if err != nil || info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() || info.Size() > maxGoalStateBytes {
		return nil, nil, errGoalStateTransient
	}
	var stored storedGoalState
	stableInfo, ok := readStableJSONWithLimit(ctx, path, info, maxGoalStateBytes, &stored)
	if !ok {
		if err := ctx.Err(); err != nil {
			return nil, nil, err
		}
		return nil, nil, errGoalStateTransient
	}
	if stored.Goal == nil || stored.Goal.ThreadID != sessionID || stored.Goal.Objective == "" {
		return nil, stableInfo, nil
	}
	objective, truncated := truncateObjective(stored.Goal.Objective)
	return &GoalState{
		Objective:          objective,
		ObjectiveTruncated: truncated,
		Status:             stored.Goal.Status,
		BlockedReason:      stored.Goal.BlockedReason,
		CreatedAt:          stored.Goal.CreatedAt,
		UpdatedAt:          stored.Goal.UpdatedAt,
		CompletedAt:        stored.Goal.CompletedAt,
	}, stableInfo, nil
}

// readStableJSONWithLimit is the caller-budgeted stable-read seam used by the
// goal path. Every attempt revalidates identity, size, and type; an atomic
// replacement before the first attempt consumes that attempt rather than
// bypassing the retry.
func readStableJSONWithLimit(ctx context.Context, path string, expected os.FileInfo, limit int64, target any) (os.FileInfo, bool) {
	for attempt := 0; attempt < activityHistoryReadRetries; attempt++ {
		if ctx.Err() != nil {
			return nil, false
		}
		before, err := os.Lstat(path)
		if err != nil || before.Mode()&os.ModeSymlink != 0 || !before.Mode().IsRegular() || before.Size() > limit {
			return nil, false
		}
		if !sameFileState(expected, before) {
			expected = before
			continue
		}
		f, err := os.Open(path)
		if err != nil {
			return nil, false
		}
		opened, statErr := f.Stat()
		data, readErr := io.ReadAll(io.LimitReader(contextReader{ctx: ctx, r: f}, limit+1))
		afterOpen, afterOpenErr := f.Stat()
		closeErr := f.Close()
		afterPath, pathErr := os.Lstat(path)
		stable := statErr == nil && afterOpenErr == nil && pathErr == nil && afterPath.Mode()&os.ModeSymlink == 0 &&
			afterPath.Mode().IsRegular() && afterPath.Size() <= limit && sameFileState(before, opened) &&
			sameFileState(opened, afterOpen) && sameFileState(afterOpen, afterPath)
		if readErr == nil && closeErr == nil && stable && len(data) <= int(limit) {
			if json.Unmarshal(data, target) == nil {
				return afterPath, true
			}
			return nil, false
		}
		if ctx.Err() != nil || afterPath == nil || afterPath.Mode()&os.ModeSymlink != 0 ||
			!afterPath.Mode().IsRegular() || afterPath.Size() > limit {
			return nil, false
		}
		expected = afterPath
	}
	return nil, false
}

// truncateObjective caps the objective at maxGoalObjectiveBytes without
// splitting a UTF-8 rune.
func truncateObjective(objective string) (string, bool) {
	if len(objective) <= maxGoalObjectiveBytes {
		return objective, false
	}
	cut := objective[:maxGoalObjectiveBytes]
	for len(cut) > 0 && !utf8.ValidString(cut) {
		cut = cut[:len(cut)-1]
	}
	return cut, true
}

// EqualGoalState reports whether two projections carry identical content;
// the live-update path pushes only on change.
func EqualGoalState(left, right *GoalState) bool {
	if left == nil || right == nil {
		return left == right
	}
	return left.Objective == right.Objective && left.ObjectiveTruncated == right.ObjectiveTruncated &&
		left.Status == right.Status && left.BlockedReason == right.BlockedReason &&
		timestampEqual(left.CreatedAt, right.CreatedAt) && timestampEqual(left.UpdatedAt, right.UpdatedAt) &&
		timestampEqual(left.CompletedAt, right.CompletedAt)
}

func timestampEqual(left, right *int64) bool {
	if left == nil || right == nil {
		return left == right
	}
	return *left == *right
}
