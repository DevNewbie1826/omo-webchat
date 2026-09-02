package cursorstore

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
)

// MigrationSummary reports the eager v1 import performed at startup.
type MigrationSummary struct{ Workspaces, Chats, Skipped int }

type legacyState struct {
	Workspaces []legacyWorkspace `json:"workspaces"`
	Layout     json.RawMessage   `json:"layout"`
}
type legacyWorkspace struct {
	ID        string       `json:"id"`
	Name      string       `json:"name"`
	Path      string       `json:"path"`
	Chats     []legacyChat `json:"chats"`
	Terminals []legacyChat `json:"terminals"`
}
type legacyChat struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	NameSource  string `json:"nameSource"`
	Provider    string `json:"provider"`
	PiSessionID string `json:"piSessionId"`
	WsID        string `json:"wsId"`
	CWD         string `json:"cwd"`
	CreatedAt   int64  `json:"createdAt"`
	LastUsedAt  int64  `json:"lastUsedAt"`
}

var uuidPattern = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// MigrateV1FromStateDir imports the first existing v1 state source. Default
// state-dir callers pass historical=true to honor the rename chain:
// omo-webchat/state.json, then sibling cli-webchat/state.json, then
// ~/.terminal-hub/state.json. Explicit custom state dirs pass false and remain
// isolated from default and historical locations.
func MigrateV1FromStateDir(stateDir string, historical bool, dst *Store) (MigrationSummary, error) {
	paths, err := v1StatePaths(stateDir, historical)
	if err != nil {
		return MigrationSummary{}, err
	}
	for _, path := range paths {
		if _, err := os.Lstat(path); err == nil {
			return MigrateV1(path, dst)
		} else if !errors.Is(err, os.ErrNotExist) {
			return MigrationSummary{}, fmt.Errorf("checking v1 state: %w", err)
		}
	}
	return MigrationSummary{}, nil
}

// MigrateV1 eagerly imports state.json into the cursor store. It only reads
// legacyPath and skips chat IDs already present, making repeated startups safe.
func MigrateV1(legacyPath string, dst *Store) (MigrationSummary, error) {
	var summary MigrationSummary
	raw, err := os.ReadFile(legacyPath)
	if errors.Is(err, os.ErrNotExist) {
		return summary, nil
	}
	if err != nil {
		return summary, fmt.Errorf("reading v1 state: %w", err)
	}
	var old legacyState
	if err := json.Unmarshal(raw, &old); err != nil {
		return summary, fmt.Errorf("parsing v1 state: %w", err)
	}
	if len(dst.GetLayout()) == 0 && len(old.Layout) > 0 {
		if err := dst.SetLayout(old.Layout); err != nil {
			return summary, fmt.Errorf("migrating layout: %w", err)
		}
	}
	for _, ws := range old.Workspaces {
		if _, getErr := dst.GetWorkspace(ws.ID); errors.Is(getErr, ErrNotFound) {
			if err := dst.SaveWorkspace(Workspace{ID: ws.ID, Name: ws.Name, Path: ws.Path}); err != nil {
				return summary, fmt.Errorf("migrating workspace %q: %w", ws.ID, err)
			}
			summary.Workspaces++
		} else if getErr != nil {
			return summary, getErr
		}
		chats := ws.Chats
		if len(chats) == 0 && len(ws.Terminals) > 0 {
			chats = ws.Terminals
		}
		for _, oldChat := range chats {
			if _, err := dst.GetChat(oldChat.ID); err == nil {
				summary.Skipped++
				continue
			} else if !errors.Is(err, ErrNotFound) {
				return summary, err
			}
			cwd := oldChat.CWD
			if cwd == "" {
				cwd = ws.Path
			}
			wsID := oldChat.WsID
			if wsID == "" {
				wsID = ws.ID
			}
			nameSource := oldChat.NameSource
			if nameSource == "" || nameSource == "default" {
				nameSource = NameSourceAuto
			}
			// Provider and timestamps are intentionally copied verbatim. Listing
			// filters unsupported providers and normalizes second-resolution
			// recency only while comparing, preserving an honest v1 record.
			chat := Chat{ID: oldChat.ID, WorkspaceID: wsID, CWD: cwd, Provider: oldChat.Provider, Name: oldChat.Name, NameSource: nameSource, CreatedAt: oldChat.CreatedAt, LastUsedAt: oldChat.LastUsedAt}
			switch {
			case filepath.IsAbs(oldChat.PiSessionID):
				chat.SessionFile = oldChat.PiSessionID
			case uuidPattern.MatchString(oldChat.PiSessionID):
				chat.DurableSessionID = oldChat.PiSessionID
			}
			if err := dst.SaveChat(chat); err != nil {
				return summary, fmt.Errorf("migrating chat %q: %w", oldChat.ID, err)
			}
			summary.Chats++
		}
	}
	return summary, nil
}
