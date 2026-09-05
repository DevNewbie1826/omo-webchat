//go:build windows

package omorpc

import (
	"errors"
	"os"
	"syscall"

	"golang.org/x/sys/windows"
)

// isSpawnableProbeError reports whether a failed probe of an existing daemon
// means "no daemon is listening", so EnsureDaemon may spawn one.
//
// Winsock reports refusal as WSAECONNREFUSED (10061), which is a different
// value from Go's Windows syscall.ECONNREFUSED (an internal POSIX-name
// constant a Winsock dial never produces), so the Winsock error must be
// matched explicitly. Dialing an absent or stale AF_UNIX endpoint on Windows
// surfaces as WSAENETDOWN or WSAECONNREFUSED depending on the path's residual
// state — both mean no listener, exactly as isDialAbsentError treats them.
func isSpawnableProbeError(err error) bool {
	return errors.Is(err, os.ErrNotExist) || errors.Is(err, syscall.ENOENT) ||
		errors.Is(err, syscall.ECONNREFUSED) || errors.Is(err, windows.WSAENETDOWN) ||
		errors.Is(err, windows.WSAECONNREFUSED)
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
