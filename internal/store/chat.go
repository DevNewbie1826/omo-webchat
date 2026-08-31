package store

import (
	"context"
	"fmt"
	"path/filepath"
	"time"
)

func findChatLocked(ws *Workspace, id string) *Chat {
	for i := range ws.Chats {
		if ws.Chats[i].ID == id {
			return &ws.Chats[i]
		}
	}
	return nil
}

func (s *Store) GetChat(wsID, chatID string) (Chat, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	ws := s.findWorkspaceLocked(wsID)
	if ws == nil {
		return Chat{}, ErrNotFound
	}
	c := findChatLocked(ws, chatID)
	if c == nil {
		return Chat{}, ErrNotFound
	}
	return cloneChat(*c), nil
}

func (s *Store) AddChat(wsID string, c Chat) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	candidate := cloneState(s.data)
	ws := findWorkspace(&candidate, wsID)
	if ws == nil {
		return ErrNotFound
	}
	ws.Chats = append(ws.Chats, cloneChat(c))
	return s.flushLocked(candidate)
}

func (s *Store) UpdateChat(wsID, chatID string, mutate func(*Chat)) (Chat, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	candidate := cloneState(s.data)
	ws := findWorkspace(&candidate, wsID)
	if ws == nil {
		return Chat{}, ErrNotFound
	}
	c := findChatLocked(ws, chatID)
	if c == nil {
		return Chat{}, ErrNotFound
	}
	mutate(c)
	if err := s.flushLocked(candidate); err != nil {
		return Chat{}, err
	}
	return cloneChat(*c), nil
}

func (s *Store) RemoveChat(wsID, chatID string) (Chat, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	candidate := cloneState(s.data)
	ws := findWorkspace(&candidate, wsID)
	if ws == nil {
		return Chat{}, ErrNotFound
	}
	c := findChatLocked(ws, chatID)
	if c == nil {
		return Chat{}, ErrNotFound
	}
	removed := cloneChat(*c)
	for i := range ws.Chats {
		if ws.Chats[i].ID == chatID {
			ws.Chats = append(ws.Chats[:i], ws.Chats[i+1:]...)
			break
		}
	}
	if err := s.flushLocked(candidate); err != nil {
		return Chat{}, err
	}
	return removed, nil
}

func NewChatID() (string, error) { return newID("chat-") }

// NormalizeNameSource applies the legacy default without changing persisted data.
func NormalizeNameSource(source string) string {
	if source == "" {
		return "default"
	}
	return source
}

const maxChatNameAttempts = 1000

func (s *Store) DefaultChatName(_ context.Context, ws *Workspace) (string, error) {
	folder := filepath.Base(filepath.Clean(ws.Path))
	if folder == "" || folder == "." || folder == string(filepath.Separator) {
		folder = "chat"
	}
	s.mu.RLock()
	taken := make(map[string]bool)
	for _, workspace := range s.data.Workspaces {
		for _, c := range workspace.Chats {
			taken[c.Name] = true
		}
	}
	s.mu.RUnlock()
	for n := 1; n <= maxChatNameAttempts; n++ {
		candidate := fmt.Sprintf("%s-%d", folder, n)
		if !taken[candidate] {
			return candidate, nil
		}
	}
	return "", fmt.Errorf("no available chat name after %d attempts", maxChatNameAttempts)
}

func (s *Store) NewChat(wsID, name, cwd, sessionDir, provider string) (Chat, error) {
	return s.newChat(wsID, name, cwd, sessionDir, provider, "")
}

func (s *Store) NewChatWithResumeIdentity(
	wsID, name, cwd, sessionDir, provider, resumeIdentity string,
) (Chat, error) {
	return s.newChat(wsID, name, cwd, sessionDir, provider, resumeIdentity)
}

func (s *Store) newChat(wsID, name, cwd, sessionDir, provider, resumeIdentity string) (Chat, error) {
	id, err := NewChatID()
	if err != nil {
		return Chat{}, err
	}
	c := Chat{
		ID:          id,
		Name:        name,
		NameSource:  "default",
		PiSessionID: resumeIdentity,
		WsID:        wsID,
		Cwd:         cwd,
		SessionDir:  sessionDir,
		Provider:    provider,
		CreatedAt:   time.Now().UnixMilli(),
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	candidate := cloneState(s.data)
	ws := findWorkspace(&candidate, wsID)
	if ws == nil {
		return Chat{}, ErrNotFound
	}
	for _, existing := range ws.Chats {
		if existing.CreatedAt >= c.CreatedAt {
			c.CreatedAt = existing.CreatedAt + 1
		}
	}
	ws.Chats = append(ws.Chats, cloneChat(c))
	if err := s.flushLocked(candidate); err != nil {
		return Chat{}, err
	}
	return c, nil
}
