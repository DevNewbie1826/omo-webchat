//go:build windows

package procexec

import (
	"errors"
	"fmt"
	"os/exec"
	"sync"
	"syscall"
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

// StartTracked starts cmd and assigns the child to a fresh Job Object with
// JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, so the kernel terminates the whole tree
// when the last job handle closes — including when this process dies without
// ever reaching TerminateTree or Close. The caller composes SetupCommand(cmd)
// first to keep spawn-time settings on one side of the seam.
//
// The assignment happens immediately after Start: descendants the child
// spawns inside the sub-millisecond window before AssignProcessToJobObject
// would be born outside the job, a race inherent to assigning an already
// running process rather than creating it suspended (Go's exec does not
// expose the main-thread handle needed to resume a suspended child).
func StartTracked(cmd *exec.Cmd) (*TrackedProcess, error) {
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("procexec: start child: %w", err)
	}
	pid := cmd.Process.Pid
	// The child is running but not yet tracked: terminate it so StartTracked
	// hands back a fully tracked child or none at all. Nothing is in the job
	// on any of these paths (assignment is the final step), so the job handle
	// is closed directly and the child via plain TerminateProcess.
	abort := func(err error) (*TrackedProcess, error) {
		_ = cmd.Process.Kill()
		return nil, err
	}
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return abort(fmt.Errorf("procexec: create job object: %w", err))
	}
	// JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE makes the final CloseHandle of the
	// job terminate every process still in it, so the OS — not this process —
	// reaps the tree even on crash. The extended limit structure is the basic
	// one plus an I/O counter payload; it carries the same LimitFlags field.
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{
		BasicLimitInformation: windows.JOBOBJECT_BASIC_LIMIT_INFORMATION{
			LimitFlags: windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
		},
	}
	if _, err := windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); err != nil {
		_ = windows.CloseHandle(job)
		return abort(fmt.Errorf("procexec: set job limits: %w", err))
	}
	// AssignProcessToJobObject requires PROCESS_SET_QUOTA and
	// PROCESS_TERMINATE access on the target per the Microsoft docs. A child
	// that already exited resolves to success like every already-dead domain:
	// the job stays empty and Close releases it harmlessly, matching the
	// SignalGroup tolerance for ESRCH.
	proc, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(pid))
	if err != nil {
		if errors.Is(err, windows.ERROR_NOT_FOUND) || errors.Is(err, windows.ERROR_INVALID_PARAMETER) {
			return &TrackedProcess{pid: pid, job: job}, nil
		}
		_ = windows.CloseHandle(job)
		return abort(fmt.Errorf("procexec: open child %d for job assignment: %w", pid, err))
	}
	defer windows.CloseHandle(proc)
	if err := windows.AssignProcessToJobObject(job, proc); err != nil {
		_ = windows.CloseHandle(job)
		return abort(fmt.Errorf("procexec: assign child %d to job: %w", pid, err))
	}
	return &TrackedProcess{pid: pid, job: job}, nil
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
