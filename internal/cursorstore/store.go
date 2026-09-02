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
	"sort"
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
	// ErrAdoptionRequired reports a chat whose session file has no verified
	// server-owned provenance. Call MigrateLegacySession before opening it.
	ErrAdoptionRequired = errors.New("cursor store: session adoption required")
)

type Clock interface{ Now() time.Time }

type systemClock struct{}

func (systemClock) Now() time.Time { return time.Now() }

// NameSource values for Chat.NameSource.
const (
	NameSourceAuto = "auto"
	NameSourceUser = "user"

	// SessionProvenanceAdopted is persisted only after a session has been
	// copied into the store's owned session directory and verified.
	SessionProvenanceAdopted = "adopted-copy"
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
	// SessionProvenance is empty for pre-provenance rows. Such rows may point
	// at externally owned files and must be adopted before they are opened.
	SessionProvenance string `json:"sessionProvenance,omitempty"`
	// Provider preserves the v1 runtime identity. Empty, "senpi", and "omo"
	// are launchable by omo; other values remain persisted but are hidden from
	// listings so they cannot be mistaken for omo sessions.
	Provider string `json:"provider,omitempty"`
	Name     string `json:"name"`
	// NameSource is "auto" (generated) or "user" (explicitly named).
	NameSource string `json:"nameSource"`
	// TitleIsPlaceholder marks the pre-identity default name that auto-title
	// derivation may replace; any established name clears it.
	TitleIsPlaceholder bool  `json:"titleIsPlaceholder,omitempty"`
	CreatedAt          int64 `json:"createdAt"`
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

// StateDir returns the directory containing the cursor state file. Owned
// session assets live beneath this directory so custom state locations remain
// self-contained.
func (s *Store) StateDir() string { return filepath.Dir(s.path) }

// OwnedSessionDir is the only directory whose verified copies may carry owned
// provenance. Files are direct children so path validation is unambiguous.
func (s *Store) OwnedSessionDir() string { return filepath.Join(s.StateDir(), "adopted") }

// IsOwnedSession reports whether chat carries adopted-copy provenance and its
// session file is a direct child of ownedDir. The path check prevents a forged
// or stale marker from granting ownership to an external file.
func IsOwnedSession(chat Chat, ownedDir string) bool {
	if chat.SessionProvenance != SessionProvenanceAdopted || chat.SessionFile == "" {
		return false
	}
	ownedDir, err := filepath.Abs(filepath.Clean(ownedDir))
	if err != nil {
		return false
	}
	sessionFile, err := filepath.Abs(filepath.Clean(chat.SessionFile))
	return err == nil && filepath.Dir(sessionFile) == ownedDir
}

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

// UpdateIdentity updates only the durable provider identity. The read and
// write share one critical section so concurrent name changes cannot be lost.
// It deliberately clears adopted provenance: ordinary provider updates cannot
// assert that an arbitrary path is a server-owned verified copy.
func (s *Store) UpdateIdentity(id, sessionFile, durableID string) error {
	return s.updateChatFields(id, func(c *Chat) error {
		c.SessionFile = sessionFile
		c.DurableSessionID = durableID
		c.SessionProvenance = ""
		return nil
	})
}

// UpdateOwnedIdentity persists a verified adopted copy. The destination must
// be a direct child of this store's owned directory; callers cannot label an
// external path as owned.
func (s *Store) UpdateOwnedIdentity(id, sessionFile, durableID string) error {
	candidate := Chat{SessionFile: sessionFile, SessionProvenance: SessionProvenanceAdopted}
	if !IsOwnedSession(candidate, s.OwnedSessionDir()) {
		return fmt.Errorf("%w: invalid owned session destination", ErrAdoptionRequired)
	}
	return s.updateChatFields(id, func(c *Chat) error {
		c.SessionFile = sessionFile
		c.DurableSessionID = durableID
		c.SessionProvenance = SessionProvenanceAdopted
		return nil
	})
}

// UpdateName updates only the display-name fields atomically with respect to
// every other store mutation.
func (s *Store) UpdateName(id, name, source string) error {
	return s.updateChatFields(id, func(c *Chat) error {
		switch source {
		case "", NameSourceAuto, NameSourceUser:
		default:
			return fmt.Errorf("%w: %q", ErrInvalidNameSource, source)
		}
		c.Name = name
		c.NameSource = source
		// Any established name clears the pre-identity placeholder marker.
		c.TitleIsPlaceholder = false
		return nil
	})
}

func (s *Store) updateChatFields(id string, mutate func(*Chat) error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.data.Chats[id]
	if !ok {
		return ErrNotFound
	}
	candidate := cloneState(s.data)
	updated := candidate.Chats[id]
	if err := mutate(&updated); err != nil {
		return err
	}
	candidate.Chats[id] = updated
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

// GetChatForOpen returns only identities safe to pass to the provider. Empty
// session files create a new provider session; non-empty legacy or
// unknown-provenance paths require migration first.
func (s *Store) GetChatForOpen(id string) (Chat, error) {
	c, err := s.GetChat(id)
	if err != nil {
		return Chat{}, err
	}
	if c.SessionFile != "" && !IsOwnedSession(c, s.OwnedSessionDir()) {
		return Chat{}, fmt.Errorf("%w: chat %q", ErrAdoptionRequired, id)
	}
	return c, nil
}

// ListChats returns launchable chats belonging to workspaceID in MRU order.
// Unsupported v1 providers remain addressable through GetChat so their raw
// records survive unrelated writes, but are not projected into UI listings.
// Legacy second-resolution timestamps are compared as milliseconds without
// changing the values persisted in Chat.
func (s *Store) ListChats(workspaceID string) []Chat {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.listChatsLocked(workspaceID, true)
}

// ListChatsRaw returns every persisted chat belonging to workspaceID. It is
// for lifecycle teardown and migration, never UI projection.
func (s *Store) ListChatsRaw(workspaceID string) []Chat {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.listChatsLocked(workspaceID, false)
}

func (s *Store) listChatsLocked(workspaceID string, launchableOnly bool) []Chat {
	out := make([]Chat, 0)
	for _, chat := range s.data.Chats {
		if chat.WorkspaceID == workspaceID && (!launchableOnly || IsLaunchableProvider(chat.Provider)) {
			out = append(out, chat)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		ri, rj := RecencyMillis(out[i]), RecencyMillis(out[j])
		if ri != rj {
			return ri > rj
		}
		return out[i].ID < out[j].ID
	})
	return out
}

// IsLaunchableProvider reports whether omo can resume a persisted provider.
// Empty predates provider persistence and "senpi" is the pre-rebrand alias.
func IsLaunchableProvider(provider string) bool {
	switch provider {
	case "", "senpi", "omo":
		return true
	default:
		return false
	}
}

// RecencyMillis returns a comparable MRU key while preserving raw timestamps.
// V1 wrote Unix seconds; v2 writes Unix milliseconds. Positive values below
// 10^12 are therefore projected to milliseconds for ordering only.
func RecencyMillis(chat Chat) int64 {
	recency := chat.LastUsedAt
	if recency <= 0 {
		recency = chat.CreatedAt
	}
	if recency > 0 && recency < 1_000_000_000_000 {
		return recency * 1000
	}
	return recency
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
