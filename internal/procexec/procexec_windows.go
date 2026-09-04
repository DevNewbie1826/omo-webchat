//go:build windows

package procexec

import (
	"errors"
	"fmt"
	"os/exec"
	"syscall"

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
