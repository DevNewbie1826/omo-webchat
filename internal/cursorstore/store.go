// Package cursorstore is the v2 cursor-only persistence layer: it holds
// resume pointers (per-chat session file, durable session id, cwd), workspace
// metadata, and UI layout state — nothing else. Unlike the v1 store there are
// no transcripts, activity snapshots, notice logs, or replay seeds; the omo
// session file itself is the source of record and this store only remembers
// where to resume it.
package cursorstore

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

var (
	// ErrCorrupt reports an unreadable or invalid state file. The store never
	// silently resets: the caller decides what to do with the damaged file.
	ErrCorrupt = errors.New("cursor store: state file corrupt")
	// ErrNotFound reports an unknown chat, workspace, or reference.
	ErrNotFound = errors.New("cursor store: not found")
	// ErrInvalidLayout reports a SetLayout argument that is not valid JSON.
	ErrInvalidLayout = errors.New("cursor store: invalid layout")
	// ErrInvalidNameSource reports a chat name source outside "auto"/"user".
	ErrInvalidNameSource = errors.New("cursor store: invalid nameSource")
	// ErrPersistence classifies failures while atomically installing state.
	ErrPersistence = errors.New("cursor store: persistence failed")
)

type Clock interface{ Now() time.Time }

type systemClock struct{}

func (systemClock) Now() time.Time { return time.Now() }

// NameSource values for Chat.NameSource.
const (
	NameSourceAuto = "auto"
	NameSourceUser = "user"
)

// Workspace is UI metadata for a workspace directory.
type Workspace struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Path string `json:"path"`
}

// Chat is the resume pointer for one chat. It never carries transcript or
// replay-seed state — only where the durable session lives.
type Chat struct {
	ID               string `json:"id"`
	WorkspaceID      string `json:"workspaceId"`
	CWD              string `json:"cwd"`
	SessionFile      string `json:"sessionFile,omitempty"`
	DurableSessionID string `json:"durableSessionId,omitempty"`
	Name             string `json:"name"`
	// NameSource is "auto" (generated) or "user" (explicitly named).
	NameSource string `json:"nameSource"`
	CreatedAt  int64  `json:"createdAt"`
	// LastUsedAt is the Unix-millisecond stamp of the most recent successful
	// open; zero means never used.
	LastUsedAt int64 `json:"lastUsedAt,omitempty"`
}

// State is the full persisted document.
type State struct {
	Workspaces []Workspace `json:"workspaces"`
	// Chats are stored top-level, keyed by chat ID, and reference
	// Workspace.ID. Any chat whose workspace is deleted is deleted with it.
	Chats  map[string]Chat `json:"chats,omitempty"`
	Layout json.RawMessage `json:"layout,omitempty"`
}

// Store is a mutex-guarded in-memory cursor store flushed to disk with an
// atomic temp+fsync+rename write on every mutation. Create with Open.
type Store struct {
	path  string
	clock Clock

	mu   sync.Mutex
	data State
}

// Open loads the state file at path, or starts empty when the file does not
// exist. A present-but-unreadable or invalid file is a typed ErrCorrupt, never
// a silent reset. The parent directory is created when absent.
func Open(path string) (*Store, error) { return OpenWithClock(path, systemClock{}) }

// OpenWithClock is Open with an injected clock for deterministic LastUsedAt.
func OpenWithClock(path string, clock Clock) (*Store, error) {
	if clock == nil {
		clock = systemClock{}
	}
	if dir := filepath.Dir(path); dir != "" {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return nil, fmt.Errorf("cursorstore: creating state directory: %w", err)
		}
	}
	s := &Store{
		path:  path,
		clock: clock,
		data:  State{Workspaces: []Workspace{}},
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return s, nil
		}
		return nil, fmt.Errorf("%w: reading %s: %w", ErrCorrupt, path, err)
	}
	if err := json.Unmarshal(raw, &s.data); err != nil {
		return nil, fmt.Errorf("%w: parsing %s: %w", ErrCorrupt, path, err)
	}
	if s.data.Workspaces == nil {
		s.data.Workspaces = []Workspace{}
	}
	return s, nil
}

// flushLocked serializes the candidate state and installs it atomically:
// write a temp file in the same directory, fsync, close, rename over the
// target, then fsync the directory. Mode is 0600. On failure the in-memory
// state is left untouched, so no partial state is ever observable.
func (s *Store) flushLocked(candidate State) error {
	persistErr := func(op string, err error) error {
		return fmt.Errorf("%w: %s: %w", ErrPersistence, op, err)
	}
	raw, err := json.MarshalIndent(candidate, "", "  ")
	if err != nil {
		return persistErr("encoding state", err)
	}
	tmp, err := os.CreateTemp(filepath.Dir(s.path), ".cursorstore-*")
	if err != nil {
		return persistErr("creating temp file", err)
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName) // no-op after successful rename
	closeOnFailure := func(op string, opErr error) error {
		if closeErr := tmp.Close(); closeErr != nil {
			return persistErr(op, errors.Join(opErr, fmt.Errorf("closing temp file: %w", closeErr)))
		}
		return persistErr(op, opErr)
	}
	if _, err := tmp.Write(raw); err != nil {
		return closeOnFailure("writing temp file", err)
	}
	if err := tmp.Chmod(0o600); err != nil {
		return closeOnFailure("setting temp file mode", err)
	}
	if err := tmp.Sync(); err != nil {
		return closeOnFailure("syncing temp file", err)
	}
	if err := tmp.Close(); err != nil {
		return persistErr("closing temp file", err)
	}
	if err := os.Rename(tmpName, s.path); err != nil {
		return persistErr("replacing state file", err)
	}
	dir, err := os.Open(filepath.Dir(s.path))
	if err != nil {
		return persistErr("opening state directory", err)
	}
	if err := dir.Sync(); err != nil {
		if closeErr := dir.Close(); closeErr != nil {
			err = errors.Join(err, fmt.Errorf("closing state directory: %w", closeErr))
		}
		return persistErr("syncing state directory", err)
	}
	if err := dir.Close(); err != nil {
		return persistErr("closing state directory", err)
	}
	s.data = candidate
	return nil
}

// SaveWorkspace creates or updates workspace metadata.
func (s *Store) SaveWorkspace(ws Workspace) error {
	if ws.ID == "" {
		return fmt.Errorf("%w: workspace id empty", ErrNotFound)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	candidate := cloneState(s.data)
	for i := range candidate.Workspaces {
		if candidate.Workspaces[i].ID == ws.ID {
			candidate.Workspaces[i] = ws
			return s.flushLocked(candidate)
		}
	}
	candidate.Workspaces = append(candidate.Workspaces, ws)
	return s.flushLocked(candidate)
}

// GetWorkspace returns workspace metadata by ID.
func (s *Store) GetWorkspace(id string) (Workspace, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, ws := range s.data.Workspaces {
		if ws.ID == id {
			return ws, nil
		}
	}
	return Workspace{}, ErrNotFound
}

// UpdateWorkspace replaces existing workspace metadata.
func (s *Store) UpdateWorkspace(ws Workspace) (Workspace, error) {
	if ws.ID == "" {
		return Workspace{}, ErrNotFound
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	candidate := cloneState(s.data)
	for i := range candidate.Workspaces {
		if candidate.Workspaces[i].ID == ws.ID {
			candidate.Workspaces[i] = ws
			if err := s.flushLocked(candidate); err != nil {
				return Workspace{}, err
			}
			return ws, nil
		}
	}
	return Workspace{}, ErrNotFound
}

// RenameWorkspace updates only the workspace's display name.
func (s *Store) RenameWorkspace(id, name string) (Workspace, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	candidate := cloneState(s.data)
	for i := range candidate.Workspaces {
		if candidate.Workspaces[i].ID == id {
			candidate.Workspaces[i].Name = name
			if err := s.flushLocked(candidate); err != nil {
				return Workspace{}, err
			}
			return candidate.Workspaces[i], nil
		}
	}
	return Workspace{}, ErrNotFound
}

// ListWorkspaces returns a snapshot of all workspace metadata.
func (s *Store) ListWorkspaces() []Workspace {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Workspace, len(s.data.Workspaces))
	copy(out, s.data.Workspaces)
	return out
}

// DeleteWorkspace removes a workspace and every chat in it (cascading).
func (s *Store) DeleteWorkspace(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	idx := -1
	for i := range s.data.Workspaces {
		if s.data.Workspaces[i].ID == id {
			idx = i
			break
		}
	}
	if idx < 0 {
		return ErrNotFound
	}
	candidate := cloneState(s.data)
	candidate.Workspaces = append(candidate.Workspaces[:idx], candidate.Workspaces[idx+1:]...)
	for chatID, c := range candidate.Chats {
		if c.WorkspaceID == id {
			delete(candidate.Chats, chatID)
		}
	}
	return s.flushLocked(candidate)
}

// SaveChat creates or updates a chat cursor record. The chat's workspace must
// exist; NameSource must be empty, "auto", or "user".
func (s *Store) SaveChat(c Chat) error {
	if c.ID == "" {
		return fmt.Errorf("%w: chat id empty", ErrNotFound)
	}
	switch c.NameSource {
	case "", NameSourceAuto, NameSourceUser:
	default:
		return fmt.Errorf("%w: %q", ErrInvalidNameSource, c.NameSource)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.hasWorkspaceLocked(c.WorkspaceID) {
		return fmt.Errorf("%w: workspace %q", ErrNotFound, c.WorkspaceID)
	}
	candidate := cloneState(s.data)
	if candidate.Chats == nil {
		candidate.Chats = map[string]Chat{}
	}
	candidate.Chats[c.ID] = c
	return s.flushLocked(candidate)
}

// UpdateChat replaces an existing chat cursor record.
func (s *Store) UpdateChat(c Chat) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	current, ok := s.data.Chats[c.ID]
	if !ok {
		return ErrNotFound
	}
	if c.WorkspaceID != current.WorkspaceID || !s.hasWorkspaceLocked(c.WorkspaceID) {
		return ErrNotFound
	}
	switch c.NameSource {
	case "", NameSourceAuto, NameSourceUser:
	default:
		return fmt.Errorf("%w: %q", ErrInvalidNameSource, c.NameSource)
	}
	candidate := cloneState(s.data)
	candidate.Chats[c.ID] = c
	return s.flushLocked(candidate)
}

// GetChat returns a copy of the chat cursor record.
func (s *Store) GetChat(id string) (Chat, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	c, ok := s.data.Chats[id]
	if !ok {
		return Chat{}, ErrNotFound
	}
	return c, nil
}

// ListChats returns a snapshot of chats belonging to workspaceID.
func (s *Store) ListChats(workspaceID string) []Chat {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Chat, 0)
	for _, chat := range s.data.Chats {
		if chat.WorkspaceID == workspaceID {
			out = append(out, chat)
		}
	}
	return out
}

// DeleteChat removes a chat cursor record.
func (s *Store) DeleteChat(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.data.Chats[id]; !ok {
		return ErrNotFound
	}
	candidate := cloneState(s.data)
	delete(candidate.Chats, id)
	return s.flushLocked(candidate)
}

// TouchLastUsed stamps the chat's LastUsedAt with the current time.
func (s *Store) TouchLastUsed(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.data.Chats[id]; !ok {
		return ErrNotFound
	}
	candidate := cloneState(s.data)
	updated := candidate.Chats[id]
	updated.LastUsedAt = s.clock.Now().UnixMilli()
	candidate.Chats[id] = updated
	return s.flushLocked(candidate)
}

// SetLayout persists a UI layout JSON document (passthrough, validated only
// for well-formedness).
func (s *Store) SetLayout(raw json.RawMessage) error {
	if !json.Valid(raw) {
		return ErrInvalidLayout
	}
	// Compact so the layout byte-roundtrips deterministically regardless of
	// the surrounding document's indentation.
	var compact bytes.Buffer
	if err := json.Compact(&compact, raw); err != nil {
		return ErrInvalidLayout
	}
	stored := make(json.RawMessage, compact.Len())
	copy(stored, compact.Bytes())
	s.mu.Lock()
	defer s.mu.Unlock()
	candidate := cloneState(s.data)
	candidate.Layout = stored
	return s.flushLocked(candidate)
}

// GetLayout returns a copy of the persisted layout, or nil when unset.
func (s *Store) GetLayout() json.RawMessage {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.data.Layout) == 0 {
		return nil
	}
	out := make(json.RawMessage, len(s.data.Layout))
	copy(out, s.data.Layout)
	return out
}

func (s *Store) hasWorkspaceLocked(id string) bool {
	for _, ws := range s.data.Workspaces {
		if ws.ID == id {
			return true
		}
	}
	return false
}

// cloneState deep-copies the state so a failed flush can be discarded
// without corrupting live data through shared slices or maps.
func cloneState(src State) State {
	out := State{
		Workspaces: make([]Workspace, len(src.Workspaces)),
	}
	copy(out.Workspaces, src.Workspaces)
	if src.Chats != nil {
		out.Chats = make(map[string]Chat, len(src.Chats))
		for id, c := range src.Chats {
			out.Chats[id] = c
		}
	}
	if len(src.Layout) > 0 {
		out.Layout = make(json.RawMessage, len(src.Layout))
		copy(out.Layout, src.Layout)
	}
	return out
}
