//go:build darwin || linux

package daemon

import (
	"errors"
	"fmt"
	"os"
	"syscall"
	"time"
)

const pollInterval = 50 * time.Millisecond

var errLockReleaseTimeout = errors.New("timed out waiting for daemon lock to be released")

func openLockFile(path string) (*os.File, error) {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, fmt.Errorf("opening daemon lock file: %w", err)
	}
	return file, nil
}

func lockAcquire(path string) (*os.File, bool, error) {
	file, err := openLockFile(path)
	if err != nil {
		return nil, false, err
	}
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = file.Close()
		if isLockHeld(err) {
			return nil, true, nil
		}
		return nil, false, fmt.Errorf("probing daemon lock: %w", err)
	}
	return file, false, nil
}

func isLockHeld(err error) bool {
	return errors.Is(err, syscall.EWOULDBLOCK) || errors.Is(err, syscall.EAGAIN)
}

func waitForLockFree(path string, timeout time.Duration) (*os.File, error) {
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()
	for {
		file, held, err := lockAcquire(path)
		if err != nil {
			return nil, err
		}
		if !held {
			return file, nil
		}
		select {
		case <-deadline.C:
			return nil, errLockReleaseTimeout
		case <-ticker.C:
		}
	}
}
