//go:build windows

package procexec

import (
	"errors"
	"fmt"
	"os/exec"
	"syscall"

	"golang.org/x/sys/windows"
)

// stillActive is the documented pseudo exit code GetExitCodeProcess reports
// (STILL_ACTIVE, 0x00000103 / STATUS_PENDING) while the process has not
// terminated. x/sys/windows does not export the constant, so it is pinned here
// from the Windows API definition.
const stillActive = 0x00000103

// SetupCommand applies platform process-domain settings to cmd before Start.
// Windows has no POSIX process-group equivalent; no spawn-time attribute is
// configured in this phase.
func SetupCommand(cmd *exec.Cmd) {}

// SignalGroup best-effort terminates the process tree rooted at pid using the
// documented Windows process APIs. sig is ignored: Windows has no POSIX signal
// delivery, so teardown is always the TerminateProcess force path. A pid with
// no process behind it returns nil, matching the Unix ESRCH tolerance.
func SignalGroup(pid int, sig syscall.Signal) error {
	handle, err := windows.OpenProcess(
		windows.PROCESS_TERMINATE|windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		if errors.Is(err, windows.ERROR_NOT_FOUND) || errors.Is(err, windows.ERROR_INVALID_PARAMETER) {
			return nil
		}
		return fmt.Errorf("procexec: open process %d: %w", pid, err)
	}
	defer windows.CloseHandle(handle)

	var code uint32
	if err := windows.GetExitCodeProcess(handle, &code); err != nil {
		return fmt.Errorf("procexec: query exit code of process %d: %w", pid, err)
	}
	if code != stillActive {
		return nil
	}
	if err := windows.TerminateProcess(handle, 1); err != nil {
		return fmt.Errorf("procexec: terminate process %d: %w", pid, err)
	}
	return nil
}

// GroupAlive reports whether the group led by pid has a live process.
// OpenProcess succeeds for any existing process object the caller can query;
// GetExitCodeProcess then distinguishes a running process (STILL_ACTIVE) from
// one that terminated but whose object is still addressable.
func GroupAlive(pid int) bool {
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return false
	}
	defer windows.CloseHandle(handle)
	var code uint32
	if err := windows.GetExitCodeProcess(handle, &code); err != nil {
		return false
	}
	return code == stillActive
}
