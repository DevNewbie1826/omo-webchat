// Package sendqueue persists the browser-owned pending messages for chats.
package sendqueue

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

var ErrItemNotFound = errors.New("sendqueue: item not found")

type Item struct {
	ID        string              `json:"id"`
	Text      string              `json:"text"`
	HasImage  bool                `json:"hasImage"`
	CreatedAt int64               `json:"createdAt"`
	RequestID string              `json:"requestId,omitempty"`
	Images    []map[string]string `json:"images,omitempty"`
}

type Snapshot struct {
	Revision int64
	Items    []Item
}

type chatQueue struct {
	Revision int64  `json:"revision"`
	Items    []Item `json:"items"`
}

type diskState struct {
	Version int                  `json:"version"`
	Chats   map[string]chatQueue `json:"chats"`
}

type Store struct {
	mu      sync.Mutex
	path    string
	chats   map[string]chatQueue
	lastErr error
}

func Load(path string) (*Store, error) {
	s := &Store{path: path, chats: make(map[string]chatQueue)}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return s, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read send queue: %w", err)
	}
	var state diskState
	if err := json.Unmarshal(data, &state); err != nil {
		return nil, fmt.Errorf("decode send queue: %w", err)
	}
	if state.Version != 1 {
		return nil, fmt.Errorf("decode send queue: unsupported version %d", state.Version)
	}
	if state.Chats != nil {
		s.chats = state.Chats
	}
	for chatID, queue := range s.chats {
		queue.Items = cloneItems(queue.Items)
		s.chats[chatID] = queue
	}
	return s, nil
}

func (s *Store) Append(chatID string, item Item) (string, int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	queue := s.chats[chatID]
	if item.ID == "" {
		item.ID = newID()
	}
	if item.CreatedAt == 0 {
		item.CreatedAt = time.Now().UnixMilli()
	}
	item.HasImage = len(item.Images) != 0
	item.Images = cloneImages(item.Images)
	prior := queue
	queue.Revision++
	queue.Items = append(cloneItems(queue.Items), item)
	s.chats[chatID] = queue
	if err := s.persistLocked(); err != nil {
		s.chats[chatID] = prior
		s.lastErr = err
		return "", prior.Revision
	}
	s.lastErr = nil
	return item.ID, queue.Revision
}

func (s *Store) Remove(chatID, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	queue := s.chats[chatID]
	index := itemIndex(queue.Items, id)
	if index < 0 {
		return ErrItemNotFound
	}
	prior := queue
	queue.Items = append(cloneItems(queue.Items[:index]), cloneItems(queue.Items[index+1:])...)
	queue.Revision++
	s.chats[chatID] = queue
	if err := s.persistLocked(); err != nil {
		s.chats[chatID] = prior
		s.lastErr = err
		return err
	}
	s.lastErr = nil
	return nil
}

func (s *Store) Move(chatID, id string, toIndex int) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	queue := s.chats[chatID]
	from := itemIndex(queue.Items, id)
	if from < 0 {
		return ErrItemNotFound
	}
	if toIndex < 0 {
		toIndex = 0
	}
	if toIndex >= len(queue.Items) {
		toIndex = len(queue.Items) - 1
	}
	if from == toIndex {
		return nil
	}
	prior := queue
	items := cloneItems(queue.Items)
	item := items[from]
	items = append(items[:from], items[from+1:]...)
	items = append(items, Item{})
	copy(items[toIndex+1:], items[toIndex:])
	items[toIndex] = item
	queue.Items = items
	queue.Revision++
	s.chats[chatID] = queue
	if err := s.persistLocked(); err != nil {
		s.chats[chatID] = prior
		s.lastErr = err
		return err
	}
	s.lastErr = nil
	return nil
}

func (s *Store) Clear(chatID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	queue := s.chats[chatID]
	if len(queue.Items) == 0 {
		s.lastErr = nil
		return
	}
	prior := queue
	queue.Items = []Item{}
	queue.Revision++
	s.chats[chatID] = queue
	if err := s.persistLocked(); err != nil {
		s.chats[chatID] = prior
		s.lastErr = err
		return
	}
	s.lastErr = nil
}

func (s *Store) ClaimHead(chatID string) (Item, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	queue := s.chats[chatID]
	if len(queue.Items) == 0 {
		return Item{}, false
	}
	prior := queue
	item := cloneItem(queue.Items[0])
	queue.Items = cloneItems(queue.Items[1:])
	queue.Revision++
	s.chats[chatID] = queue
	if err := s.persistLocked(); err != nil {
		s.chats[chatID] = prior
		s.lastErr = err
		return Item{}, false
	}
	s.lastErr = nil
	return item, true
}

// RestoreHead puts a failed flush back before every item admitted since it was claimed.
func (s *Store) RestoreHead(chatID string, item Item) int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	queue := s.chats[chatID]
	prior := queue
	queue.Items = append([]Item{cloneItem(item)}, cloneItems(queue.Items)...)
	queue.Revision++
	s.chats[chatID] = queue
	if err := s.persistLocked(); err != nil {
		s.chats[chatID] = prior
		s.lastErr = err
		return prior.Revision
	}
	s.lastErr = nil
	return queue.Revision
}

// Bump advances the shared queue-frame revision for an engine-side change.
func (s *Store) Bump(chatID string) int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	queue := s.chats[chatID]
	prior := queue
	queue.Revision++
	s.chats[chatID] = queue
	if err := s.persistLocked(); err != nil {
		s.chats[chatID] = prior
		s.lastErr = err
		return prior.Revision
	}
	s.lastErr = nil
	return queue.Revision
}

func (s *Store) Snapshot(chatID string) Snapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	queue := s.chats[chatID]
	return Snapshot{Revision: queue.Revision, Items: cloneItems(queue.Items)}
}

func (s *Store) LastError() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.lastErr
}

func (s *Store) persistLocked() error {
	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return fmt.Errorf("create send queue directory: %w", err)
	}
	data, err := json.Marshal(diskState{Version: 1, Chats: s.chats})
	if err != nil {
		return fmt.Errorf("encode send queue: %w", err)
	}
	tmp, err := os.CreateTemp(filepath.Dir(s.path), ".queue-v1-*.tmp")
	if err != nil {
		return fmt.Errorf("create send queue temp file: %w", err)
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return fmt.Errorf("write send queue: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return fmt.Errorf("sync send queue: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close send queue: %w", err)
	}
	if err := os.Rename(tmpName, s.path); err != nil {
		return fmt.Errorf("replace send queue: %w", err)
	}
	return nil
}

func itemIndex(items []Item, id string) int {
	for i := range items {
		if items[i].ID == id {
			return i
		}
	}
	return -1
}

func cloneItems(items []Item) []Item {
	out := make([]Item, len(items))
	for i := range items {
		out[i] = cloneItem(items[i])
	}
	return out
}

func cloneItem(item Item) Item {
	item.Images = cloneImages(item.Images)
	return item
}

func cloneImages(images []map[string]string) []map[string]string {
	out := make([]map[string]string, len(images))
	for i, image := range images {
		out[i] = make(map[string]string, len(image))
		for key, value := range image {
			out[i][key] = value
		}
	}
	return out
}

func newID() string {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		panic(fmt.Sprintf("sendqueue: generate item id: %v", err))
	}
	return hex.EncodeToString(value[:])
}
