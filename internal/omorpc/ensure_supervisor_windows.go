//go:build windows

package omorpc

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/procexec"
)

type trackedSupervisor interface {
	TerminateTree() error
	Close() error
}

type supervisorHandle struct {
	process *os.Process
	tracked trackedSupervisor
}

var startTrackedSupervisor = func(cmd *exec.Cmd) (trackedSupervisor, error) {
	return procexec.StartTracked(cmd)
}

func startSupervisor(cmd *exec.Cmd) (*supervisorHandle, error) {
	tracked, err := startTrackedSupervisor(cmd)
	if err != nil {
		return nil, err
	}
	return &supervisorHandle{process: cmd.Process, tracked: tracked}, nil
}

func finishSupervisorWait(supervisor *supervisorHandle, waitErr error) error {
	return errors.Join(waitErr, supervisor.tracked.Close())
}

func terminateSupervisor(ctx context.Context, supervisor *supervisorHandle, waitCh <-chan error, _ time.Duration, killWait time.Duration) (resultErr error) {
	defer func() {
		resultErr = errors.Join(resultErr, supervisor.tracked.Close())
	}()
	if err := supervisor.tracked.TerminateTree(); err != nil {
		return fmt.Errorf("omorpc: terminate daemon process tree: %w", err)
	}
	deadline := time.NewTimer(killWait)
	defer deadline.Stop()
	select {
	case <-waitCh:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	case <-deadline.C:
		return errors.New("omorpc: daemon process tree did not exit after termination")
	}
}
