package chat

import (
	"context"
	"os/exec"
	"testing"
	"time"
)

func startSleepSession(t *testing.T, id string) *Session {
	t.Helper()
	shell, err := exec.LookPath("sleep")
	if err != nil {
		t.Skipf("sleep not in PATH: %v", err)
	}
	s, err := StartSession(context.Background(), SessionOptions{
		ID:     id,
		Binary: shell,
		Args:   []string{"30"},
	})
	if err != nil {
		t.Fatalf("start session: %v", err)
	}
	return s
}

func sleepOpts(id string) SessionOptions {
	shell, _ := exec.LookPath("sleep")
	return SessionOptions{ID: id, Binary: shell, Args: []string{"30"}}
}

// Replacing a session closes the old one while a provider write may be stuck
// (writeMu held by an in-flight command to a provider that stopped reading).
// Manager.Start must swap the map entry under the lock and close the old
// Acquiring the same live session must return immediately and preserve the
// process even when its stdin writer is stuck; unrelated sessions stay usable.
func TestManagerAcquireDoesNotCloseLiveSession(t *testing.T) {
	if _, err := exec.LookPath("sleep"); err != nil {
		t.Skipf("sleep not in PATH: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	manager := NewManager()
	t.Cleanup(manager.CloseAll)

	oldSession, _, err := manager.Acquire(ctx, managedMockOptions(t, "chat-a"))
	if err != nil {
		t.Fatalf("start old session: %v", err)
	}
	if _, _, err := manager.Acquire(ctx, managedMockOptions(t, "chat-b")); err != nil {
		t.Fatalf("start other session: %v", err)
	}

	// Simulate a provider that stopped draining stdin: the writer goroutine
	// parks inside an in-flight write to a wedged stdin and is released only
	// by process death or an explicit un-wedge.
	wedge := parkWriterOnBlockedStdin(oldSession.shared.proc)
	t.Cleanup(func() { wedge.release() })

	replaced := make(chan struct{})
	go func() {
		_, _, _ = manager.Acquire(ctx, managedMockOptions(t, "chat-a"))
		close(replaced)
	}()

	select {
	case <-replaced:
		if current := manager.Get("chat-a"); current != oldSession {
			t.Fatalf("acquire replaced the live session: current = %p, want %p", current, oldSession)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("acquiring the live session stalled")
	}
}

// Session.Close must cancel the process context and reap, never writing an
// abort to stdin first: with a wedged in-flight stdin write, an
// abort-before-cancel Close deadlocks and the process is never killed.
func TestSessionCloseCancelsWithoutAbortWrite(t *testing.T) {
	s := startSleepSession(t, "chat-close")
	wedge := parkWriterOnBlockedStdin(s.proc)
	t.Cleanup(func() { wedge.release() })

	done := make(chan error, 1)
	go func() { done <- s.Close() }()

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("close returned error: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Close blocked on an in-flight stdin write: abort sent before cancel")
	}
}
