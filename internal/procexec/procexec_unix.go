//go:build darwin || linux

package procexec

import (
	"errors"
	"fmt"
	"os/exec"
	"syscall"
	"time"
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

// TrackedProcess is a handle to a child started under platform process-domain
// tracking. On Unix the tracking domain is the process group that Setpgid
// created at spawn time, so the handle carries only the leader pid that
// addresses it.
type TrackedProcess struct {
	pid int
}

// StartTracked starts cmd and returns a handle whose TerminateTree tears down
// the child's whole domain. Unix tracking is the process group, so the caller
// composes SetupCommand(cmd) before StartTracked; without it no group led by
// the child's pid exists and termination resolves to ESRCH, the same no-op as
// every already-dead group.
func StartTracked(cmd *exec.Cmd) (*TrackedProcess, error) {
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("procexec: start child: %w", err)
	}
	return &TrackedProcess{pid: cmd.Process.Pid}, nil
}

// Pid exposes the leader pid of the tracked domain.
func (t *TrackedProcess) Pid() int { return t.pid }

// TerminateTree tears down the tracked child and its descendants by
// escalating SIGKILL to the group led by the child's pid. SIGKILL cannot be
// caught, so every live group member dies in kernel space; ESRCH from an
// already-dead group resolves to teardown success per SignalGroup's contract.
func (t *TrackedProcess) TerminateTree() error {
	return SignalGroup(t.pid, syscall.SIGKILL)
}

// waitTreeGonePollSlice is the retry interval of WaitTreeGone's bounded poll.
const waitTreeGonePollSlice = 50 * time.Millisecond

// WaitTreeGone blocks until no process remains in the tracked domain — the
// process group led by the child's pid — or until deadline elapses,
// returning a timeout error if the tree has not drained by then. GroupAlive
// polls the kernel's existence check for the whole group, so the wait is
// safe after the leader already exited and callable any time between
// StartTracked (or TerminateTree) and Close. A group member that has
// terminated but not been reaped still exists to the kernel, so a caller
// responsible for reaping the leader must do so (concurrently) for the
// domain to drain.
func (t *TrackedProcess) WaitTreeGone(deadline time.Duration) error {
	timer := time.NewTimer(deadline)
	defer timer.Stop()
	retry := time.NewTicker(waitTreeGonePollSlice)
	defer retry.Stop()
	for {
		if !GroupAlive(t.pid) {
			return nil
		}
		select {
		case <-retry.C:
		case <-timer.C:
			return fmt.Errorf("procexec: tracked tree of child %d still alive after %s", t.pid, deadline)
		}
	}
}

// Close releases tracking resources. Unix tracking lives entirely in kernel
// process state (the group), not in a handle this process owns, so Close has
// nothing to release; it is kept for the platform-neutral contract and is
// safe any number of times.
func (t *TrackedProcess) Close() error { return nil }

// GroupAlive reports whether the group led by pid has a live process.
// kill(-pid, 0) performs the kernel's existence and permission check without
// delivering a signal; EPERM means the group exists but is owned by another
// user, which still counts as alive.
func GroupAlive(pid int) bool {
	err := syscall.Kill(-pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}
