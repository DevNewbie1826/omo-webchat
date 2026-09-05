//go:build windows

package procexec

import "golang.org/x/sys/windows"

// ContainsProcess checks the connected server's retained process handle rather
// than reopening a PID, which might identify a different process after reuse.
func (t *TrackedProcess) ContainsProcess(handle uintptr) (bool, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.job == 0 {
		return false, ErrJobClosed
	}
	return isProcessInJob(windows.Handle(handle), t.job)
}
