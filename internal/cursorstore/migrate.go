package cursorstore

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"

	"github.com/DevNewbie1826/omo-webchat/internal/adoptcopy"
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

// MigrateLegacySession copies an unknown-provenance session into the store's
// owned directory and atomically records verified provenance. Callers must use
// this hook before GetChatForOpen; a failed migration leaves the original
// identity unchanged and therefore unopenable.
func (s *Store) MigrateLegacySession(ctx context.Context, id string) (Chat, error) {
	chat, err := s.GetChat(id)
	if err != nil {
		return Chat{}, err
	}
	if chat.SessionFile == "" || IsOwnedSession(chat, s.OwnedSessionDir()) {
		return chat, nil
	}

	expectedID := chat.DurableSessionID
	if expectedID == "" {
		expectedID, err = legacySessionID(chat.SessionFile)
		if err != nil {
			return Chat{}, fmt.Errorf("%w: %w", ErrAdoptionRequired, err)
		}
	}
	result, err := adoptcopy.Adopt(ctx, chat.SessionFile, s.OwnedSessionDir(), expectedID)
	if err != nil {
		return Chat{}, fmt.Errorf("%w: %w", ErrAdoptionRequired, err)
	}
	if chat.DurableSessionID != "" && chat.DurableSessionID != result.SessionID {
		return Chat{}, fmt.Errorf("%w: durable session identity mismatch", ErrAdoptionRequired)
	}

	// Compare and swap after the copy so a concurrent provider/store update
	// cannot be overwritten by a migration based on stale identity metadata.
	s.mu.Lock()
	defer s.mu.Unlock()
	current, ok := s.data.Chats[id]
	if !ok {
		return Chat{}, ErrNotFound
	}
	if IsOwnedSession(current, s.OwnedSessionDir()) {
		return current, nil
	}
	if current.SessionFile != chat.SessionFile || current.DurableSessionID != chat.DurableSessionID {
		return Chat{}, fmt.Errorf("%w: session identity changed during migration", ErrAdoptionRequired)
	}
	owned := Chat{SessionFile: result.Path, SessionProvenance: SessionProvenanceAdopted}
	if !IsOwnedSession(owned, s.OwnedSessionDir()) {
		return Chat{}, fmt.Errorf("%w: invalid owned session destination", ErrAdoptionRequired)
	}
	candidate := cloneState(s.data)
	current.SessionFile = result.Path
	current.DurableSessionID = result.SessionID
	current.SessionProvenance = SessionProvenanceAdopted
	candidate.Chats[id] = current
	if err := s.flushLocked(candidate); err != nil {
		return Chat{}, err
	}
	return current, nil
}

func legacySessionID(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64*1024), 1<<20)
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		var header struct {
			Type string `json:"type"`
			ID   string `json:"id"`
		}
		if err := json.Unmarshal(line, &header); err != nil || header.Type != "session" || header.ID == "" {
			return "", errors.New("invalid legacy session header")
		}
		return header.ID, nil
	}
	if err := scanner.Err(); err != nil {
		return "", err
	}
	return "", errors.New("missing legacy session header")
}

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
