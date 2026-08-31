//go:build unix

package chat

import (
	"context"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

// startSpawningProcess runs a shell whose background grandchild holds the
// write end of a FIFO. Reads from the FIFO reach EOF exactly when every
// descendant is dead, which makes "no leaked children" a deterministic
// assertion with no sleeps or polling.
func startSpawningProcess(t *testing.T, ctx context.Context) (*Process, *os.File) {
	t.Helper()
	sh, err := exec.LookPath("sh")
	if err != nil {
		t.Skipf("sh not in PATH: %v", err)
	}
	for _, tool := range []string{"sleep", "mkfifo"} {
		if _, err := exec.LookPath(tool); err != nil {
			t.Skipf("%s not in PATH: %v", tool, err)
		}
	}
	fifo := filepath.Join(t.TempDir(), "canary.fifo")
	script := `mkfifo ` + fifo + `; printf '{"type":"ready"}\n'; sleep 30 > ` + fifo + ` & wait`
	proc, err := Start(ctx, ProcessOptions{Binary: sh, Args: []string{"-c", script}, Env: os.Environ()})
	if err != nil {
		t.Fatalf("start spawning process: %v", err)
	}
	// The ready event proves mkfifo ran; the FIFO open below then blocks only
	// until the background grandchild attaches its write end.
	collectUntil(t, proc, "ready", 5*time.Second)
	type openResult struct {
		f   *os.File
		err error
	}
	opened := make(chan openResult, 1)
	go func() {
		f, err := os.OpenFile(fifo, os.O_RDONLY, 0)
		opened <- openResult{f, err}
	}()
	select {
	case res := <-opened:
		if res.err != nil {
			t.Fatalf("open canary fifo: %v", res.err)
		}
		t.Cleanup(func() {
			if err := res.f.Close(); err != nil {
				t.Errorf("close canary fifo: %v", err)
			}
		})
		return proc, res.f
	case <-time.After(5 * time.Second):
		t.Fatal("grandchild never opened the canary fifo")
		return nil, nil
	}
}

func awaitCanaryEOF(t *testing.T, r *os.File, what string) {
	t.Helper()
	done := make(chan error, 1)
	go func() {
		_, err := io.Copy(io.Discard, r)
		done <- err
	}()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("read canary fifo: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatalf("%s: canary fifo stayed open: a provider descendant outlived cancellation", what)
	}
}

func TestProcessCloseKillsEntireGroup(t *testing.T) {
	proc, fifo := startSpawningProcess(t, context.Background())
	t.Cleanup(func() {
		if err := proc.Close(); err != nil {
			t.Errorf("close process: %v", err)
		}
	})

	pgid, err := syscall.Getpgid(proc.cmd.Process.Pid)
	if err != nil {
		t.Fatalf("get provider pgid: %v", err)
	}
	if pgid != proc.cmd.Process.Pid {
		t.Fatalf("provider did not get its own process group: pgid=%d pid=%d", pgid, proc.cmd.Process.Pid)
	}

	if err := proc.Close(); err != nil {
		t.Fatalf("close process: %v", err)
	}
	awaitCanaryEOF(t, fifo, "Close")
}

func TestProcessContextCancelKillsEntireGroup(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	proc, fifo := startSpawningProcess(t, ctx)
	t.Cleanup(func() {
		if err := proc.Close(); err != nil {
			t.Errorf("close process: %v", err)
		}
	})

	cancel()
	awaitCanaryEOF(t, fifo, "context cancellation")
	if err := proc.Close(); err != nil {
		t.Fatalf("reap after cancellation: %v", err)
	}
}
