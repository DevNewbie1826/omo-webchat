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
// absent and restorable. On Windows a missing AF_UNIX endpoint surfaces as
// either Winsock error depending on the path's residual state — WSAENETDOWN
// ("A socket operation encountered a dead network") with no file, or
// WSAECONNREFUSED with a stale socket file left by a dead listener (the
// Windows AF_UNIX socket file is the application's responsibility to
// remove) — so both mean "restore the endpoint" here, unlike unix where
// ECONNREFUSED implies a present path.
func isDialAbsentError(err error) bool {
	return errors.Is(err, os.ErrNotExist) || errors.Is(err, windows.WSAENETDOWN) ||
		errors.Is(err, windows.WSAECONNREFUSED)
}
