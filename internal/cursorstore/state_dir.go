package cursorstore

import (
	"fmt"
	"os"
)

// StateDir resolves and creates the application's default state directory.
func StateDir() (string, error) {
	dir, err := defaultStateDir()
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", fmt.Errorf("creating state directory: %w", err)
	}
	return dir, nil
}
