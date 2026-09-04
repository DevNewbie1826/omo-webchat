//go:build !windows

package omorpc

import (
	"errors"
	"os"
	"syscall"
)

func isSpawnableProbeError(err error) bool {
	return errors.Is(err, os.ErrNotExist) || errors.Is(err, syscall.ENOENT) ||
		errors.Is(err, syscall.ECONNREFUSED)
}

// isDialAbsentError reports whether a dial failure means the endpoint is
// absent (no listener at the path) — the reconnect path uses it to decide
// whether the OnDialNotExist hook can restore the endpoint.
func isDialAbsentError(err error) bool {
	return errors.Is(err, os.ErrNotExist)
}
