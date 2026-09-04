//go:build !windows

package omorpc

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"syscall"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/procexec"
)

type supervisorHandle struct {
	process *os.Process
}

func startSupervisor(cmd *exec.Cmd) (*supervisorHandle, error) {
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	return &supervisorHandle{process: cmd.Process}, nil
}

func finishSupervisorWait(_ *supervisorHandle, waitErr error) error {
	return waitErr
}

func terminateSupervisor(ctx context.Context, supervisor *supervisorHandle, waitCh <-chan error, gracePeriod, killWait time.Duration) error {
	process := supervisor.process
	if err := signalProcessGroup(process.Pid, syscall.SIGTERM); err != nil {
		return fmt.Errorf("omorpc: terminate daemon process group: %w", err)
	}
	grace := time.NewTimer(gracePeriod)
	defer grace.Stop()
	leaderReaped := false
	for !leaderReaped || processGroupAlive(process.Pid) {
		select {
		case <-waitCh:
			leaderReaped = true
			waitCh = nil
			if !processGroupAlive(process.Pid) {
				return nil
			}
		case <-ctx.Done():
			return ctx.Err()
		case <-grace.C:
			goto kill
		}
	}
	return nil

kill:
	if err := signalProcessGroup(process.Pid, syscall.SIGKILL); err != nil {
		return fmt.Errorf("omorpc: kill daemon process group: %w", err)
	}
	deadline := time.NewTimer(killWait)
	defer deadline.Stop()
	retry := time.NewTicker(10 * time.Millisecond)
	defer retry.Stop()
	for {
		if leaderReaped && !processGroupAlive(process.Pid) {
			return nil
		}
		select {
		case <-waitCh:
			leaderReaped = true
			waitCh = nil
		case <-ctx.Done():
			return ctx.Err()
		case <-deadline.C:
			return errors.New("omorpc: daemon process group did not exit after SIGKILL")
		case <-retry.C:
		}
	}
}

func signalProcessGroup(pid int, signal syscall.Signal) error {
	return procexec.SignalGroup(pid, signal)
}

func processGroupAlive(pid int) bool {
	return procexec.GroupAlive(pid)
}
