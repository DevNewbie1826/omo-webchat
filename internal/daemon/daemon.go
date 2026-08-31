// Package daemon manages background omo-webchat server processes.
package daemon

import (
	"errors"
	"os"

	"github.com/DevNewbie1826/omo-webchat/internal/config"
)

// Child holds the lock file owned by a daemon child process.
type Child struct {
	lockFile    *os.File
	readyWriter *os.File
	pidPath     string
}

var (
	// ErrNotRunning reports that no live daemon process owns the PID file.
	ErrNotRunning = errors.New("omo-webchat is not running")
	// ErrUnsupported reports that the host cannot manage daemon processes.
	ErrUnsupported = errors.New("daemon mode is not supported on this platform")
)

// Start launches a detached child server and waits until it has bound its
// listener and taken ownership.
func Start(cfg *config.Config, args []string) (int, string, error) {
	return start(cfg, args)
}

// Stop terminates the running daemon process. State files are resolved under
// stateDir when non-empty, else under the store default.
func Stop(stateDir string) (int, error) {
	return stop(stateDir)
}

// Status returns the live daemon process ID.
func Status(stateDir string) (int, error) {
	return status(stateDir)
}

// PrepareChild validates the inherited lock and readiness-pipe descriptors.
func PrepareChild(stateDir string) (*Child, error) {
	return prepareChild(stateDir)
}

// Ready records daemon ownership and reports a bound listener to the parent.
func (c *Child) Ready() error {
	return childReady(c)
}

// Close releases the child lock file.
func (c *Child) Close() error {
	return closeChild(c)
}
