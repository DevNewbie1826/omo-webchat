//go:build windows

package cursorstore

import (
	"fmt"
	"os"
	"path/filepath"
)

func defaultStateDir() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("resolving user config directory: %w", err)
	}
	return filepath.Join(dir, "omo-webchat"), nil
}
