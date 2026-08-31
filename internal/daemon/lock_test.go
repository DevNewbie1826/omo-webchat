//go:build darwin || linux

package daemon

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

func TestProbeLock(t *testing.T) {
	path := filepath.Join(t.TempDir(), lockFileName)
	owner, err := openLockFile(path)
	if err != nil {
		t.Fatalf("openLockFile() error = %v", err)
	}
	defer func() { _ = owner.Close() }()
	if err := syscall.Flock(int(owner.Fd()), syscall.LOCK_EX); err != nil {
		t.Fatalf("Flock(LOCK_EX) error = %v", err)
	}

	file, held, err := lockAcquire(path)
	if err != nil {
		t.Fatalf("lockAcquire() error = %v", err)
	}
	if file != nil || !held {
		t.Fatalf("lockAcquire() = (%v, %t), want (nil, true)", file, held)
	}
	if err := syscall.Flock(int(owner.Fd()), syscall.LOCK_UN); err != nil {
		t.Fatalf("Flock(LOCK_UN) error = %v", err)
	}

	file, held, err = lockAcquire(path)
	if err != nil {
		t.Fatalf("lockAcquire() after release error = %v", err)
	}
	if file == nil || held {
		t.Fatalf("lockAcquire() after release = (%v, %t), want (file, false)", file, held)
	}
	if err := file.Close(); err != nil {
		t.Fatalf("closing acquired lock file: %v", err)
	}
}

func TestDaemonLockHandoff(t *testing.T) {
	if os.Getenv("TH_TEST_DAEMON_LOCK_HELPER") == "1" {
		path := os.Getenv("TH_TEST_DAEMON_LOCK_PATH")
		file, err := openLockFile(path)
		if err != nil {
			t.Fatalf("helper openLockFile() error = %v", err)
		}
		defer func() { _ = file.Close() }()
		err = syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		if !isLockHeld(err) {
			t.Fatalf("helper Flock(LOCK_EX|LOCK_NB) error = %v, want held lock", err)
		}
		if _, err := fmt.Fprint(os.Stdout, "lock held\n"); err != nil {
			t.Fatalf("writing lock-held signal: %v", err)
		}
		return
	}

	path := filepath.Join(t.TempDir(), lockFileName)
	owner, err := openLockFile(path)
	if err != nil {
		t.Fatalf("openLockFile() error = %v", err)
	}
	if err := syscall.Flock(int(owner.Fd()), syscall.LOCK_EX); err != nil {
		_ = owner.Close()
		t.Fatalf("Flock(LOCK_EX) error = %v", err)
	}

	file, held, err := lockAcquire(path)
	if err != nil {
		_ = owner.Close()
		t.Fatalf("lockAcquire() before handoff error = %v", err)
	}
	if file != nil || !held {
		_ = owner.Close()
		t.Fatalf("lockAcquire() before handoff = (%v, %t), want (nil, true)", file, held)
	}

	cmd := exec.Command(os.Args[0], "-test.run=^TestDaemonLockHandoff$")
	cmd.Env = append(os.Environ(), "TH_TEST_DAEMON_LOCK_HELPER=1", "TH_TEST_DAEMON_LOCK_PATH="+path)
	cmd.ExtraFiles = []*os.File{owner}
	output, err := cmd.Output()
	if err != nil {
		_ = owner.Close()
		t.Fatalf("helper process error = %v", err)
	}
	if !strings.Contains(string(output), "lock held\n") {
		_ = owner.Close()
		t.Fatalf("helper output = %q, want lock-held signal", output)
	}
	if err := owner.Close(); err != nil {
		t.Fatalf("closing parent lock file: %v", err)
	}

	file, held, err = lockAcquire(path)
	if err != nil {
		t.Fatalf("lockAcquire() after handoff error = %v", err)
	}
	if file == nil || held {
		t.Fatalf("lockAcquire() after handoff = (%v, %t), want (file, false)", file, held)
	}
	if err := file.Close(); err != nil {
		t.Fatalf("closing acquired lock file: %v", err)
	}
}
