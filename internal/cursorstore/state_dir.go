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

func v1StatePaths(stateDir string, historical bool) ([]string, error) {
	paths := []string{filepath.Join(stateDir, "state.json")}
	if !historical {
		return paths, nil
	}
	// cli-webchat shared the same XDG state home as omo-webchat, so derive
	// its location from the resolved state dir rather than reinterpreting XDG.
	paths = append(paths, filepath.Join(filepath.Dir(stateDir), "cli-webchat", "state.json"))
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, fmt.Errorf("resolving home directory: %w", err)
	}
	return append(paths, filepath.Join(home, ".terminal-hub", "state.json")), nil
}
