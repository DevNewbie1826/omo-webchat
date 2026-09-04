//go:build darwin || linux

package procexec

import (
	"errors"
	"os/exec"
	"syscall"
	"testing"
	"time"
)

// The bounded deadline mirrors the stop OwnedProcess kill loop in
// internal/omorpc/ensure.go: a fixed timer plus a short retry ticker, never an
// unconditional sleep.
const signalGroupTestDeadline = 5 * time.Second

func Test_SignalGroup_terminates_group_leader_when_sigterm_delivered(t *testing.T) {
	// Given: a /bin/sleep child that leads its own fresh process group.
	cmd := exec.Command("/bin/sleep", "30")
	SetupCommand(cmd)
	if err := cmd.Start(); err != nil {
		t.Fatalf("start /bin/sleep: %v", err)
	}
	pid := cmd.Process.Pid
	t.Cleanup(func() { _ = SignalGroup(pid, syscall.SIGKILL) })
	reaped := make(chan error, 1)
	go func() { reaped <- cmd.Wait() }()

	// Then: the group led by the child reports alive immediately after Start.
	if !GroupAlive(pid) {
		t.Fatalf("group led by %d reported dead immediately after Start", pid)
	}

	// When: SIGTERM is delivered to the whole group.
	if err := SignalGroup(pid, syscall.SIGTERM); err != nil {
		t.Fatalf("signal group led by %d: %v", pid, err)
	}

	// Then: the leader exits from SIGTERM and the group dies within the
	// bounded deadline.
	deadline := time.NewTimer(signalGroupTestDeadline)
	defer deadline.Stop()
	retry := time.NewTicker(10 * time.Millisecond)
	defer retry.Stop()
	leaderSignaled := false
	for {
		select {
		case err := <-reaped:
			var exitErr *exec.ExitError
			if !errors.As(err, &exitErr) {
				t.Fatalf("group leader exited without a signal: %v", err)
			}
			status, ok := exitErr.ProcessState.Sys().(syscall.WaitStatus)
			if !ok || !status.Signaled() || status.Signal() != syscall.SIGTERM {
				t.Fatalf("group leader was not terminated by SIGTERM: %v", err)
			}
			leaderSignaled = true
			reaped = nil // drained; stop selecting on this channel
		case <-retry.C:
			if leaderSignaled && !GroupAlive(pid) {
				return
			}
		case <-deadline.C:
			t.Fatalf("group led by %d not reaped and dead within %s (leaderSignaled=%v, alive=%v)",
				pid, signalGroupTestDeadline, leaderSignaled, GroupAlive(pid))
		}
	}
}

func Test_GroupAlive_reports_dead_after_group_exits(t *testing.T) {
	// Given: a /bin/sleep child that runs to completion in its own group.
	cmd := exec.Command("/bin/sleep", "0")
	SetupCommand(cmd)
	if err := cmd.Start(); err != nil {
		t.Fatalf("start /bin/sleep: %v", err)
	}
	pid := cmd.Process.Pid
	reaped := make(chan error, 1)
	go func() { reaped <- cmd.Wait() }()

	// When: the child exits and is reaped.
	deadline := time.NewTimer(signalGroupTestDeadline)
	defer deadline.Stop()
	for reaped != nil {
		select {
		case <-reaped:
			reaped = nil
		case <-deadline.C:
			t.Fatalf("child %d did not exit within %s", pid, signalGroupTestDeadline)
		}
	}

	// Then: the exited group reports dead.
	if GroupAlive(pid) {
		t.Fatalf("group led by exited child %d still reports alive", pid)
	}
}
