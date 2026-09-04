//go:build windows

package procexec

import (
	"bytes"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

// The bounded deadline mirrors the stop OwnedProcess kill loop in
// internal/omorpc/ensure.go: a fixed timer plus a short retry ticker, never an
// unconditional sleep. It is sized for a cold powershell start on a shared
// runner, not for the teardown itself, which TerminateJobObject completes in
// kernel time.
const trackedTreeTestDeadline = 30 * time.Second

func Test_TrackedProcess_TerminateTree_kills_leader_and_grandchild_when_job_terminated(t *testing.T) {
	// Given: a powershell leader tracked in a job, which itself spawns a
	// long-running Start-Sleep grandchild and records the grandchild pid in
	// a file. Both children stay reliably alive — a stubbed or instantly
	// exiting command would make the kill assertions vacuous — and the
	// leader sleeps after recording, so only the job teardown can end it.
	pidFile := filepath.Join(t.TempDir(), "grandchild.pid")
	cmd := exec.Command("powershell", "-NoProfile", "-Command",
		"Start-Process -WindowStyle Hidden -PassThru powershell -ArgumentList '-NoProfile','-Command','Start-Sleep','-Seconds','60' |"+
			" ForEach-Object { $_.Id } | Set-Content -LiteralPath '"+pidFile+"';"+
			" Start-Sleep -Seconds 60")
	tracked, err := StartTracked(cmd)
	if err != nil {
		t.Fatalf("start tracked powershell: %v", err)
	}
	t.Cleanup(func() {
		_ = tracked.TerminateTree()
		_ = tracked.Close()
	})

	deadline := time.NewTimer(trackedTreeTestDeadline)
	defer deadline.Stop()
	retry := time.NewTicker(10 * time.Millisecond)
	defer retry.Stop()
	// Precondition: the leader reports alive before any teardown, so the
	// assertions below prove job kills rather than self-exits.
	for !GroupAlive(tracked.Pid()) {
		select {
		case <-retry.C:
		case <-deadline.C:
			t.Fatalf("precondition failed: leader %d never reported alive within %s after StartTracked", tracked.Pid(), trackedTreeTestDeadline)
		}
	}

	// The grandchild pid comes from the spawner itself (Start-Process
	// -PassThru), so tree membership is attributed without process-table or
	// name scans; GroupAlive then confirms it from the kernel signaled state.
	grandchild := 0
	for grandchild == 0 {
		select {
		case <-retry.C:
			raw, err := os.ReadFile(pidFile)
			if err != nil {
				continue
			}
			pid, err := strconv.Atoi(strings.TrimSpace(string(raw)))
			if err != nil || pid <= 0 {
				continue
			}
			grandchild = pid
		case <-deadline.C:
			t.Fatalf("powershell leader %d spawned no grandchild within %s", tracked.Pid(), trackedTreeTestDeadline)
		}
	}
	if !GroupAlive(grandchild) {
		t.Fatalf("grandchild %d reported dead before TerminateTree", grandchild)
	}

	// When: the whole tree is terminated through the job.
	if err := tracked.TerminateTree(); err != nil {
		t.Fatalf("terminate tree of %d: %v", tracked.Pid(), err)
	}

	// Then: both the leader and the grandchild are gone within the bounded
	// deadline, proving the job reached the descendant the leader spawned.
	for GroupAlive(tracked.Pid()) || GroupAlive(grandchild) {
		select {
		case <-retry.C:
		case <-deadline.C:
			t.Fatalf("tree of %d not fully dead within %s (leader alive=%v, grandchild %d alive=%v)",
				tracked.Pid(), trackedTreeTestDeadline, GroupAlive(tracked.Pid()), grandchild, GroupAlive(grandchild))
		}
	}

	reaped := make(chan error, 1)
	go func() { reaped <- cmd.Wait() }()
	select {
	case err := <-reaped:
		if err == nil {
			t.Fatalf("job-terminated leader %d reaped with a clean exit", tracked.Pid())
		}
	case <-deadline.C:
		t.Fatalf("leader %d not reaped within %s", tracked.Pid(), trackedTreeTestDeadline)
	}
}

func Test_StartTracked_assignment_failure_terminates_and_reaps_child(t *testing.T) {
	// Given: assignment is forced to fail after a long-running child starts.
	assignmentFailure := errors.New("injected assignment failure")
	originalAssign := assignProcessToJobObject
	assignProcessToJobObject = func(windows.Handle, windows.Handle) error {
		return assignmentFailure
	}
	t.Cleanup(func() { assignProcessToJobObject = originalAssign })

	// A sleeping powershell is reliably alive when the injected failure
	// fires, so the synchronous reap exercises TerminateProcess on a live
	// process instead of racing a command that may exit on its own.
	cmd := exec.Command("powershell.exe", "-NoProfile", "-Command", "Start-Sleep -Seconds 60")
	// A non-file writer makes os/exec run its output copier. StartTracked must
	// call cmd.Wait before returning, which also waits for that goroutine.
	cmd.Stdout = &bytes.Buffer{}

	// When: StartTracked cannot assign the running child to its prepared job.
	tracked, err := StartTracked(cmd)

	// Then: the assignment error surfaces without a tracking handle, and the
	// leader has synchronously exited and been reaped before return.
	if !errors.Is(err, assignmentFailure) {
		t.Fatalf("StartTracked error = %v, want injected assignment failure", err)
	}
	if tracked != nil {
		t.Fatalf("StartTracked returned a handle after assignment failure: %v", tracked)
	}
	if cmd.Process == nil {
		t.Fatal("command did not start before assignment failure")
	}
	if cmd.ProcessState == nil {
		t.Fatal("failed child was not reaped before StartTracked returned")
	}
	if GroupAlive(cmd.Process.Pid) {
		t.Fatalf("child %d survived assignment failure", cmd.Process.Pid)
	}
}

func Test_TrackedProcess_Close_kernel_kills_child_when_job_handle_released(t *testing.T) {
	// Given: a tracked long-running child that nobody terminated. A sleeping
	// powershell stays reliably alive, so the kernel kill below is proved
	// against a live process rather than one that already exited.
	cmd := exec.Command("powershell.exe", "-NoProfile", "-Command", "Start-Sleep -Seconds 60")
	tracked, err := StartTracked(cmd)
	if err != nil {
		t.Fatalf("start tracked powershell: %v", err)
	}
	t.Cleanup(func() {
		_ = tracked.TerminateTree()
		_ = tracked.Close()
	})

	// Precondition: the child reports alive before the close, so the
	// assertions below prove job-close termination rather than self-exit.
	deadline := time.NewTimer(trackedTreeTestDeadline)
	defer deadline.Stop()
	retry := time.NewTicker(10 * time.Millisecond)
	defer retry.Stop()
	for !GroupAlive(tracked.Pid()) {
		select {
		case <-retry.C:
		case <-deadline.C:
			t.Fatalf("precondition failed: child %d never reported alive within %s after StartTracked", tracked.Pid(), trackedTreeTestDeadline)
		}
	}

	// When: the tracking handle is released, twice.
	if err := tracked.Close(); err != nil {
		t.Fatalf("close tracked process: %v", err)
	}
	if err := tracked.Close(); err != nil {
		t.Fatalf("second close tracked process: %v", err)
	}

	// Then: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE made the kernel terminate the
	// child on the final job-handle close, within the bounded deadline.
	for GroupAlive(tracked.Pid()) {
		select {
		case <-retry.C:
		case <-deadline.C:
			t.Fatalf("child %d survived the job close within %s", tracked.Pid(), trackedTreeTestDeadline)
		}
	}
	if err := cmd.Wait(); err == nil {
		t.Fatalf("job-closed child %d reaped with a clean exit", tracked.Pid())
	}
}
