package store

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"sync"

	"github.com/DevNewbie1826/omo-webchat/internal/chat"
)

var (
	ErrNotFound      = errors.New("not found")
	ErrDuplicate     = errors.New("session name already exists")
	ErrInvalidLayout = errors.New("invalid layout")
)

type Chat struct {
	ID          string          `json:"id"`
	Name        string          `json:"name"`
	NameSource  string          `json:"nameSource,omitempty"`
	PiSessionID string          `json:"piSessionId,omitempty"`
	WsID        string          `json:"wsId"`
	Cwd         string          `json:"cwd"`
	SessionDir  string          `json:"sessionDir,omitempty"`
	Provider    string          `json:"provider,omitempty"`
	Model       json.RawMessage `json:"model,omitempty"`
	CreatedAt   int64           `json:"createdAt"`
	LastEntryID string          `json:"lastEntryId,omitempty"`
	// ActivitySnapshot is the persisted replay seed for restored sessions: the
	// latest replayable activity payloads at the last settled run. A session
	// opened from this record replays the pair to its first client until live
	// provider snapshots supersede it.
	ActivitySnapshot *chat.ActivitySnapshotPair `json:"activitySnapshot,omitempty"`

	extra map[string]json.RawMessage
}

type Workspace struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Path  string `json:"path"`
	Chats []Chat `json:"chats"`

	extra map[string]json.RawMessage
}

type state struct {
	Workspaces []Workspace     `json:"workspaces"`
	Layout     json.RawMessage `json:"layout,omitempty"`

	extra map[string]json.RawMessage
}

type Store struct {
	path   string
	logger *slog.Logger
	mu     sync.RWMutex
	data   state
}

func newID(prefix string) (string, error) {
	raw := make([]byte, 4)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("generating id: %w", err)
	}
	return prefix + hex.EncodeToString(raw), nil
}

func (s *Store) flushLocked(candidate state) error {
	raw, err := json.MarshalIndent(candidate, "", "  ")
	if err != nil {
		return fmt.Errorf("encoding state: %w", err)
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return fmt.Errorf("writing state file: %w", err)
	}
	if err := os.Rename(tmp, s.path); err != nil {
		return fmt.Errorf("replacing state file: %w", err)
	}
	s.data = candidate
	return nil
}

func (s *Store) ListWorkspaces() []Workspace {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]Workspace, len(s.data.Workspaces))
	for i, ws := range s.data.Workspaces {
		out[i] = projectWorkspace(ws)
	}
	return out
}

func findWorkspace(data *state, id string) *Workspace {
	for i := range data.Workspaces {
		if data.Workspaces[i].ID == id {
			return &data.Workspaces[i]
		}
	}
	return nil
}

func (s *Store) findWorkspaceLocked(id string) *Workspace {
	return findWorkspace(&s.data, id)
}

func (s *Store) GetWorkspace(id string) (Workspace, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	ws := s.findWorkspaceLocked(id)
	if ws == nil {
		return Workspace{}, ErrNotFound
	}
	return projectWorkspace(*ws), nil
}

func copyWorkspace(ws Workspace) Workspace {
	chats := make([]Chat, len(ws.Chats))
	for i, c := range ws.Chats {
		chats[i] = cloneChat(c)
	}
	ws.Chats = chats
	ws.extra = cloneUnknownJSONFields(ws.extra)
	return ws
}

func cloneState(src state) state {
	workspaces := make([]Workspace, len(src.Workspaces))
	for i, ws := range src.Workspaces {
		workspaces[i] = copyWorkspace(ws)
	}
	return state{
		Workspaces: workspaces,
		Layout:     cloneRawMessage(src.Layout),
		extra:      cloneUnknownJSONFields(src.extra),
	}
}

// projectWorkspace shapes a returned workspace copy for an Omo-only runtime:
// legacy launchable identities (empty, senpi) are reported as omo and chats
// persisted for unsupported providers are hidden. GetChat stays raw so
// unsupported records remain addressable for precise bad_provider rejection.
// The store's persisted data is never touched by the projection.
func projectWorkspace(ws Workspace) Workspace {
	out := copyWorkspace(ws)
	kept := make([]Chat, 0, len(out.Chats))
	for _, c := range out.Chats {
		launchable, err := chat.NormalizePersistedProvider(c.Provider)
		if err != nil {
			continue
		}
		c.Provider = launchable
		c.CreatedAt = projectCreatedAt(c.CreatedAt)
		kept = append(kept, c)
	}
	out.Chats = kept
	return out
}

// projectCreatedAt converts legacy Unix-second timestamps to milliseconds on
// returned copies. Persisted records remain unchanged.
func projectCreatedAt(createdAt int64) int64 {
	const millisecondsThreshold = int64(1_000_000_000_000)
	if createdAt > 0 && createdAt < millisecondsThreshold {
		return createdAt * 1000
	}
	return createdAt
}

func (s *Store) CreateWorkspace(name, path string) (Workspace, error) {
	id, err := newID("ws-")
	if err != nil {
		return Workspace{}, err
	}
	ws := Workspace{ID: id, Name: name, Path: path, Chats: []Chat{}}
	s.mu.Lock()
	defer s.mu.Unlock()
	candidate := cloneState(s.data)
	candidate.Workspaces = append(candidate.Workspaces, ws)
	if err := s.flushLocked(candidate); err != nil {
		return Workspace{}, err
	}
	return ws, nil
}

func (s *Store) DeleteWorkspace(id string) (Workspace, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	candidate := cloneState(s.data)
	ws := findWorkspace(&candidate, id)
	if ws == nil {
		return Workspace{}, ErrNotFound
	}
	removed := copyWorkspace(*ws)
	for i := range candidate.Workspaces {
		if candidate.Workspaces[i].ID == id {
			candidate.Workspaces = append(candidate.Workspaces[:i], candidate.Workspaces[i+1:]...)
			break
		}
	}
	if err := s.flushLocked(candidate); err != nil {
		return Workspace{}, err
	}
	return removed, nil
}

func (s *Store) RenameWorkspace(id, name string) (Workspace, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	candidate := cloneState(s.data)
	ws := findWorkspace(&candidate, id)
	if ws == nil {
		return Workspace{}, ErrNotFound
	}
	ws.Name = name
	if err := s.flushLocked(candidate); err != nil {
		return Workspace{}, err
	}
	return projectWorkspace(*ws), nil
}

func (s *Store) GetLayout() json.RawMessage {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if len(s.data.Layout) == 0 {
		return nil
	}
	out := make(json.RawMessage, len(s.data.Layout))
	copy(out, s.data.Layout)
	return out
}

func (s *Store) SetLayout(raw json.RawMessage) error {
	if !json.Valid(raw) {
		return ErrInvalidLayout
	}
	stored := make(json.RawMessage, len(raw))
	copy(stored, raw)
	s.mu.Lock()
	defer s.mu.Unlock()
	candidate := cloneState(s.data)
	candidate.Layout = stored
	return s.flushLocked(candidate)
}
