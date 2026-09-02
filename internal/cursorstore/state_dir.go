package cursorstore

import (
	"fmt"
	"os"
	"path/filepath"
)

// StateDir resolves and creates the application's default XDG state directory.
func StateDir() (string, error) {
	var dir string
	if xdg := os.Getenv("XDG_STATE_HOME"); xdg != "" && filepath.IsAbs(xdg) {
		dir = filepath.Join(xdg, "omo-webchat")
	} else {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("resolving home directory: %w", err)
		}
		dir = filepath.Join(home, ".local", "state", "omo-webchat")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", fmt.Errorf("creating state directory: %w", err)
	}
	return dir, nil
}
