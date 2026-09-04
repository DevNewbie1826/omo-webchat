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

func TestEnsureLockFileSymlinkRejected(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "real.lock")
	const marker = "do-not-truncate"
	if err := os.WriteFile(target, []byte(marker), 0o600); err != nil {
		t.Fatal(err)
	}
	lockPath := filepath.Join(dir, "rpc.sock.ensure.lock")

	if err := os.Symlink(target, lockPath); err != nil {
		t.Skipf("file symlinks need SeCreateSymbolicLinkPrivilege or Developer Mode: %v", err)
	}

	file, err := openAndFlockEnsureLock(lockPath)
	if file != nil {
		_ = file.Close()
		t.Fatal("symlinked lock path was followed and locked")
	}
	if !errors.Is(err, errEnsureLockSymlink) {
		t.Fatalf("symlinked lock error = %v, want errEnsureLockSymlink", err)
	}
	// The reparse point must be rejected before locking or writing, so the
	// target of the file symlink is never truncated.
	got, readErr := os.ReadFile(target)
	if readErr != nil {
		t.Fatalf("read lock target: %v", readErr)
	}
	if string(got) != marker {
		t.Fatalf("lock target content = %q, want %q (lock path was truncated or written)", got, marker)
	}
}

func TestEnsureLockDirectoryJunctionRejected(t *testing.T) {
	dir := t.TempDir()
	junctionTarget := filepath.Join(dir, "junction-target")
	if err := os.Mkdir(junctionTarget, 0o700); err != nil {
		t.Fatal(err)
	}
	lockPath := filepath.Join(dir, "rpc.sock.ensure.lock")

	// Directory junctions are reparse points any user can create (no
	// SeCreateSymbolicLinkPrivilege needed). Opening one exercises the
	// directory-handle path: without FILE_FLAG_BACKUP_SEMANTICS CreateFileW
	// fails before the reparse check and the typed error contract breaks.
	if out, err := exec.Command("cmd", "/c", "mklink", "/J", lockPath, junctionTarget).CombinedOutput(); err != nil {
		t.Skipf("cannot create junction: %v: %s", err, out)
	}

	file, err := openAndFlockEnsureLock(lockPath)
	if file != nil {
		_ = file.Close()
		t.Fatal("junction lock path was followed and locked")
	}
	if !errors.Is(err, errEnsureLockSymlink) {
		t.Fatalf("junction lock error = %v, want errEnsureLockSymlink", err)
	}
	if entries, readErr := os.ReadDir(junctionTarget); readErr != nil {
		t.Fatalf("read junction target: %v", readErr)
	} else if len(entries) != 0 {
		t.Fatalf("junction target gained entries through the lock path: %v", entries)
	}
}
