package chat

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

const stderrDoneMarker = "STDERR-CAPTURE-DONE"

// startStderrFixture starts a shell process whose stderr capture lands in
// dir/omo-provider.stderr.log and whose stderr writes are exactly `script`.
func startStderrFixture(t *testing.T, dir, script string) *Process {
	t.Helper()
	sh, err := exec.LookPath("sh")
	if err != nil {
		t.Skipf("sh not in PATH: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	t.Cleanup(cancel)
	proc, err := Start(ctx, ProcessOptions{
		Binary:     sh,
		Args:       []string{"-c", script},
		Env:        os.Environ(),
		StderrPath: filepath.Join(dir, "omo-provider.stderr.log"),
	})
	if err != nil {
		t.Fatalf("start stderr fixture: %v", err)
	}
	t.Cleanup(func() { _ = proc.Close() })
	return proc
}

// waitForFileSubstring waits until path exists and contains substr. The
// bounded wait is a failure watchdog; the provider's stderr drain is the
// producer and cannot be notified on.
func waitForFileSubstring(t *testing.T, path, substr string, timeout time.Duration) []byte {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		b, err := os.ReadFile(path)
		if err == nil && bytes.Contains(b, []byte(substr)) {
			return b
		}
		if time.Now().After(deadline) {
			t.Fatalf("file %s never contained %q (err=%v)", path, substr, err)
		}
		time.Sleep(25 * time.Millisecond)
	}
}

func mustReadByteAt(t *testing.T, path string, offset int64) byte {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatalf("open %s: %v", path, err)
	}
	defer f.Close()
	var buf [1]byte
	if _, err := f.ReadAt(buf[:], offset); err != nil {
		t.Fatalf("read %s at %d: %v", path, offset, err)
	}
	return buf[0]
}

func assertFilePerm(t *testing.T, path string) {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat %s: %v", path, err)
	}
	if got := info.Mode().Perm(); got != 0o600 {
		t.Fatalf("%s mode = %v, want 0600", path, got)
	}
}

// TestProcessCapturesBoundedRotatingStderr pins contract (e): the provider's
// stderr persists into a bounded rotating file pair — active at most 10MiB,
// one backup of at most 10MiB (hard total 20MiB), both 0600; boundary-
// crossing writes are split at the boundary, oversized pre-existing logs are
// rotated before start, and an open failure fails the provider start.
func TestProcessCapturesBoundedRotatingStderr(t *testing.T) {
	if _, err := exec.LookPath("head"); err != nil {
		t.Skipf("head not in PATH: %v", err)
	}

	t.Run("splits boundary-crossing writes", func(t *testing.T) {
		dir := t.TempDir()
		path := filepath.Join(dir, "omo-provider.stderr.log")
		// 6MiB of A then 6MiB of B: the B write crosses the 10MiB budget
		// exactly at the 64KiB-aligned boundary, so the active file rotates
		// mid-chunk and B continues in the fresh active file.
		script := `head -c 6291456 /dev/zero | tr '\000' A >&2; ` +
			`head -c 6291456 /dev/zero | tr '\000' B >&2; ` +
			`echo ` + stderrDoneMarker + ` >&2; exit 0`
		startStderrFixture(t, dir, script)
		waitForFileSubstring(t, path, stderrDoneMarker, 10*time.Second)

		backup := path + ".1"
		backupInfo, err := os.Stat(backup)
		if err != nil {
			t.Fatalf("rotated backup missing: %v", err)
		}
		if backupInfo.Size() != 10<<20 {
			t.Fatalf("backup size = %d, want exactly 10MiB", backupInfo.Size())
		}
		activeInfo, err := os.Stat(path)
		if err != nil {
			t.Fatalf("active file missing: %v", err)
		}
		wantActive := int64(2<<20) + int64(len(stderrDoneMarker)+1)
		if activeInfo.Size() != wantActive {
			t.Fatalf("active size = %d, want %d (B tail plus marker)", activeInfo.Size(), wantActive)
		}
		if got := mustReadByteAt(t, backup, 0); got != 'A' {
			t.Fatalf("backup starts with %q, want A", got)
		}
		if got := mustReadByteAt(t, backup, 6<<20); got != 'B' {
			t.Fatalf("backup at 6MiB = %q, want B (A/B boundary preserved)", got)
		}
		if got := mustReadByteAt(t, backup, 10<<20-1); got != 'B' {
			t.Fatalf("backup tail = %q, want B", got)
		}
		if got := mustReadByteAt(t, path, 0); got != 'B' {
			t.Fatalf("active starts with %q, want B (latest tail)", got)
		}
		assertFilePerm(t, path)
		assertFilePerm(t, backup)
	})

	t.Run("keeps latest tail of an oversized single chunk", func(t *testing.T) {
		dir := t.TempDir()
		sink, err := openStderrSink(filepath.Join(dir, "omo-provider.stderr.log"))
		if err != nil {
			t.Fatal(err)
		}
		chunk := bytes.Repeat([]byte("C"), 11<<20)
		n, err := sink.Write(chunk)
		if err != nil || n != len(chunk) {
			t.Fatalf("oversized chunk write = %d, %v; want full consumption without error", n, err)
		}
		if err := sink.Close(); err != nil {
			t.Fatalf("close sink: %v", err)
		}
		backup, err := os.ReadFile(filepath.Join(dir, "omo-provider.stderr.log.1"))
		if err != nil || len(backup) != 10<<20 {
			t.Fatalf("backup = %d bytes (%v), want exactly 10MiB", len(backup), err)
		}
		active, err := os.ReadFile(filepath.Join(dir, "omo-provider.stderr.log"))
		if err != nil || len(active) != 1<<20 {
			t.Fatalf("active = %d bytes (%v), want exactly 1MiB (latest tail)", len(active), err)
		}
		if !bytes.Equal(active, chunk[10<<20:]) {
			t.Fatal("active is not the latest tail of the oversized chunk")
		}
		if bytes.Contains(backup, []byte(strings.Repeat("C", 1<<20))) == false || backup[0] != 'C' {
			t.Fatal("backup is not the chunk head")
		}
	})

	t.Run("hard total bound across rotations", func(t *testing.T) {
		dir := t.TempDir()
		sink, err := openStderrSink(filepath.Join(dir, "omo-provider.stderr.log"))
		if err != nil {
			t.Fatal(err)
		}
		if n, err := sink.Write(bytes.Repeat([]byte("D"), 25<<20)); err != nil || n != 25<<20 {
			t.Fatalf("25MiB chunk write = %d, %v", n, err)
		}
		if err := sink.Close(); err != nil {
			t.Fatalf("close sink: %v", err)
		}
		backup, _ := os.ReadFile(filepath.Join(dir, "omo-provider.stderr.log.1"))
		active, _ := os.ReadFile(filepath.Join(dir, "omo-provider.stderr.log"))
		if total := len(backup) + len(active); total > 20<<20 {
			t.Fatalf("captured stderr totals %d bytes, want hard bound 20MiB", total)
		}
		if len(active) != 5<<20 || !bytes.Equal(active, bytes.Repeat([]byte("D"), 5<<20)) {
			t.Fatalf("active = %d bytes, want the 5MiB latest tail", len(active))
		}
	})

	t.Run("rotates an oversized log before start", func(t *testing.T) {
		dir := t.TempDir()
		path := filepath.Join(dir, "omo-provider.stderr.log")
		if err := os.WriteFile(path, bytes.Repeat([]byte("Z"), 11<<20), 0o600); err != nil {
			t.Fatal(err)
		}
		startStderrFixture(t, dir, `echo PRESTART-MARKER >&2; exit 0`)
		waitForFileSubstring(t, path, "PRESTART-MARKER", 10*time.Second)
		backup := path + ".1"
		info, err := os.Stat(backup)
		if err != nil {
			t.Fatalf("oversized log was not rotated before start: %v", err)
		}
		if info.Size() != 11<<20 {
			t.Fatalf("backup size = %d, want the pre-existing 11MiB", info.Size())
		}
		active, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if want := int64(len("PRESTART-MARKER\n")); active.Size() != want {
			t.Fatalf("active size = %d, want a fresh log with just the marker (%d)", active.Size(), want)
		}
	})

	t.Run("open failure at start fails the provider", func(t *testing.T) {
		dir := t.TempDir()
		blocker := filepath.Join(dir, "blocker")
		if err := os.WriteFile(blocker, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
		_, err := Start(context.Background(), ProcessOptions{
			Binary:     "sh",
			Args:       []string{"-c", "exit 0"},
			StderrPath: filepath.Join(blocker, "nested", "omo-provider.stderr.log"),
		})
		if err == nil {
			t.Fatal("unopenable stderr sink did not fail the provider start")
		}
		if !strings.Contains(err.Error(), "stderr sink") {
			t.Fatalf("start error = %v, want a stderr sink failure", err)
		}
	})

	t.Run("sink failures degrade to discard mode", func(t *testing.T) {
		dir := t.TempDir()
		sink, err := openStderrSink(filepath.Join(dir, "omo-provider.stderr.log"))
		if err != nil {
			t.Fatal(err)
		}
		// Break the sink mid-stream: the drain must keep consuming without
		// error so the provider can never block on its stderr.
		_ = sink.file.Close()
		sink.file = nil
		big := bytes.Repeat([]byte("E"), 3<<20)
		if n, err := sink.Write(big); err != nil || n != len(big) {
			t.Fatalf("discard-mode write = %d, %v; want silent full consumption", n, err)
		}
	})
}

// TestProcessInheritedStderrDoesNotBlockReap pins the reap-safety half of the
// owned-stderr-pipe design: a descendant that escaped the process group keeps
// the provider's stderr write end open, yet the leader's reap completes
// (cmd.Wait never waits for stderr) and the escaped descendant's late stderr
// output is still captured.
func TestProcessInheritedStderrDoesNotBlockReap(t *testing.T) {
	sh := requireShellAndFifo(t)
	if _, err := exec.LookPath("perl"); err != nil {
		t.Skipf("perl not in PATH: %v", err)
	}
	dir := t.TempDir()
	fifo := filepath.Join(dir, "hold.fifo")
	sentinel := filepath.Join(dir, "detached.sentinel")
	path := filepath.Join(dir, "omo-provider.stderr.log")
	const marker = "inherited-stderr-marker"
	script := `mkfifo ` + fifo + ` && perl -e '
setpgrp(0,0);
open(my $s, ">", $ARGV[1]) or exit 4; print $s "detached\n"; close $s;
open(my $fh, "<", $ARGV[0]) or exit 4; <$fh>;
print STDERR "` + marker + `\n";
exit 0' ` + fifo + ` ` + sentinel + ` & ` +
		`until [ -f ` + sentinel + ` ]; do sleep 0.05; done; exit 0`
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	t.Cleanup(cancel)
	proc, err := Start(ctx, ProcessOptions{
		Binary:     sh,
		Args:       []string{"-c", script},
		Env:        os.Environ(),
		StderrPath: path,
	})
	if err != nil {
		t.Fatal(err)
	}
	// Best-effort release of the fixture if a later step fails: a nonblocking
	// writer open pairs instantly once the descendant opens its read end, or
	// fails harmlessly when it is already gone.
	t.Cleanup(func() {
		if f, ferr := os.OpenFile(fifo, os.O_WRONLY|syscall.O_NONBLOCK, 0); ferr == nil {
			_, _ = f.WriteString("cleanup\n")
			_ = f.Close()
		}
	})

	// The leader exits only after the descendant detached (sentinel), so the
	// reap's group kill cannot reach it: stderr stays held open across the
	// reap. Wait for the self-exit, then prove Close returns promptly —
	// cmd.Wait never waits for the stderr drain.
	waitSentinel := make(chan struct{})
	go func() {
		for {
			if _, err := os.Stat(sentinel); err == nil {
				close(waitSentinel)
				return
			}
			time.Sleep(10 * time.Millisecond)
		}
	}()
	select {
	case <-waitSentinel:
	case <-time.After(10 * time.Second):
		t.Fatal("fixture descendant never detached from the provider process group")
	}
	select {
	case <-proc.exited:
	case <-time.After(10 * time.Second):
		t.Fatal("leader never self-exited after the descendant detached")
	}
	closeResult := make(chan error, 1)
	go func() { closeResult <- proc.Close() }()
	select {
	case err := <-closeResult:
		if err != nil {
			t.Fatalf("close process: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("reap blocked while an inherited stderr stayed open: cmd.Wait waited for stderr EOF")
	}

	// The escaped descendant still holds stderr: let it write and prove the
	// capture picked up post-reap output.
	fifoOpen := make(chan struct{})
	go func() {
		f, ferr := os.OpenFile(fifo, os.O_WRONLY, 0)
		if ferr != nil {
			return
		}
		_, _ = f.WriteString("go\n")
		_ = f.Close()
		close(fifoOpen)
	}()
	select {
	case <-fifoOpen:
	case <-time.After(10 * time.Second):
		t.Fatal("the detached descendant did not survive the group kill")
	}
	waitForFileSubstring(t, path, marker, 10*time.Second)
}

// TestSharedProviderWiresStderrCapture pins the SessionOptions→
// ProcessOptions wiring: a provider started through startSharedProvider with
// StderrPath set captures its stderr into that file.
func TestSharedProviderWiresStderrCapture(t *testing.T) {
	sh, err := exec.LookPath("sh")
	if err != nil {
		t.Skipf("sh not in PATH: %v", err)
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "omo-provider.stderr.log")
	const marker = "shared-provider-stderr-wired"
	sp, err := startSharedProvider(context.Background(), SessionOptions{
		Binary:     sh,
		Args:       []string{"-c", `echo ` + marker + ` >&2; read _`},
		Env:        os.Environ(),
		StderrPath: path,
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sp.proc.Close() })
	waitForFileSubstring(t, path, marker, 10*time.Second)
	sp.mu.Lock()
	state := sp.state
	stderrPath := sp.proc.stderrPath
	sp.mu.Unlock()
	if state != sharedProviderStarted {
		t.Fatalf("shared provider state = %d, want started", state)
	}
	if stderrPath != path {
		t.Fatalf("process stderr path = %q, want %q", stderrPath, path)
	}
}
