//go:build windows

package omorpc

import (
	"errors"
	"os"

	"golang.org/x/sys/windows"
)

func openAndFlockEnsureLock(path string) (*os.File, error) {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	// LockFileEx over one byte is the Windows analogue of BSD flock on the
	// same open file description: LOCKFILE_EXCLUSIVE_LOCK makes the range
	// exclusive and LOCKFILE_FAIL_IMMEDIATELY maps an already-held lock to
	// ERROR_LOCK_VIOLATION, the kernel's counterpart of EWOULDBLOCK.
	overlapped := new(windows.Overlapped)
	if err := windows.LockFileEx(windows.Handle(file.Fd()),
		windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY,
		0, 1, 0, overlapped); err != nil {
		_ = file.Close()
		if errors.Is(err, windows.ERROR_LOCK_VIOLATION) {
			return nil, errEnsureLockHeld
		}
		return nil, err
	}
	return file, nil
}
