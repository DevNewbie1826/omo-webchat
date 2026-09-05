//go:build windows

package main

import (
	"errors"
	"fmt"
	"os/exec"
	"sync"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/procexec"
)

func startProbeServer(cmd *exec.Cmd) (<-chan error, func() error, error) {
	tracked, err := procexec.StartTracked(cmd)
	if err != nil {
		return nil, nil, err
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait(); close(done) }()
	var once sync.Once
	var stopErr error
	stop := func() error {
		once.Do(func() {
			stopErr = errors.Join(tracked.TerminateTree(), tracked.WaitTreeGone(10*time.Second), tracked.Close())
			select {
			case err := <-done:
				var exitErr *exec.ExitError
				if err != nil && !errors.As(err, &exitErr) {
					stopErr = errors.Join(stopErr, err)
				}
			case <-time.After(10 * time.Second):
				stopErr = errors.Join(stopErr, fmt.Errorf("server leader did not exit after job drain"))
			}
		})
		return stopErr
	}
	return done, stop, nil
}
