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

func Test_StartTracked_TerminateTree_kills_tracked_group_when_child_leads_group(t *testing.T) {
	// Given: a /bin/sleep child that leads its own fresh process group,
	// started under tracking.
	cmd := exec.Command("/bin/sleep", "30")
	SetupCommand(cmd)
	tracked, err := StartTracked(cmd)
	if err != nil {
		t.Fatalf("start tracked child: %v", err)
	}
	t.Cleanup(func() {
		_ = tracked.TerminateTree()
		_ = tracked.Close()
	})

	// Then: the tracked pid is the leader pid.
	if tracked.Pid() != cmd.Process.Pid {
		t.Fatalf("tracked pid %d does not match leader pid %d", tracked.Pid(), cmd.Process.Pid)
	}

	// When: the tracked tree is terminated.
	if err := tracked.TerminateTree(); err != nil {
		t.Fatalf("terminate tree of %d: %v", tracked.Pid(), err)
	}

	// Then: the leader dies by SIGKILL and the group is gone within the
	// bounded deadline.
	reaped := make(chan error, 1)
	go func() { reaped <- cmd.Wait() }()
	deadline := time.NewTimer(signalGroupTestDeadline)
	defer deadline.Stop()
	retry := time.NewTicker(10 * time.Millisecond)
	defer retry.Stop()
	leaderReaped := false
	for {
		select {
		case err := <-reaped:
			var exitErr *exec.ExitError
			if !errors.As(err, &exitErr) {
				t.Fatalf("tracked leader exited without a signal: %v", err)
			}
			status, ok := exitErr.ProcessState.Sys().(syscall.WaitStatus)
			if !ok || !status.Signaled() || status.Signal() != syscall.SIGKILL {
				t.Fatalf("tracked leader was not terminated by SIGKILL: %v", err)
			}
			leaderReaped = true
			reaped = nil // drained; stop selecting on this channel
		case <-retry.C:
			if leaderReaped && !GroupAlive(tracked.Pid()) {
				return
			}
		case <-deadline.C:
			t.Fatalf("tracked tree of %d not reaped and dead within %s (leaderReaped=%v, alive=%v)",
				tracked.Pid(), signalGroupTestDeadline, leaderReaped, GroupAlive(tracked.Pid()))
		}
	}
}

func Test_TrackedProcess_WaitTreeGone_reports_nil_when_group_drains(t *testing.T) {
	// Given: a tracked sleeping child that leads its own fresh process group.
	cmd := exec.Command("/bin/sleep", "30")
	SetupCommand(cmd)
	tracked, err := StartTracked(cmd)
	if err != nil {
		t.Fatalf("start tracked child: %v", err)
	}
	t.Cleanup(func() {
		_ = tracked.TerminateTree()
		_ = tracked.Close()
	})
	if !GroupAlive(tracked.Pid()) {
		t.Fatalf("group led by %d reported dead before TerminateTree", tracked.Pid())
	}

	// The leader is reaped concurrently: a terminated but unreaped child
	// still exists to the kernel, so only the reap lets the group drain.
	reaped := make(chan error, 1)
	go func() { reaped <- cmd.Wait() }()

	// When: the tree is terminated and the drain awaited within the bounded
	// deadline.
	if err := tracked.TerminateTree(); err != nil {
		t.Fatalf("terminate tree of %d: %v", tracked.Pid(), err)
	}
	if err := tracked.WaitTreeGone(signalGroupTestDeadline); err != nil {
		t.Fatalf("wait for tree of %d to drain: %v", tracked.Pid(), err)
	}

	// Then: the group reports dead and the reap completed.
	if GroupAlive(tracked.Pid()) {
		t.Fatalf("group led by %d still reports alive after WaitTreeGone returned nil", tracked.Pid())
	}
	select {
	case <-reaped:
	default:
		t.Fatal("leader was not reaped by the time the tree drained")
	}
}

func Test_TrackedProcess_Close_reports_no_error_when_called_repeatedly(t *testing.T) {
	// Given: a tracked child.
	cmd := exec.Command("/bin/sleep", "30")
	SetupCommand(cmd)
	tracked, err := StartTracked(cmd)
	if err != nil {
		t.Fatalf("start tracked child: %v", err)
	}
	t.Cleanup(func() {
		_ = tracked.TerminateTree()
		_ = tracked.Close()
	})

	// When: Close runs twice.
	first := tracked.Close()
	second := tracked.Close()

	// Then: both closes succeed; the release is safe to repeat.
	if first != nil {
		t.Fatalf("first close: %v", first)
	}
	if second != nil {
		t.Fatalf("second close: %v", second)
	}
}

func Test_StartTracked_reports_error_when_command_cannot_start(t *testing.T) {
	// Given: a command whose binary does not exist.
	cmd := exec.Command("/nonexistent-procexec-binary-9f3a2c")

	// When: the command is started under tracking.
	tracked, err := StartTracked(cmd)

	// Then: the failure surfaces as an error and no handle is returned.
	if err == nil {
		t.Fatal("StartTracked succeeded for a nonexistent binary")
	}
	if tracked != nil {
		t.Fatalf("StartTracked returned a handle alongside an error: %v", tracked)
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
