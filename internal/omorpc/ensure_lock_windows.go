//go:build windows

package omorpc

import (
	"errors"
	"os"

	"golang.org/x/sys/windows"
)

func openAndFlockEnsureLock(path string) (*os.File, error) {
	pathUTF16, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	// FILE_FLAG_OPEN_REPARSE_POINT makes CreateFileW open the reparse point
	// itself instead of traversing it, so a symlinked lock path is detected
	// via FILE_ATTRIBUTE_REPARSE_POINT and rejected below before any locking
	// or writing — the Windows counterpart of O_NOFOLLOW on unix.
	// FILE_FLAG_BACKUP_SEMANTICS is required to open directory handles, so a
	// directory junction (a reparse point any user can create) reaches the
	// rejection below instead of failing CreateFileW outright.
	handle, err := windows.CreateFile(pathUTF16,
		windows.GENERIC_READ|windows.GENERIC_WRITE,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		nil,
		windows.OPEN_ALWAYS,
		windows.FILE_ATTRIBUTE_NORMAL | windows.FILE_FLAG_BACKUP_SEMANTICS |
			windows.FILE_FLAG_OPEN_REPARSE_POINT,
		0)
	if err != nil {
		return nil, err
	}
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(handle, &info); err != nil {
		_ = windows.CloseHandle(handle)
		return nil, err
	}
	if info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		_ = windows.CloseHandle(handle)
		return nil, errEnsureLockSymlink
	}
	file := os.NewFile(uintptr(handle), path)

	// LockFileEx over one byte is the Windows analogue of BSD flock on the
	// same open file description: LOCKFILE_EXCLUSIVE_LOCK makes the range
	// exclusive and LOCKFILE_FAIL_IMMEDIATELY makes a contested request fail
	// instead of blocking. A held lock surfaces as ERROR_LOCK_VIOLATION or,
	// for overlapping exclusive requests, ERROR_IO_PENDING; both mean
	// contention, so both map to errEnsureLockHeld. Closing the handle below
	// also cancels any I/O left pending by the second code path.
	overlapped := new(windows.Overlapped)
	if err := windows.LockFileEx(windows.Handle(file.Fd()),
		windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY,
		0, 1, 0, overlapped); err != nil {
		_ = file.Close()
		if errors.Is(err, windows.ERROR_LOCK_VIOLATION) || errors.Is(err, windows.ERROR_IO_PENDING) {
			return nil, errEnsureLockHeld
		}
		return nil, err
	}
	return file, nil
}
