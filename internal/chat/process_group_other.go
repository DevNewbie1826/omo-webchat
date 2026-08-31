//go:build !unix

package chat

import (
	"errors"
	"os/exec"
)

// configureProcGroup is a no-op where process groups are not portable;
// CommandContext keeps its default behavior of killing the direct process.
func configureProcGroup(*exec.Cmd) {}

// killProcGroup is a no-op where process groups are not portable.
func killProcGroup(*exec.Cmd) error { return nil }

// exitEvidence extracts the raw exit code from a Wait error. Signal names
// are not portable off unix; the signal is reported as "".
func exitEvidence(err error) (code int, signal string) {
	var exitErr *exec.ExitError
	if !errors.As(err, &exitErr) {
		return 0, ""
	}
	return exitErr.ExitCode(), ""
}

// isKillSignal reports whether the raw signal name is the one our group kill
// delivers. Off unix the signal is never reported, so no exit can be proven
// to be our kill.
func isKillSignal(string) bool { return false }
