//go:build unix

package chat

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

// maskedLeaderScript backgrounds a descendant that inherits the provider's
// stdout and then blocks indefinitely opening a FIFO for reading, while the
// leader exits at once with code 3. Because the descendant keeps the stdout
// pipe open, the leader's exit alone never produces EOF: only killing the
// process group does. mkfifo runs first and emits a ready frame so the setup
// is verified before the leader exits.
func maskedLeaderScript(fifo string) string {
	return `mkfifo ` + fifo + ` && printf '{"type":"ready"}\n'; cat ` + fifo + ` & exit 3`
}

func maskedMultiSessionScript(fifo string) string {
	return `read request; mkfifo ` + fifo + ` && printf '{"type":"response","command":"open_session","success":true,"id":"webchat-open-1","sessionId":"rpc-1","data":{"sessionId":"rpc-1","state":{"sessionId":"durable-1"}}}\n'; cat ` + fifo + ` & exit 3`
}

func requireShellAndFifo(t *testing.T) string {
	t.Helper()
	sh, err := exec.LookPath("sh")
	if err != nil {
		t.Skipf("sh not in PATH: %v", err)
	}
	for _, tool := range []string{"mkfifo", "cat"} {
		if _, err := exec.LookPath(tool); err != nil {
			t.Skipf("%s not in PATH: %v", tool, err)
		}
	}
	return sh
}

func countPiEOF(w *collectWriter) int {
	n := 0
	for _, f := range w.snapshot() {
		var ef ErrorFrame
		if json.Unmarshal(f, &ef) == nil && ef.Type == "error" && ef.Code == "pi_eof" {
			n++
		}
	}
	return n
}

// The leader exits while a descendant holds stdout. Events must still close:
// the independent reap kills the process group, the descendant dies, stdout
// reaches EOF, and the leader's real exit code survives. Channel close is the
// deterministic "descendant died" signal; the timeout is only a failure
// detector.
func TestProcessReapsLeaderMaskedByDescendantStdout(t *testing.T) {
	sh := requireShellAndFifo(t)
	fifo := filepath.Join(t.TempDir(), "hold.fifo")

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	t.Cleanup(cancel)
	proc, err := Start(ctx, ProcessOptions{Binary: sh, Args: []string{"-c", maskedLeaderScript(fifo)}, Env: os.Environ()})
	if err != nil {
		t.Fatalf("start process: %v", err)
	}

	events := make(chan Event, 16)
	go proc.Events(events)

	// The ready frame proves mkfifo ran before the leader exits, so the
	// backgrounded cat is genuinely blocked on the FIFO holding stdout.
	select {
	case ev, ok := <-events:
		if !ok || ev.Type != "ready" {
			t.Fatalf("first event = %+v (ok=%v), want ready", ev, ok)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("setup frame never arrived")
	}

	closed := make(chan struct{})
	go func() {
		for range events {
		}
		close(closed)
	}()
	select {
	case <-closed:
	case <-time.After(5 * time.Second):
		t.Fatal("stdout never reached EOF: leader exit masked by a descendant holding stdout")
	}
	if err := proc.Close(); exitCodeOf(err) != 3 {
		t.Fatalf("close error = %v, want exit status 3", err)
	}
}

// The exact session must evict exactly once even though a descendant masks the
// leader's exit by holding stdout: one pi_eof frame, one OnExit for the live
// session, and the manager no longer serves it.
func TestManagerEvictsOnceWhenLeaderExitMaskedByDescendant(t *testing.T) {
	sh := requireShellAndFifo(t)
	fifo := filepath.Join(t.TempDir(), "hold.fifo")

	manager := NewManager()
	t.Cleanup(manager.CloseAll)

	exited := make(chan *Session, 2)
	writer := newCollectWriter()
	opts := SessionOptions{
		ID:              "chat-masked",
		Binary:          sh,
		Args:            []string{"-c", maskedMultiSessionScript(fifo)},
		Env:             os.Environ(),
		OnExit:          func(s *Session) { exited <- s },
		ProviderContext: context.Background(),
	}
	session, _, detach, err := manager.AcquireAttach(context.Background(), opts, writer)
	if err != nil {
		t.Fatalf("start session: %v", err)
	}
	defer detach()
	session.mu.Lock()
	var providerDone <-chan struct{}
	if session.shared != nil {
		providerDone = session.shared.done
	}
	session.mu.Unlock()
	if providerDone == nil {
		t.Fatal("session has no shared provider after acquire")
	}

	select {
	case got := <-exited:
		if got != session {
			t.Fatalf("exit hook session = %p, want %p", got, session)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("leader exit masked by descendant holding stdout: session never evicted")
	}
	if current := manager.Get("chat-masked"); current != nil {
		t.Fatalf("manager still serves evicted session %p", current)
	}

	// Once the pump has fully settled, a duplicate eviction is impossible to
	// miss. Snapshot the done channel before death: providerExited clears
	// session.shared so the pointer is gone by the time OnExit returns.
	<-providerDone
	select {
	case dup := <-exited:
		t.Fatalf("exit hook fired twice: %p", dup)
	default:
	}
	if n := countPiEOF(writer); n != 1 {
		t.Fatalf("pi_eof frames = %d, want exactly 1", n)
	}
}
