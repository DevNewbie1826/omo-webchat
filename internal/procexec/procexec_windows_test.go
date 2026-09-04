//go:build windows

package procexec

import (
	"bytes"
	"errors"
	"io"
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

	// When: the whole tree is terminated through the job and awaited until
	// the tracked domain drains.
	if err := tracked.TerminateTree(); err != nil {
		t.Fatalf("terminate tree of %d: %v", tracked.Pid(), err)
	}
	if err := tracked.WaitTreeGone(trackedTreeTestDeadline); err != nil {
		t.Fatalf("wait for tree of %d to drain: %v", tracked.Pid(), err)
	}

	// Then: both the leader and the grandchild are gone. WaitTreeGone's nil
	// return is the drain signal, and the GroupAlive checks below are the
	// after-state proof that the job reached the descendant the leader
	// spawned.
	for GroupAlive(tracked.Pid()) || GroupAlive(grandchild) {
		select {
		case <-retry.C:
		case <-deadline.C:
			t.Fatalf("tree of %d not fully dead within %s (leader alive=%v, grandchild %d alive=%v)",
				tracked.Pid(), trackedTreeTestDeadline, GroupAlive(tracked.Pid()), grandchild, GroupAlive(grandchild))
		}
	}

	// cmd.Wait must return once the leader's process object is signaled.
	// TerminateJobObject promises termination, not a nonzero exit status, so
	// the reaped status itself is not asserted.
	_ = cmd.Wait()
}

func Test_TrackedProcess_WaitTreeGone_blocks_while_grandchild_outlives_leader(t *testing.T) {
	// Given: a leader that waits for a stdin gate, then spawns a Start-Sleep
	// grandchild and exits immediately after recording the pid. The gate is
	// released only after StartTracked has returned, so the grandchild's
	// CreateProcess happens strictly after the leader's job assignment and
	// inherits job membership deterministically — without the gate the
	// documented Win32 create-to-assign window can leave the grandchild
	// outside the job and the test nondeterministic.
	pidFile := filepath.Join(t.TempDir(), "outliving.pid")
	gateReader, gateWriter := io.Pipe()
	cmd := exec.Command("powershell", "-NoProfile", "-Command",
		"$null = [Console]::In.ReadLine(); "+
			"Start-Process -WindowStyle Hidden -PassThru powershell -ArgumentList '-NoProfile','-Command','Start-Sleep','-Seconds','60' |"+
			" ForEach-Object { $_.Id } | Set-Content -LiteralPath '"+pidFile+"'")
	cmd.Stdin = gateReader
	tracked, err := StartTracked(cmd)
	if err != nil {
		t.Fatalf("start tracked powershell: %v", err)
		return
	}
	// Assignment is complete once StartTracked returns; release the gate so
	// the grandchild is created inside the job.
	if _, err := gateWriter.Write([]byte("\n")); err != nil {
		t.Fatalf("release stdin gate: %v", err)
	}
	if err := gateWriter.Close(); err != nil {
		t.Fatalf("close stdin gate: %v", err)
	}
	t.Cleanup(func() {
		_ = tracked.TerminateTree()
		_ = tracked.Close()
	})

	deadline := time.NewTimer(trackedTreeTestDeadline)
	defer deadline.Stop()
	retry := time.NewTicker(10 * time.Millisecond)
	defer retry.Stop()
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
	// Precondition: the leader has exited and been reaped, so the tracked
	// domain is held alive by the outliving grandchild alone.
	reaped := make(chan error, 1)
	go func() { reaped <- cmd.Wait() }()
	for GroupAlive(tracked.Pid()) {
		select {
		case <-retry.C:
		case <-reaped:
		case <-deadline.C:
			t.Fatalf("leader %d did not exit within %s", tracked.Pid(), trackedTreeTestDeadline)
		}
	}
	if !GroupAlive(grandchild) {
		t.Fatalf("grandchild %d reported dead before TerminateTree", grandchild)
	}

	// When (phase 1): a short-deadline wait, called synchronously while the
	// outliving grandchild is provably alive, must time out. A drain
	// primitive that returned early would report nil here and fail this
	// assertion — no goroutine handshake is needed, the blocked state is
	// proven by the timeout itself.
	shortDeadline := 2 * time.Second
	if err := tracked.WaitTreeGone(shortDeadline); !errors.Is(err, ErrTreeDrainTimeout) {
		t.Fatalf("WaitTreeGone(%s) = %v, want ErrTreeDrainTimeout while grandchild %d is alive", shortDeadline, err, grandchild)
	}
	if !GroupAlive(grandchild) {
		t.Fatalf("grandchild %d reported dead before TerminateTree", grandchild)
	}

	// When (phase 2): terminate through the job, then the full wait must
	// observe every member's process object signaled.
	if err := tracked.TerminateTree(); err != nil {
		t.Fatalf("terminate tree of %d: %v", tracked.Pid(), err)
	}
	if err := tracked.WaitTreeGone(trackedTreeTestDeadline); err != nil {
		t.Fatalf("WaitTreeGone after TerminateTree: %v", err)
	}
	// Job accounting can report an empty domain shortly before the member's
	// process object becomes signaled (termination is asynchronous), so the
	// after-state is a bounded poll, not an instantaneous check.
	for GroupAlive(grandchild) {
		select {
		case <-retry.C:
		case <-deadline.C:
			t.Fatalf("grandchild %d still alive %s after WaitTreeGone returned nil", grandchild, trackedTreeTestDeadline)
		}
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

func Test_TrackedProcess_WaitTreeGone_retains_member_through_exit_window(t *testing.T) {
	// A member that exits on its own can leave the job's member list while
	// its process object is not yet signaled. The drain wait must retain
	// that genuine handle until it signals — returning nil only after the
	// grandchild is truly gone — never drop it on list absence. The
	// grandchild self-exits after a short sleep; nothing terminates the
	// tree, so nil can only come from observing the natural exit.
	pidFile := filepath.Join(t.TempDir(), "exiting.pid")
	gateReader, gateWriter := io.Pipe()
	cmd := exec.Command("powershell", "-NoProfile", "-Command",
		"$null = [Console]::In.ReadLine(); "+
			"Start-Process -WindowStyle Hidden -PassThru powershell -ArgumentList '-NoProfile','-Command','Start-Sleep','-Seconds','3' |"+
			" ForEach-Object { $_.Id } | Set-Content -LiteralPath '"+pidFile+"'")
	cmd.Stdin = gateReader
	tracked, err := StartTracked(cmd)
	if err != nil {
		t.Fatalf("start tracked powershell: %v", err)
		return
	}
	if _, err := gateWriter.Write([]byte("\n")); err != nil {
		t.Fatalf("release stdin gate: %v", err)
	}
	if err := gateWriter.Close(); err != nil {
		t.Fatalf("close stdin gate: %v", err)
	}
	t.Cleanup(func() {
		_ = tracked.TerminateTree()
		_ = tracked.Close()
	})

	deadline := time.NewTimer(trackedTreeTestDeadline)
	defer deadline.Stop()
	retry := time.NewTicker(10 * time.Millisecond)
	defer retry.Stop()
	grandchild := 0
	for grandchild == 0 {
		select {
		case <-retry.C:
			raw, readErr := os.ReadFile(pidFile)
			if readErr != nil {
				continue
			}
			pid, parseErr := strconv.Atoi(strings.TrimSpace(string(raw)))
			if parseErr != nil || pid <= 0 {
				continue
			}
			grandchild = pid
		case <-deadline.C:
			t.Fatalf("powershell leader %d spawned no grandchild within %s", tracked.Pid(), trackedTreeTestDeadline)
		}
	}
	for GroupAlive(tracked.Pid()) {
		select {
		case <-retry.C:
		case <-deadline.C:
			t.Fatalf("leader %d did not exit within %s", tracked.Pid(), trackedTreeTestDeadline)
		}
	}
	if !GroupAlive(grandchild) {
		t.Fatalf("grandchild %d reported dead before its natural exit", grandchild)
	}

	// Drain with no termination: nil must follow only after the grandchild's
	// own exit is fully observed.
	if err := tracked.WaitTreeGone(trackedTreeTestDeadline); err != nil {
		t.Fatalf("WaitTreeGone through natural exit: %v", err)
	}
	// The retention proof: nil arrived while the grandchild still lived
	// only if the wait dropped its handle on list absence.
	for GroupAlive(grandchild) {
		select {
		case <-retry.C:
		case <-deadline.C:
			t.Fatalf("grandchild %d still alive after WaitTreeGone returned nil", grandchild)
		}
	}
}

func Test_TrackedProcess_WaitTreeGone_after_Close_reports_job_closed(t *testing.T) {
	// Given: a tracked child that is released via Close. The job handle is
	// gone, so a later drain wait must report the honest closed state instead
	// of fabricating a drained result; the kernel meanwhile reaps the child
	// through KILL_ON_JOB_CLOSE.
	cmd := exec.Command("powershell", "-NoProfile", "-Command", "Start-Sleep -Seconds 60")
	tracked, err := StartTracked(cmd)
	if err != nil {
		t.Fatalf("start tracked powershell: %v", err)
		return
	}
	// Precondition: the child is provably alive before the close, so the
	// kernel-reap assertion below cannot pass vacuously on an early exit.
	aliveDeadline := time.NewTimer(trackedTreeTestDeadline)
	defer aliveDeadline.Stop()
	aliveRetry := time.NewTicker(10 * time.Millisecond)
	defer aliveRetry.Stop()
	for !GroupAlive(tracked.Pid()) {
		select {
		case <-aliveRetry.C:
		case <-aliveDeadline.C:
			t.Fatalf("child %d never reported alive before close", tracked.Pid())
		}
	}
	if err := tracked.Close(); err != nil {
		t.Fatalf("close tracked process: %v", err)
	}
	if err := tracked.WaitTreeGone(time.Second); !errors.Is(err, ErrJobClosed) {
		t.Fatalf("WaitTreeGone after Close = %v, want ErrJobClosed", err)
	}
	deadline := time.NewTimer(trackedTreeTestDeadline)
	defer deadline.Stop()
	retry := time.NewTicker(10 * time.Millisecond)
	defer retry.Stop()
	for GroupAlive(tracked.Pid()) {
		select {
		case <-retry.C:
		case <-deadline.C:
			t.Fatalf("child %d survived the job close within %s", tracked.Pid(), trackedTreeTestDeadline)
		}
	}
	_ = cmd.Wait()
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
	// cmd.Wait must return once the child's process object is signaled.
	// JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE promises termination, not a nonzero
	// exit status, so the reaped status itself is not asserted.
	_ = cmd.Wait()
}
