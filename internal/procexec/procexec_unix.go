//go:build darwin || linux

package procexec

import (
	"errors"
	"os/exec"
	"syscall"
)

// SetupCommand applies platform process-domain settings to cmd before Start.
// Setpgid true makes the child lead a new process group: the kernel places the
// child in a group whose pgid equals its own pid, so the whole subtree is
// addressable as kill(-pid, ...).
func SetupCommand(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

// SignalGroup delivers sig to the process group led by pid via the negative-pid
// form of kill(2). ESRCH is tolerated because an already-exited group is the
// success case for teardown; every other errno is surfaced to the caller.
func SignalGroup(pid int, sig syscall.Signal) error {
	err := syscall.Kill(-pid, sig)
	if err == nil || errors.Is(err, syscall.ESRCH) {
		return nil
	}
	return err
}

// GroupAlive reports whether the group led by pid has a live process.
// kill(-pid, 0) performs the kernel's existence and permission check without
// delivering a signal; EPERM means the group exists but is owned by another
// user, which still counts as alive.
func GroupAlive(pid int) bool {
	err := syscall.Kill(-pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}
