//go:build windows

package omorpc

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestEnsureLockContentionSecondAcquireReportsHeld(t *testing.T) {
	path := filepath.Join(t.TempDir(), "rpc.sock.ensure.lock")

	first, err := openAndFlockEnsureLock(path)
	if err != nil {
		t.Fatalf("first acquire: %v", err)
	}
	defer func() {
		if closeErr := first.Close(); closeErr != nil {
			t.Errorf("release first lock: %v", closeErr)
		}
	}()

	second, err := openAndFlockEnsureLock(path)
	if second != nil {
		_ = second.Close()
		t.Fatal("second acquire succeeded while the first handle holds the lock")
	}
	if !errors.Is(err, errEnsureLockHeld) {
		t.Fatalf("second acquire error = %v, want errEnsureLockHeld", err)
	}
}

func TestEnsureLockReparsePointRejected(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "real.lock")
	const marker = "do-not-truncate"
	if err := os.WriteFile(target, []byte(marker), 0o600); err != nil {
		t.Fatal(err)
	}
	lockPath := filepath.Join(dir, "rpc.sock.ensure.lock")

	symErr := os.Symlink(target, lockPath)
	if symErr != nil {
		// Symbolic links need SeCreateSymbolicLinkPrivilege or Developer
		// Mode; directory junctions are reparse points any user can create
		// and trigger the same rejection.
		junctionTarget := filepath.Join(dir, "junction-target")
		if mkErr := os.Mkdir(junctionTarget, 0o700); mkErr != nil {
			t.Skipf("cannot create symlink target directory: %v", mkErr)
		}
		if out, err := exec.Command("cmd", "/c", "mklink", "/J", lockPath, junctionTarget).CombinedOutput(); err != nil {
			t.Skipf("cannot create reparse point (symlink: %v; junction: %s): %v", symErr, out, err)
		}
	}

	file, err := openAndFlockEnsureLock(lockPath)
	if file != nil {
		_ = file.Close()
		t.Fatal("reparse-point lock path was followed and locked")
	}
	if !errors.Is(err, errEnsureLockSymlink) {
		t.Fatalf("reparse-point lock error = %v, want errEnsureLockSymlink", err)
	}
	// The reparse point must be rejected before locking or writing, so the
	// target of the file symlink is never truncated.
	if got, readErr := os.ReadFile(target); readErr == nil && string(got) != marker {
		t.Fatalf("lock target content = %q, want %q (lock path was truncated or written)", got, marker)
	}
}
