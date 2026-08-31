package chat

import (
	"bufio"
	"bytes"
	"context"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
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

func awaitStderrDrain(t *testing.T, proc *Process) {
	t.Helper()
	if proc.stderrDone == nil {
		t.Fatal("process has no configured stderr drain")
	}
	select {
	case <-proc.stderrDone:
	case <-time.After(10 * time.Second):
		t.Fatal("provider stderr drain did not reach EOF")
	}
}

func assertFileContains(t *testing.T, path, substr string) []byte {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil || !bytes.Contains(b, []byte(substr)) {
		t.Fatalf("file %s does not contain %q (err=%v)", path, substr, err)
	}
	return b
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
		proc := startStderrFixture(t, dir, script)
		awaitStderrDrain(t, proc)
		assertFileContains(t, path, stderrDoneMarker)

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
		proc := startStderrFixture(t, dir, `echo PRESTART-MARKER >&2; exit 0`)
		awaitStderrDrain(t, proc)
		assertFileContains(t, path, "PRESTART-MARKER")
		backup := path + ".1"
		info, err := os.Stat(backup)
		if err != nil {
			t.Fatalf("oversized log was not rotated before start: %v", err)
		}
		if info.Size() != 10<<20 {
			t.Fatalf("backup size = %d, want the latest 10MiB", info.Size())
		}
		assertFilePerm(t, backup)
		active, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if want := int64(len("PRESTART-MARKER\n")); active.Size() != want {
			t.Fatalf("active size = %d, want a fresh log with just the marker (%d)", active.Size(), want)
		}
	})

	t.Run("normalizes a pre-existing backup", func(t *testing.T) {
		dir := t.TempDir()
		path := filepath.Join(dir, "omo-provider.stderr.log")
		backup := path + ".1"
		payload := append(bytes.Repeat([]byte("old"), 1<<20), bytes.Repeat([]byte("Q"), 11<<20)...)
		if err := os.WriteFile(backup, payload, 0o666); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(backup, 0o666); err != nil {
			t.Fatal(err)
		}
		sink, err := openStderrSink(path)
		if err != nil {
			t.Fatal(err)
		}
		if err := sink.Close(); err != nil {
			t.Fatal(err)
		}
		info, err := os.Stat(backup)
		if err != nil {
			t.Fatal(err)
		}
		if info.Size() != 10<<20 {
			t.Fatalf("normalized backup size = %d, want 10MiB", info.Size())
		}
		assertFilePerm(t, backup)
		if got := mustReadByteAt(t, backup, 0); got != 'Q' {
			t.Fatalf("normalized backup starts with %q, want latest tail Q", got)
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
		// Close the live descriptor behind the sink. The next real file write
		// fails with os.ErrInvalid; that first runtime failure must latch
		// discard mode while still consuming the provider stream.
		if err := sink.file.Close(); err != nil {
			t.Fatal(err)
		}
		big := bytes.Repeat([]byte("E"), 3<<20)
		if n, err := sink.Write(big); err != nil || n != len(big) {
			t.Fatalf("failed-sink write = %d, %v; want silent full consumption", n, err)
		}
		if sink.file != nil || !sink.logged {
			t.Fatalf("runtime sink failure did not latch discard mode: file=%v logged=%v", sink.file, sink.logged)
		}
		if n, err := sink.Write(big); err != nil || n != len(big) {
			t.Fatalf("discard-mode follow-up = %d, %v", n, err)
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
	readyFIFO := filepath.Join(dir, "ready.fifo")
	path := filepath.Join(dir, "omo-provider.stderr.log")
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	port := listener.Addr().(*net.TCPAddr).Port
	const marker = "inherited-stderr-marker"
	script := `mkfifo ` + readyFIFO + `; perl -MIO::Socket::INET -e '
$SIG{HUP}="IGNORE"; setpgrp(0,0);
my $sock=IO::Socket::INET->new(PeerAddr=>"127.0.0.1",PeerPort=>$ENV{STDERR_CONTROL_PORT},Proto=>"tcp") or exit 4;
open(my $s, ">", $ARGV[0]) or exit 4; print $s "detached\n"; close $s;
print $sock "detached\n"; <$sock>;
print STDERR "` + marker + `\n";
exit 0' ` + readyFIFO + ` & ` +
		`read _ < ` + readyFIFO + `; exit 0`
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	t.Cleanup(cancel)
	proc, err := Start(ctx, ProcessOptions{
		Binary:     sh,
		Args:       []string{"-c", script},
		Env:        append(os.Environ(), "STDERR_CONTROL_PORT="+strconv.Itoa(port)),
		StderrPath: path,
	})
	if err != nil {
		t.Fatal(err)
	}

	// The control connection is established only after the descendant changed
	// process group. Its exact line witnesses that the ready-FIFO handshake also
	// released the leader, which can now exit without taking the descendant.
	if tcp, ok := listener.(*net.TCPListener); ok {
		_ = tcp.SetDeadline(time.Now().Add(10 * time.Second))
	}
	conn, err := listener.Accept()
	if err != nil {
		t.Fatalf("accept detached descendant: %v", err)
	}
	defer conn.Close()
	if err := conn.SetReadDeadline(time.Now().Add(10 * time.Second)); err != nil {
		t.Fatal(err)
	}
	line, err := bufio.NewReader(conn).ReadString('\n')
	if err != nil || strings.TrimSpace(line) != "detached" {
		t.Fatalf("fixture detach handshake = %q, %v", line, err)
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

	// The escaped descendant still holds stderr: release its exact control
	// read, then await capture EOF rather than polling the filesystem.
	if err := conn.SetWriteDeadline(time.Now().Add(10 * time.Second)); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Write([]byte("go\n")); err != nil {
		t.Fatalf("the detached descendant did not survive the group kill: %v", err)
	}
	awaitStderrDrain(t, proc)
	assertFileContains(t, path, marker)
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
		Args:       []string{"-c", `echo ` + marker + ` >&2; exit 0`},
		Env:        os.Environ(),
		StderrPath: path,
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sp.proc.Close() })
	awaitStderrDrain(t, sp.proc)
	assertFileContains(t, path, marker)
}
