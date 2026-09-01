//go:build darwin || linux

package omorpc

import (
	"errors"
	"os"
	"syscall"
)

func openAndFlockEnsureLock(path string) (*os.File, error) {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR|syscall.O_NOFOLLOW, 0o600)
	if err != nil {
		if errors.Is(err, syscall.ELOOP) {
			return nil, errEnsureLockSymlink
		}
		return nil, err
	}
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = file.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) || errors.Is(err, syscall.EAGAIN) {
			return nil, errEnsureLockHeld
		}
		return nil, err
	}
	return file, nil
}
