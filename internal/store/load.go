package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
)

func StateDir() (string, error) {
	var dir string
	// The XDG spec declares a relative XDG_STATE_HOME invalid; such values
	// are ignored and the home fallback applies.
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

// cliWebchatStatePath is the state file location used before the omo-webchat
// rename: $XDG_STATE_HOME/cli-webchat/state.json when XDG_STATE_HOME is
// absolute, otherwise $HOME/.local/state/cli-webchat/state.json.
func cliWebchatStatePath() (string, error) {
	if xdg := os.Getenv("XDG_STATE_HOME"); xdg != "" && filepath.IsAbs(xdg) {
		return filepath.Join(xdg, "cli-webchat", "state.json"), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("resolving home directory: %w", err)
	}
	return filepath.Join(home, ".local", "state", "cli-webchat", "state.json"), nil
}

// legacyStatePath is the pre-XDG state file location under ~/.terminal-hub.
func legacyStatePath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("resolving home directory: %w", err)
	}
	return filepath.Join(home, ".terminal-hub", "state.json"), nil
}

func Load(_ context.Context, logger *slog.Logger) (*Store, error) {
	dir, err := StateDir()
	if err != nil {
		return nil, err
	}
	path := filepath.Join(dir, "state.json")

	// One-way legacy migration: when the state file does not exist yet, copy
	// the first existing fallback verbatim: the previous cli-webchat state
	// file ($XDG_STATE_HOME/cli-webchat/state.json when absolute, else
	// $HOME/.local/state/cli-webchat/state.json), then ~/.terminal-hub/state.json.
	// Nothing under those old locations is ever written, renamed, or deleted,
	// so re-runs are no-ops and an existing state file always wins over a fallback.
	if _, statErr := os.Lstat(path); errors.Is(statErr, os.ErrNotExist) {
		cliPath, err := cliWebchatStatePath()
		if err != nil {
			return nil, err
		}
		legacyPath, err := legacyStatePath()
		if err != nil {
			return nil, err
		}
		for _, src := range []string{cliPath, legacyPath} {
			legacy, err := os.ReadFile(src)
			if err == nil {
				if _, err := writeStateNoClobber(path, legacy); err != nil {
					return nil, fmt.Errorf("migrating legacy state file: %w", err)
				}
				break
			}
			if !errors.Is(err, os.ErrNotExist) {
				return nil, fmt.Errorf("reading legacy state file: %w", err)
			}
		}
	}

	return loadState(path, logger)
}

// writeStateNoClobber atomically installs data at path without overwriting an
// existing file: the bytes are written to a same-directory temporary file and
// hard-linked into place, so a concurrent creator wins the race (its file is
// never truncated) and an interrupted install can never leave a partial
// state.json behind. It reports whether this call installed the file.
func writeStateNoClobber(path string, data []byte) (bool, error) {
	if _, err := os.Lstat(path); err == nil {
		return false, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return false, fmt.Errorf("checking state file: %w", err)
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".state-migrate-*")
	if err != nil {
		return false, fmt.Errorf("creating temporary state file: %w", err)
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return false, fmt.Errorf("writing temporary state file: %w", err)
	}
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return false, fmt.Errorf("setting temporary state file mode: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return false, fmt.Errorf("closing temporary state file: %w", err)
	}
	if err := os.Link(tmpName, path); err != nil {
		if errors.Is(err, os.ErrExist) {
			return false, nil
		}
		return false, fmt.Errorf("installing state file: %w", err)
	}
	return true, nil
}

// LoadDir loads the store from an explicit state directory, creating the
// directory when absent. The legacy migration never runs: an explicit state
// directory is fully independent of the default and legacy locations.
func LoadDir(dir string, logger *slog.Logger) (*Store, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("creating state directory: %w", err)
	}
	return loadState(filepath.Join(dir, "state.json"), logger)
}

// loadState reads (starting empty when absent) the state file at path.
func loadState(path string, logger *slog.Logger) (*Store, error) {
	s := &Store{path: path, logger: logger}

	raw, err := os.ReadFile(s.path)
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			return nil, fmt.Errorf("reading state file: %w", err)
		}
		s.data.Workspaces = []Workspace{}
		return s, nil
	}

	if err := json.Unmarshal(raw, &s.data); err != nil {
		return nil, fmt.Errorf("parsing state file: %w", err)
	}
	// Loading is non-destructive: every persisted provider identity is kept
	// verbatim, so foreign records survive rebrands and unrelated flushes.
	// Launchability is decided per chat by chat.NormalizePersistedProvider at
	// read and launch time, never by rewriting persisted state.
	return s, nil
}
