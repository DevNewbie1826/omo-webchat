//go:build unix

package main

import (
	"errors"
	"fmt"
	"os/exec"
	"sync"
	"syscall"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/procexec"
)

func startProbeServer(cmd *exec.Cmd) (<-chan error, func() error, error) {
	procexec.SetupCommand(cmd)
	if err := cmd.Start(); err != nil {
		return nil, nil, err
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait(); close(done) }()
	var once sync.Once
	var stopErr error
	stop := func() error {
		once.Do(func() {
			signalErr := cmd.Process.Signal(syscall.SIGTERM)
			select {
			case err := <-done:
				stopErr = err
			case <-time.After(10 * time.Second):
				killErr := procexec.SignalGroup(cmd.Process.Pid, syscall.SIGKILL)
				stopErr = errors.Join(fmt.Errorf("server did not shut down gracefully"), signalErr, killErr)
				select {
				case <-done:
				case <-time.After(5 * time.Second):
					stopErr = errors.Join(stopErr, fmt.Errorf("server did not exit after kill"))
				}
			}
		})
		return stopErr
	}
	return done, stop, nil
}
