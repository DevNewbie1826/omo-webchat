//go:build unix

package main

import (
	"errors"
	"os/exec"
	"syscall"
)

// configureSpawn puts the supervisor in its own process group so teardown
// can signal the whole tree via killpg(2) (kill(-pid)).
func configureSpawn(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

func killProcessTree(cmd *exec.Cmd) error {
	if cmd == nil || cmd.Process == nil {
		return nil
	}
	err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	if err != nil && !errors.Is(err, syscall.ESRCH) {
		return err
	}
	return nil
}
