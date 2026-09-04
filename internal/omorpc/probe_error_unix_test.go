//go:build !windows

package omorpc

import (
	"errors"
	"fmt"
	"os"
	"syscall"
	"testing"
)

func TestSpawnableProbeErrorUnix(t *testing.T) {
	for _, err := range []error{
		os.ErrNotExist,
		fmt.Errorf("dial unix: connect: %w", syscall.ENOENT),
		fmt.Errorf("dial unix: connect: %w", syscall.ECONNREFUSED),
	} {
		if !isSpawnableProbeError(err) {
			t.Errorf("isSpawnableProbeError(%v) = false, want true", err)
		}
	}
	for _, err := range []error{
		errors.New("dial failed"),
		fmt.Errorf("dial unix: connect: %w", syscall.EACCES),
		fmt.Errorf("dial unix: connect: %w", syscall.Errno(10050)),
	} {
		if isSpawnableProbeError(err) {
			t.Errorf("isSpawnableProbeError(%v) = true, want false", err)
		}
	}
}
