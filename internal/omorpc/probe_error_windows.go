//go:build windows

package omorpc

import (
	"errors"
	"os"
	"syscall"

	"golang.org/x/sys/windows"
)

func isSpawnableProbeError(err error) bool {
	return errors.Is(err, os.ErrNotExist) || errors.Is(err, syscall.ENOENT) ||
		errors.Is(err, syscall.ECONNREFUSED) || errors.Is(err, windows.WSAENETDOWN)
}

// isDialAbsentError reports whether a dial failure means the endpoint is
// absent. Dialing an AF_UNIX path with no listener on Windows surfaces as
// the Winsock WSAENETDOWN error ("A socket operation encountered a dead
// network") rather than os.ErrNotExist — the same live windows-runner
// observation the ensure path classifies through isSpawnableProbeError.
func isDialAbsentError(err error) bool {
	return errors.Is(err, os.ErrNotExist) || errors.Is(err, windows.WSAENETDOWN)
}
