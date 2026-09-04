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
