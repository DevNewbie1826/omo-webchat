package chat

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// firstResumeFailedFrame returns the raw JSON of the single resume_failed
// error frame among the collected frames, failing the test otherwise.
func firstResumeFailedFrame(t *testing.T, frames [][]byte) []byte {
	t.Helper()
	var found []byte
	for _, raw := range frames {
		var envelope struct {
			Type string `json:"type"`
			Code string `json:"code"`
		}
		if json.Unmarshal(raw, &envelope) != nil || envelope.Type != "error" || envelope.Code != "resume_failed" {
			continue
		}
		if found != nil {
			t.Fatalf("multiple resume_failed frames; second: %s", raw)
		}
		found = append([]byte(nil), raw...)
	}
	if found == nil {
		t.Fatalf("no resume_failed frame among %d collected frames", len(frames))
	}
	return found
}

// decodeResumeFailedFrame decodes the resume_failed error frame as a raw JSON
// map so the assertions below compile against ErrorFrame before the
// dangling-recovery fields exist; a missing field is an assertion failure,
// never a compile error.
func decodeResumeFailedFrame(t *testing.T, raw []byte) map[string]any {
	t.Helper()
	var frame map[string]any
	if err := json.Unmarshal(raw, &frame); err != nil {
		t.Fatalf("decode resume_failed frame %s: %v", raw, err)
	}
	return frame
}

// TestAcquireAttachDanglingFailureSignalsRecoveryInfoAndKeepsIdentity pins
// the dangling-session wire contract on the manager's permanent-resume-failure
// branch: when the stored identity is an absolute path whose file is gone and
// the provider rejects the doomed open permanently, the resume_failed error
// frame must tell the client the stored path is dangling (dangling=true),
// echo the stored identity verbatim, and carry no branch candidates (none are
// wired at the manager level) — while the stored binding stays untouched and
// a fresh cwd session keeps the chat usable.
func TestAcquireAttachDanglingFailureSignalsRecoveryInfoAndKeepsIdentity(t *testing.T) {
	dangling := filepath.Join(t.TempDir(), "gone", "dangling-session.jsonl")
	if _, err := os.Stat(dangling); !os.IsNotExist(err) {
		t.Fatalf("setup: dangling path %q unexpectedly exists: %v", dangling, err)
	}
	const freshIdentity = "fresh-identity.jsonl"

	identities := &identityLog{value: dangling}
	writer := newCollectWriter()
	session, cmds, err := runScriptedAcquire(t, SessionOptions{
		ID:               "chat-resume-dangling-signal",
		Cwd:              t.TempDir(),
		Provider:         "omo",
		PiSessionID:      dangling,
		OnResumeIdentity: identities.persist,
	}, writer, failPathOpen("open_failed: no such session", "rpc-fresh", freshIdentity))
	if err != nil {
		t.Fatalf("AcquireAttach: %v", err)
	}
	if session == nil || !session.ProcessAlive() {
		t.Fatal("dangling stored path did not leave a usable cwd session")
	}
	if n := sessionPathOpens(cmds, dangling); n != 1 {
		t.Fatalf("open_session was sent %d time(s) for dangling path %q, want exactly 1 (the provider owns validity); commands: %v", n, dangling, cmds)
	}
	if n := resumeFailedCount(writer.snapshot()); n != 1 {
		t.Fatalf("resume_failed frames = %d, want 1; frames: %s", n, writer.typesString())
	}
	assertStoredIdentityUnchanged(t, identities, dangling)

	frame := decodeResumeFailedFrame(t, firstResumeFailedFrame(t, writer.snapshot()))
	raw, _ := json.Marshal(frame)
	flag, isBool := frame["dangling"].(bool)
	if !isBool || !flag {
		t.Fatalf("resume_failed frame dangling = %#v, want true for missing path %q; frame: %s", frame["dangling"], dangling, raw)
	}
	if got, _ := frame["storedIdentity"].(string); got != dangling {
		t.Fatalf("resume_failed frame storedIdentity = %#v, want the stored path %q echoed; frame: %s", frame["storedIdentity"], dangling, raw)
	}
	if candidates, present := frame["branchCandidates"]; present {
		if list, ok := candidates.([]any); !ok || len(list) != 0 {
			t.Fatalf("resume_failed frame branchCandidates = %#v, want absent or empty (no branch callback is wired at the manager level); frame: %s", candidates, raw)
		}
	}
}

// TestAcquireAttachMissingPathFailureKeepsDanglingFalseWhenFileExists is the
// negative control for the dangling signal: when the stored path still exists
// on disk, a permanent resume failure must NOT flag the frame as dangling —
// decoded dangling stays absent-or-false.
func TestAcquireAttachMissingPathFailureKeepsDanglingFalseWhenFileExists(t *testing.T) {
	stored := filepath.Join(t.TempDir(), "existing-session.jsonl")
	if err := os.WriteFile(stored, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	const freshIdentity = "fresh-identity.jsonl"

	identities := &identityLog{value: stored}
	writer := newCollectWriter()
	session, _, err := runScriptedAcquire(t, SessionOptions{
		ID:               "chat-resume-existing-path",
		Cwd:              t.TempDir(),
		Provider:         "omo",
		PiSessionID:      stored,
		OnResumeIdentity: identities.persist,
	}, writer, failPathOpen("open_failed: provider rejected session", "rpc-fresh", freshIdentity))
	if err != nil {
		t.Fatalf("AcquireAttach: %v", err)
	}
	if session == nil || !session.ProcessAlive() {
		t.Fatal("permanent resume failure did not leave a usable cwd session")
	}
	if n := resumeFailedCount(writer.snapshot()); n != 1 {
		t.Fatalf("resume_failed frames = %d, want 1; frames: %s", n, writer.typesString())
	}
	assertStoredIdentityUnchanged(t, identities, stored)

	frame := decodeResumeFailedFrame(t, firstResumeFailedFrame(t, writer.snapshot()))
	raw, _ := json.Marshal(frame)
	if rawFlag, present := frame["dangling"]; present {
		if flag, isBool := rawFlag.(bool); !isBool || flag {
			t.Fatalf("resume_failed frame dangling = %#v, want absent or false because %q exists on disk; frame: %s", rawFlag, stored, raw)
		}
	}
}
