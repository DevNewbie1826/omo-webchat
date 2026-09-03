package session

import (
	"context"
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
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	path, ok := GoalStatePath(agentDir, cwd, sessionID)
	if !ok {
		return nil, nil
	}
	info, err := os.Lstat(path)
	if err != nil || info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() || info.Size() > maxGoalStateBytes {
		return nil, nil
	}
	var stored storedGoalState
	if !readStableJSON(ctx, path, info, &stored) || stored.Goal == nil {
		return nil, nil
	}
	// The document carries its own session identity; a mismatch means the
	// file is not this chat's goal, so it renders nothing.
	if stored.Goal.ThreadID != sessionID || stored.Goal.Objective == "" {
		return nil, nil
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
	}, nil
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
