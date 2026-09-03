package session

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

const goalSessionID = "01a05dff-ce50-7e6e-afd8-584465582016"

func writeGoalDoc(t *testing.T, agentDir, cwd, sessionID, body string) string {
	t.Helper()
	dir := filepath.Join(agentDir, "sessions", SessionDirNameForCwd(cwd), "extensions", "goal")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, sessionID+".json")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestReadGoalStateProjectsActiveDocument(t *testing.T) {
	agentDir, cwd := t.TempDir(), t.TempDir()
	writeGoalDoc(t, agentDir, cwd, goalSessionID, `{
		"version": 1,
		"goal": {
			"id": "goal-1",
			"threadId": "`+goalSessionID+`",
			"objective": "골 상태 실시간 웹 표시",
			"status": "active",
			"tokensUsed": 5856523,
			"timeUsedSeconds": 17291,
			"createdAt": 1788430891,
			"updatedAt": 1788448206,
			"lastStartedAt": 1788430891
		}
	}`)
	goal, err := ReadGoalState(t.Context(), agentDir, cwd, goalSessionID)
	if err != nil {
		t.Fatal(err)
	}
	if goal == nil {
		t.Fatal("active goal document projected as nil")
	}
	if goal.Objective != "골 상태 실시간 웹 표시" || goal.Status != "active" || goal.ObjectiveTruncated {
		t.Fatalf("goal = %+v", goal)
	}
	if goal.CreatedAt == nil || *goal.CreatedAt != 1788430891 || goal.UpdatedAt == nil || *goal.UpdatedAt != 1788448206 {
		t.Fatalf("timestamps = %+v", goal)
	}
	if goal.BlockedReason != "" || goal.CompletedAt != nil {
		t.Fatalf("active goal carries blocked/completed fields: %+v", goal)
	}
}

func TestReadGoalStateProjectsBlockedAndCompleteDocuments(t *testing.T) {
	agentDir, cwd := t.TempDir(), t.TempDir()
	writeGoalDoc(t, agentDir, cwd, goalSessionID, `{
		"version": 1,
		"goal": {
			"threadId": "`+goalSessionID+`",
			"objective": "blocked objective",
			"status": "blocked",
			"blockedReason": "user interrupted the turn",
			"createdAt": 100,
			"updatedAt": 200,
			"blockedAt": 200
		}
	}`)
	goal, err := ReadGoalState(t.Context(), agentDir, cwd, goalSessionID)
	if err != nil || goal == nil {
		t.Fatalf("goal = %+v, err = %v", goal, err)
	}
	if goal.Status != "blocked" || goal.BlockedReason != "user interrupted the turn" {
		t.Fatalf("blocked goal = %+v", goal)
	}

	writeGoalDoc(t, agentDir, cwd, goalSessionID, `{
		"version": 1,
		"goal": {
			"threadId": "`+goalSessionID+`",
			"objective": "done objective",
			"status": "complete",
			"createdAt": 100,
			"updatedAt": 300,
			"completedAt": 250
		}
	}`)
	goal, err = ReadGoalState(t.Context(), agentDir, cwd, goalSessionID)
	if err != nil || goal == nil {
		t.Fatalf("goal = %+v, err = %v", goal, err)
	}
	if goal.Status != "complete" || goal.BlockedReason != "" || goal.CompletedAt == nil || *goal.CompletedAt != 250 {
		t.Fatalf("complete goal = %+v", goal)
	}
}

func TestReadGoalStateMissingYieldsNilNotError(t *testing.T) {
	agentDir, cwd := t.TempDir(), t.TempDir()
	goal, err := ReadGoalState(t.Context(), agentDir, cwd, goalSessionID)
	if err != nil || goal != nil {
		t.Fatalf("missing goal = (%+v, %v)", goal, err)
	}
	// A chat without a durable session id has no goal surface at all.
	if goal, err := ReadGoalState(t.Context(), agentDir, cwd, ""); err != nil || goal != nil {
		t.Fatalf("empty session id = (%+v, %v)", goal, err)
	}
}

func TestReadGoalStateCorruptOversizedSymlinkMiskeyedYieldNil(t *testing.T) {
	agentDir, cwd := t.TempDir(), t.TempDir()

	t.Run("corrupt json", func(t *testing.T) {
		writeGoalDoc(t, agentDir, cwd, goalSessionID, `{"version": 1, "goal": {`)
		goal, err := ReadGoalState(t.Context(), agentDir, cwd, goalSessionID)
		if err != nil || goal != nil {
			t.Fatalf("corrupt goal = (%+v, %v)", goal, err)
		}
	})

	t.Run("oversized file", func(t *testing.T) {
		writeGoalDoc(t, agentDir, cwd, goalSessionID, `{"goal":{"threadId":"x","objective":"`+string(make([]byte, maxGoalStateBytes+16))+`"}}`)
		goal, err := ReadGoalState(t.Context(), agentDir, cwd, goalSessionID)
		if err != nil || goal != nil {
			t.Fatalf("oversized goal = (%+v, %v)", goal, err)
		}
	})

	t.Run("symlinked file", func(t *testing.T) {
		symCwd := t.TempDir() // own cwd: earlier subtests created a regular file under cwd
		external := filepath.Join(t.TempDir(), "external.json")
		if err := os.WriteFile(external, []byte(`{"goal":{"threadId":"`+goalSessionID+`","objective":"leak","status":"active"}}`), 0o600); err != nil {
			t.Fatal(err)
		}
		dir := filepath.Join(agentDir, "sessions", SessionDirNameForCwd(symCwd), "extensions", "goal")
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(external, filepath.Join(dir, goalSessionID+".json")); err != nil {
			t.Fatal(err)
		}
		goal, err := ReadGoalState(t.Context(), agentDir, symCwd, goalSessionID)
		if err != nil || goal != nil {
			t.Fatalf("symlinked goal = (%+v, %v)", goal, err)
		}
	})

	t.Run("miskeyed threadId", func(t *testing.T) {
		writeGoalDoc(t, agentDir, cwd, goalSessionID, `{"goal":{"threadId":"another-session","objective":"someone else","status":"active"}}`)
		goal, err := ReadGoalState(t.Context(), agentDir, cwd, goalSessionID)
		if err != nil || goal != nil {
			t.Fatalf("miskeyed goal = (%+v, %v)", goal, err)
		}
	})
}

func TestGoalStableReadRetryKeepsGoalByteLimit(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "goal.json")
	if err := os.WriteFile(path, []byte(`{"goal":null}`), 0o600); err != nil {
		t.Fatal(err)
	}
	expected, err := os.Lstat(path)
	if err != nil {
		t.Fatal(err)
	}

	// Replace the file after the caller's Lstat. The first helper attempt must
	// consume the identity mismatch, and the retry must reapply the goal
	// reader's 512 KiB budget rather than the task-store default.
	replacement := filepath.Join(dir, "replacement.json")
	oversized := make([]byte, maxGoalStateBytes+1)
	for i := range oversized {
		oversized[i] = 'x'
	}
	if err := os.WriteFile(replacement, oversized, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(replacement, path); err != nil {
		t.Fatal(err)
	}
	var target storedGoalState
	if _, ok := readStableJSONWithLimit(t.Context(), path, expected, maxGoalStateBytes, &target); ok {
		t.Fatal("oversized replacement passed the goal reader's retry budget")
	}
}

func TestReadGoalStateTruncatesLongObjectives(t *testing.T) {
	agentDir, cwd := t.TempDir(), t.TempDir()
	long := make([]byte, maxGoalObjectiveBytes+100)
	for i := range long {
		long[i] = 'a'
	}
	writeGoalDoc(t, agentDir, cwd, goalSessionID, `{"goal":{"threadId":"`+goalSessionID+`","objective":"`+string(long)+`","status":"active"}}`)
	goal, err := ReadGoalState(t.Context(), agentDir, cwd, goalSessionID)
	if err != nil || goal == nil {
		t.Fatalf("goal = %+v, err = %v", goal, err)
	}
	if !goal.ObjectiveTruncated || len(goal.Objective) > maxGoalObjectiveBytes {
		t.Fatalf("truncated objective len = %d flag = %v", len(goal.Objective), goal.ObjectiveTruncated)
	}
}

func TestReadGoalStateTruncatesWithoutSplittingUTF8(t *testing.T) {
	agentDir, cwd := t.TempDir(), t.TempDir()
	// Three-byte Korean runes sized to straddle the byte boundary.
	runes := ""
	for len(runes) < maxGoalObjectiveBytes+30 {
		runes += "골"
	}
	writeGoalDoc(t, agentDir, cwd, goalSessionID, `{"goal":{"threadId":"`+goalSessionID+`","objective":"`+runes+`","status":"active"}}`)
	goal, err := ReadGoalState(t.Context(), agentDir, cwd, goalSessionID)
	if err != nil || goal == nil {
		t.Fatalf("goal = %+v, err = %v", goal, err)
	}
	if !goal.ObjectiveTruncated || len(goal.Objective) > maxGoalObjectiveBytes {
		t.Fatalf("truncated objective len = %d flag = %v", len(goal.Objective), goal.ObjectiveTruncated)
	}
}

func TestReadGoalStateHonorsContextCancellation(t *testing.T) {
	agentDir, cwd := t.TempDir(), t.TempDir()
	writeGoalDoc(t, agentDir, cwd, goalSessionID, `{"goal":{"threadId":"`+goalSessionID+`","objective":"x","status":"active"}}`)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := ReadGoalState(ctx, agentDir, cwd, goalSessionID); err == nil {
		t.Fatal("cancelled context returned nil error")
	}
}

func TestGoalStatePathRejectsUnsafeSessionIDs(t *testing.T) {
	cwd := "/tmp/work"
	for _, bad := range []string{"", "..", ".", "a/b", "./x", "sub/dir"} {
		if _, ok := GoalStatePath("/tmp/agent", cwd, bad); ok {
			t.Fatalf("unsafe session id %q accepted", bad)
		}
	}
	if _, ok := GoalStatePath("", cwd, goalSessionID); ok {
		t.Fatal("empty agent dir accepted")
	}
	if _, ok := GoalStatePath("/tmp/agent", "relative", goalSessionID); ok {
		t.Fatal("relative cwd accepted")
	}
	got, ok := GoalStatePath("/tmp/agent", cwd, goalSessionID)
	if !ok || got != filepath.Join("/tmp/agent", "sessions", "--tmp-work--", "extensions", "goal", goalSessionID+".json") {
		t.Fatalf("path = %q ok = %v", got, ok)
	}
}

func TestEqualGoalStateComparesAllProjectedFields(t *testing.T) {
	a := &GoalState{Objective: "x", Status: "active", CreatedAt: ptrInt64(1)}
	if !EqualGoalState(a, a) {
		t.Fatal("identical states compared unequal")
	}
	b := *a
	b.Status = "blocked"
	if EqualGoalState(a, &b) {
		t.Fatal("status change undetected")
	}
	c := *a
	c.CreatedAt = ptrInt64(2)
	if EqualGoalState(a, &c) {
		t.Fatal("timestamp change undetected")
	}
	if !EqualGoalState(nil, nil) || EqualGoalState(a, nil) {
		t.Fatal("nil handling wrong")
	}
}

func ptrInt64(v int64) *int64 { return &v }
