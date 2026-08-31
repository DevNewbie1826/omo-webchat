//go:build unix

package chat

import (
	"errors"
	"os"
	"os/exec"
	"syscall"
)

// configureProcGroup runs the provider in its own process group and replaces
// CommandContext's single-process kill with a group kill, so every descendant
// (tools, subprocesses) dies with the session on Close or context
// cancellation.
func configureProcGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		return killProcGroup(cmd)
	}
}

// killProcGroup sends SIGKILL to the provider's whole process group. The group
// id equals the leader's pid (Setpgid makes it the group leader), so -pid
// reaches every descendant. Called both by CommandContext while the leader is
// alive and directly by the reaper after the leader exits, when the context
// hook no longer fires.
func killProcGroup(cmd *exec.Cmd) error {
	if cmd.Process == nil {
		return nil
	}
	err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	if errors.Is(err, syscall.ESRCH) {
		return os.ErrProcessDone
	}
	return err
}

// exitEvidence extracts the raw exit code and signal from a Wait error while
// they still exist. reap erases signaled exits from closeErr afterwards, so
// this is the only place the raw ProcessState survives.
func exitEvidence(err error) (code int, signal string) {
	var exitErr *exec.ExitError
	if !errors.As(err, &exitErr) {
		return 0, ""
	}
	if ws, ok := exitErr.ProcessState.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
		return -1, ws.Signal().String()
	}
	return exitErr.ExitCode(), ""
}

// isKillSignal reports whether the raw signal name is the one our group kill
// delivers (the platform's rendering of SIGKILL).
func isKillSignal(signal string) bool {
	return signal == syscall.SIGKILL.String()
}
