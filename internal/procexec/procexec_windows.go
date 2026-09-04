//go:build windows

package procexec

import (
	"errors"
	"fmt"
	"os/exec"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// SetupCommand applies platform process-domain settings to cmd before Start.
// Windows has no POSIX process-group equivalent; no spawn-time attribute is
// configured in this phase.
func SetupCommand(cmd *exec.Cmd) {}

// processTerminated reports whether the process behind handle has terminated
// by polling the kernel signaled state of the process object with a
// zero-timeout WaitForSingleObject. Per the Microsoft Win32 documentation, a
// process object is nonsignaled while its process runs and becomes signaled
// when the process terminates: WAIT_OBJECT_0 reports the signaled state
// (terminated) and WAIT_TIMEOUT reports that the timeout elapsed on the
// nonsignaled state (still running). The signaled state is authoritative
// where GetExitCodeProcess is not: a terminated process may legitimately exit
// with the STILL_ACTIVE pseudo code (259), which GetExitCodeProcess would
// keep reporting as "alive", while the signaled state is unambiguous.
func processTerminated(handle windows.Handle) (bool, error) {
	event, err := windows.WaitForSingleObject(handle, 0)
	if err != nil {
		return false, fmt.Errorf("procexec: wait on process object: %w", err)
	}
	switch event {
	case windows.WAIT_OBJECT_0:
		return true, nil
	case uint32(windows.WAIT_TIMEOUT):
		return false, nil
	default:
		return false, fmt.Errorf("procexec: unexpected WaitForSingleObject event 0x%x", event)
	}
}

// TrackedProcess is a handle to a child started under Job Object tracking.
// The job is the kernel-owned domain: membership is inherited by every
// descendant the child spawns, and KILL_ON_JOB_CLOSE ties the lifetime of the
// whole tree to this process's handle table. The mutex guards the job handle
// across TerminateTree and Close, which teardown paths may call concurrently.
type TrackedProcess struct {
	pid int
	mu  sync.Mutex
	job windows.Handle // zero once Close has released it
}

const (
	startFailureWaitDeadline = 5 * time.Second
	startFailureWaitSlice    = 50 * time.Millisecond
)

// assignProcessToJobObject is a test seam for forcing the post-Start failure
// path without changing the exported process-tracking API.
var assignProcessToJobObject = windows.AssignProcessToJobObject

// waitForProcessExit waits in bounded slices because TerminateProcess starts
// termination asynchronously. A process handle becomes signaled when
// termination completes, as documented for WaitForSingleObject.
func waitForProcessExit(handle windows.Handle) error {
	deadline := time.Now().Add(startFailureWaitDeadline)
	for {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return fmt.Errorf("process did not terminate within %s", startFailureWaitDeadline)
		}
		wait := min(remaining, startFailureWaitSlice)
		event, err := windows.WaitForSingleObject(handle, uint32(wait/time.Millisecond))
		if err != nil {
			return fmt.Errorf("wait for failed child termination: %w", err)
		}
		switch event {
		case windows.WAIT_OBJECT_0:
			return nil
		case uint32(windows.WAIT_TIMEOUT):
			continue
		default:
			return fmt.Errorf("unexpected WaitForSingleObject event 0x%x", event)
		}
	}
}

// reapStartFailure terminates an unassigned leader and waits for its process
// object to become signaled. A TerminateProcess error is teardown success only
// when the subsequent wait proves that the process had already terminated.
func reapStartFailure(cmd *exec.Cmd, handle windows.Handle) error {
	terminateErr := windows.TerminateProcess(handle, 1)
	if err := waitForProcessExit(handle); err != nil {
		if terminateErr != nil {
			return errors.Join(
				fmt.Errorf("terminate failed child: %w", terminateErr),
				err,
			)
		}
		return err
	}

	// cmd.Wait releases the os.Process handle and drains any os/exec I/O
	// goroutines. An ExitError is the expected status after TerminateProcess.
	if err := cmd.Wait(); err != nil {
		var exitErr *exec.ExitError
		if !errors.As(err, &exitErr) {
			return fmt.Errorf("reap failed child: %w", err)
		}
	}
	return nil
}

// StartTracked starts cmd and assigns the child to a fresh Job Object with
// JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, so the kernel terminates the whole tree
// when the last job handle closes — including when this process dies without
// ever reaching TerminateTree or Close. The caller composes SetupCommand(cmd)
// first to keep spawn-time settings on one side of the seam.
//
// Win32 requires CreateProcess to precede AssignProcessToJobObject, so a
// minimal scheduling window between process creation and assignment is
// inherent because Go's exec cannot create the child suspended. Once assigned,
// kill-on-close guarantees kernel teardown of the child and its descendants.
func StartTracked(cmd *exec.Cmd) (*TrackedProcess, error) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return nil, fmt.Errorf("procexec: create job object: %w", err)
	}
	// JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE makes the final CloseHandle of the
	// job terminate every process still in it. Configure that behavior before
	// creating the child so no successfully returned job lacks the limit.
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{
		BasicLimitInformation: windows.JOBOBJECT_BASIC_LIMIT_INFORMATION{
			LimitFlags: windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
		},
	}
	if _, err := windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); err != nil {
		closeErr := windows.CloseHandle(job)
		return nil, errors.Join(
			fmt.Errorf("procexec: set job limits: %w", err),
			wrapHandleCloseError(closeErr),
		)
	}
	if err := cmd.Start(); err != nil {
		closeErr := windows.CloseHandle(job)
		return nil, errors.Join(
			fmt.Errorf("procexec: start child: %w", err),
			wrapHandleCloseError(closeErr),
		)
	}

	pid := cmd.Process.Pid
	var assignErr, reapErr error
	// os.Process retains the CreateProcess handle until Wait or Release. Using
	// that handle avoids reopening by pid and keeps an already-exited leader
	// addressable for deterministic assignment failure and reaping.
	withHandleErr := cmd.Process.WithHandle(func(rawHandle uintptr) {
		handle := windows.Handle(rawHandle)
		assignErr = assignProcessToJobObject(job, handle)
		if assignErr != nil {
			reapErr = reapStartFailure(cmd, handle)
		}
	})
	if withHandleErr != nil {
		assignErr = fmt.Errorf("access child %d handle for job assignment: %w", pid, withHandleErr)
	}
	if assignErr != nil {
		closeErr := windows.CloseHandle(job)
		return nil, errors.Join(
			fmt.Errorf("procexec: assign child %d to job: %w", pid, assignErr),
			reapErr,
			wrapHandleCloseError(closeErr),
		)
	}
	return &TrackedProcess{pid: pid, job: job}, nil
}

func wrapHandleCloseError(err error) error {
	if err == nil {
		return nil
	}
	return fmt.Errorf("procexec: close job after failure: %w", err)
}

// Pid exposes the leader pid of the tracked domain.
func (t *TrackedProcess) Pid() int { return t.pid }

// TerminateTree tears down the tracked child and its descendants with
// TerminateJobObject. Job membership is inherited at CreateProcess time, so
// every descendant the tree spawned was born into the job and the single
// terminate call reaches the whole domain. The job object itself stays valid
// and Close still releases it afterwards; on an already-released handle
// (Close ran first) the tree is already dead, which is teardown success.
func (t *TrackedProcess) TerminateTree() error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.job == 0 {
		return nil
	}
	if err := windows.TerminateJobObject(t.job, 1); err != nil {
		return fmt.Errorf("procexec: terminate job tree of child %d: %w", t.pid, err)
	}
	return nil
}

// Close releases the job handle. Under JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE the
// final CloseHandle is the kernel's tree reaper: every process still in the
// job terminates, so a supervisor that loses interest cannot orphan the tree.
// Calls after the first release find no handle and return nil.
func (t *TrackedProcess) Close() error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.job == 0 {
		return nil
	}
	job := t.job
	t.job = 0
	if err := windows.CloseHandle(job); err != nil {
		return fmt.Errorf("procexec: close job of child %d: %w", t.pid, err)
	}
	return nil
}

// SignalGroup best-effort terminates the process tree rooted at pid using the
// documented Windows process APIs. sig is ignored: Windows has no POSIX signal
// delivery, so teardown is always the TerminateProcess force path. A pid with
// no process behind it returns nil, matching the Unix ESRCH tolerance, and so
// does a process that has already terminated: its handle is signaled and
// TerminateProcess against it typically fails with ERROR_ACCESS_DENIED, so
// the signaled-state recheck resolves that race to done instead of a teardown
// error.
func SignalGroup(pid int, sig syscall.Signal) error {
	handle, err := windows.OpenProcess(
		windows.PROCESS_TERMINATE|windows.SYNCHRONIZE|windows.PROCESS_QUERY_LIMITED_INFORMATION,
		false, uint32(pid))
	if err != nil {
		if errors.Is(err, windows.ERROR_NOT_FOUND) || errors.Is(err, windows.ERROR_INVALID_PARAMETER) {
			return nil
		}
		return fmt.Errorf("procexec: open process %d: %w", pid, err)
	}
	defer windows.CloseHandle(handle)

	terminated, err := processTerminated(handle)
	if err != nil {
		return fmt.Errorf("procexec: liveness check of process %d: %w", pid, err)
	}
	if terminated {
		return nil
	}
	if err := windows.TerminateProcess(handle, 1); err != nil {
		// The process can terminate between the wait above and the terminate
		// call; TerminateProcess on an already-terminated process then fails
		// with ERROR_ACCESS_DENIED. The signaled state of the handle is the
		// authoritative answer: WAIT_OBJECT_0 means the process is gone and
		// teardown is complete.
		if still, waitErr := processTerminated(handle); waitErr == nil && still {
			return nil
		}
		return fmt.Errorf("procexec: terminate process %d: %w", pid, err)
	}
	return nil
}

// GroupAlive reports whether the group led by pid has a live process.
// OpenProcess requests SYNCHRONIZE so the kernel signaled state of the
// process object can be polled with a zero-timeout WaitForSingleObject:
// WAIT_TIMEOUT (nonsignaled) means running, WAIT_OBJECT_0 (signaled) means
// terminated. Liveness therefore never consults GetExitCodeProcess, whose
// STILL_ACTIVE (259) pseudo exit code persists for a process that genuinely
// exited with that code and would misreport it as alive.
func GroupAlive(pid int) bool {
	handle, err := windows.OpenProcess(
		windows.SYNCHRONIZE|windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return false
	}
	defer windows.CloseHandle(handle)
	terminated, err := processTerminated(handle)
	return err == nil && !terminated
}
