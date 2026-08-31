package chat

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"reflect"
	"testing"
	"time"
)

func startResumeSession(t *testing.T, provider, persisted string, env []string, calls chan<- string) (*Session, *collectWriter) {
	t.Helper()
	script := mockPiScript(t)
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skipf("node not in PATH: %v", err)
	}
	writer := newCollectWriter()
	session, err := StartSession(context.Background(), SessionOptions{
		ID:          "chat-resume",
		Binary:      node,
		Args:        []string{script},
		Env:         append(os.Environ(), env...),
		Provider:    provider,
		PiSessionID: persisted,
		OnResumeIdentity: func(_ *Session, identity ResumeIdentity) error {
			calls <- identity.Value
			return nil
		},
	})
	if err != nil {
		t.Fatalf("start session: %v", err)
	}
	session.Attach(writer)
	t.Cleanup(func() {
		if err := session.Close(); err != nil {
			t.Errorf("close resume session: %v", err)
		}
	})
	return session, writer
}

func drainIdentityCalls(t *testing.T, calls <-chan string, count int) []string {
	t.Helper()
	got := make([]string, 0, count)
	deadline := time.After(3 * time.Second)
	for len(got) < count {
		select {
		case value := <-calls:
			got = append(got, value)
		case <-deadline:
			t.Fatalf("timed out waiting for identity callbacks; got %v", got)
		}
	}
	return got
}

func hasErrorCode(frames [][]byte, code string) bool {
	for _, raw := range frames {
		var frame ErrorFrame
		if json.Unmarshal(raw, &frame) == nil && frame.Type == "error" && frame.Code == code {
			return true
		}
	}
	return false
}

// A persisted resume the provider rejects (failed or cancelled) must clear
// the stale identity everywhere, tell the client why, and initialize a fresh
// session instead of leaving the chat dead.
func TestSessionFailedResumeClearsIdentityAndInitializesFresh(t *testing.T) {
	calls := make(chan string, 8)
	session, writer := startResumeSession(t, "omo", "/tmp/dead.jsonl",
		[]string{"MOCK_PI_SWITCH_FAIL=1"}, calls)

	if err := session.Initialize(); err != nil {
		t.Fatalf("initialize: %v", err)
	}
	writer.waitForType(t, "entries", 5*time.Second)

	frames := writer.snapshot()
	if !hasErrorCode(frames, "resume_failed") {
		t.Fatalf("missing resume_failed error frame; frames: %s", writer.typesString())
	}
	got := drainIdentityCalls(t, calls, 2)
	want := []string{"", "mock-omo-session"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("identity callbacks = %v, want %v", got, want)
	}
	if id := session.PiSessionID(); id != "mock-omo-session" {
		t.Fatalf("in-memory identity = %q, want fresh provider identity", id)
	}
}

func TestSessionCancelledResumeClearsIdentity(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skipf("node not in PATH: %v", err)
	}
	calls := make(chan string, 4)
	writer := newCollectWriter()
	session, err := StartSession(context.Background(), SessionOptions{
		ID:          "chat-cancel-resume",
		Binary:      node,
		Args:        []string{"-e", `process.stdin.resume()`},
		Env:         os.Environ(),
		PiSessionID: "stale-id",
		OnResumeIdentity: func(_ *Session, identity ResumeIdentity) error {
			calls <- identity.Value
			return nil
		},
	})
	if err != nil {
		t.Fatalf("start session: %v", err)
	}
	session.Attach(writer)
	t.Cleanup(func() {
		if err := session.Close(); err != nil {
			t.Errorf("close cancelled resume session: %v", err)
		}
	})

	if err := session.Initialize(); err != nil {
		t.Fatalf("initialize: %v", err)
	}
	session.forwardResponse([]byte(`{"type":"response","command":"switch_session","success":true,"data":{"cancelled":true}}`))

	if got := drainIdentityCalls(t, calls, 1); !reflect.DeepEqual(got, []string{""}) {
		t.Fatalf("identity callbacks = %v, want one clear", got)
	}
	if id := session.PiSessionID(); id != "" {
		t.Fatalf("in-memory identity = %q, want cleared", id)
	}
	if !hasErrorCode(writer.snapshot(), "resume_failed") {
		t.Fatalf("missing resume_failed error frame; frames: %s", writer.typesString())
	}
}
