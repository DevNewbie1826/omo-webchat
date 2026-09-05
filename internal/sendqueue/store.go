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
	ID         string              `json:"id"`
	Text       string              `json:"text"`
	HasImage   bool                `json:"hasImage"`
	CreatedAt  int64               `json:"createdAt"`
	RequestID  string              `json:"requestId,omitempty"`
	DeliveryID string              `json:"deliveryId,omitempty"`
	Images     []map[string]string `json:"images,omitempty"`
}

type Snapshot struct {
	Revision    int64
	Items       []Item
	Dispatching *Item
}

type chatQueue struct {
	Revision    int64  `json:"revision"`
	Items       []Item `json:"items"`
	Dispatching *Item  `json:"dispatching,omitempty"`
}

type diskState struct {
	Version int                  `json:"version"`
	Chats   map[string]chatQueue `json:"chats"`
}

type Store struct {
	mu          sync.Mutex
	path        string
	chats       map[string]chatQueue
	persistHook func(stage string) error
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
		queue.Dispatching = cloneItemPtr(queue.Dispatching)
		s.chats[chatID] = queue
	}
	return s, nil
}

func (s *Store) Append(chatID string, item Item) (string, int64, error) {
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
		return "", prior.Revision, fmt.Errorf("append send queue: %w", err)
	}
	return item.ID, queue.Revision, nil
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
		return fmt.Errorf("remove from send queue: %w", err)
	}
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
		return fmt.Errorf("move send queue item: %w", err)
	}
	return nil
}

func (s *Store) Clear(chatID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	queue := s.chats[chatID]
	if len(queue.Items) == 0 && queue.Dispatching == nil {
		return nil
	}
	prior := queue
	queue.Items = []Item{}
	queue.Dispatching = nil
	queue.Revision++
	s.chats[chatID] = queue
	if err := s.persistLocked(); err != nil {
		s.chats[chatID] = prior
		return fmt.Errorf("clear send queue: %w", err)
	}
	return nil
}

// BeginDispatch durably reserves the queue head for delivery. A dispatch left
// behind by a process exit is returned unchanged, including its stable delivery
// identity, so restart recovery retries exactly that item before later entries.
func (s *Store) BeginDispatch(chatID string) (Item, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	queue := s.chats[chatID]
	if queue.Dispatching != nil {
		return cloneItem(*queue.Dispatching), true, nil
	}
	if len(queue.Items) == 0 {
		return Item{}, false, nil
	}
	prior := queue
	item := cloneItem(queue.Items[0])
	if item.DeliveryID == "" {
		item.DeliveryID = newID()
	}
	queue.Items = cloneItems(queue.Items[1:])
	queue.Dispatching = cloneItemPtr(&item)
	queue.Revision++
	s.chats[chatID] = queue
	if err := s.persistLocked(); err != nil {
		s.chats[chatID] = prior
		return Item{}, false, fmt.Errorf("begin send queue dispatch: %w", err)
	}
	return item, true, nil
}

// CompleteDispatch removes a dispatch only after the provider accepted it.
func (s *Store) CompleteDispatch(chatID, deliveryID string) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	queue := s.chats[chatID]
	if queue.Dispatching == nil || queue.Dispatching.DeliveryID != deliveryID {
		return queue.Revision, ErrItemNotFound
	}
	prior := queue
	queue.Dispatching = nil
	queue.Revision++
	s.chats[chatID] = queue
	if err := s.persistLocked(); err != nil {
		s.chats[chatID] = prior
		return prior.Revision, fmt.Errorf("complete send queue dispatch: %w", err)
	}
	return queue.Revision, nil
}

// RestoreDispatch puts a definitely-unsent dispatch back before every item
// admitted since it was reserved.
func (s *Store) RestoreDispatch(chatID, deliveryID string) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	queue := s.chats[chatID]
	if queue.Dispatching == nil || queue.Dispatching.DeliveryID != deliveryID {
		return queue.Revision, ErrItemNotFound
	}
	prior := queue
	item := cloneItem(*queue.Dispatching)
	queue.Dispatching = nil
	queue.Items = append([]Item{item}, cloneItems(queue.Items)...)
	queue.Revision++
	s.chats[chatID] = queue
	if err := s.persistLocked(); err != nil {
		s.chats[chatID] = prior
		return prior.Revision, fmt.Errorf("restore send queue dispatch: %w", err)
	}
	return queue.Revision, nil
}

// ClaimHead and RestoreHead remain for callers that need a destructive queue
// pop. Delivery code must use the dispatch transition above.
func (s *Store) ClaimHead(chatID string) (Item, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	queue := s.chats[chatID]
	if len(queue.Items) == 0 {
		return Item{}, false, nil
	}
	prior := queue
	item := cloneItem(queue.Items[0])
	queue.Items = cloneItems(queue.Items[1:])
	queue.Revision++
	s.chats[chatID] = queue
	if err := s.persistLocked(); err != nil {
		s.chats[chatID] = prior
		return Item{}, false, fmt.Errorf("claim send queue head: %w", err)
	}
	return item, true, nil
}

func (s *Store) RestoreHead(chatID string, item Item) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	queue := s.chats[chatID]
	prior := queue
	queue.Items = append([]Item{cloneItem(item)}, cloneItems(queue.Items)...)
	queue.Revision++
	s.chats[chatID] = queue
	if err := s.persistLocked(); err != nil {
		s.chats[chatID] = prior
		return prior.Revision, fmt.Errorf("restore send queue head: %w", err)
	}
	return queue.Revision, nil
}

// Delete removes all state owned by one chat.
func (s *Store) Delete(chatID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	prior, ok := s.chats[chatID]
	if !ok {
		return nil
	}
	delete(s.chats, chatID)
	if err := s.persistLocked(); err != nil {
		s.chats[chatID] = prior
		return fmt.Errorf("delete send queue: %w", err)
	}
	return nil
}

// Bump advances the shared queue-frame revision for an engine-side change.
func (s *Store) Bump(chatID string) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	queue := s.chats[chatID]
	prior := queue
	queue.Revision++
	s.chats[chatID] = queue
	if err := s.persistLocked(); err != nil {
		s.chats[chatID] = prior
		return prior.Revision, fmt.Errorf("bump send queue revision: %w", err)
	}
	return queue.Revision, nil
}

func (s *Store) Snapshot(chatID string) Snapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	queue := s.chats[chatID]
	return Snapshot{Revision: queue.Revision, Items: cloneItems(queue.Items), Dispatching: cloneItemPtr(queue.Dispatching)}
}

func (s *Store) HasBacklog(chatID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	queue := s.chats[chatID]
	return queue.Dispatching != nil || len(queue.Items) != 0
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
	closeTempOnFailure := func(op string, opErr error) error {
		if closeErr := tmp.Close(); closeErr != nil {
			opErr = errors.Join(opErr, fmt.Errorf("close send queue temp file: %w", closeErr))
		}
		return fmt.Errorf("%s send queue: %w", op, opErr)
	}
	if err := tmp.Chmod(0o600); err != nil {
		return closeTempOnFailure("chmod", err)
	}
	if err := s.runPersistHook("write"); err != nil {
		return closeTempOnFailure("write", err)
	}
	if _, err := tmp.Write(data); err != nil {
		return closeTempOnFailure("write", err)
	}
	if err := s.runPersistHook("sync-file"); err != nil {
		return closeTempOnFailure("sync", err)
	}
	if err := tmp.Sync(); err != nil {
		return closeTempOnFailure("sync", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close send queue: %w", err)
	}
	if err := s.runPersistHook("rename"); err != nil {
		return fmt.Errorf("replace send queue: %w", err)
	}
	if err := os.Rename(tmpName, s.path); err != nil {
		return fmt.Errorf("replace send queue: %w", err)
	}
	dir, err := os.Open(filepath.Dir(s.path))
	if err != nil {
		return fmt.Errorf("open send queue directory: %w", err)
	}
	closeDirOnFailure := func(opErr error) error {
		if closeErr := dir.Close(); closeErr != nil {
			opErr = errors.Join(opErr, fmt.Errorf("close send queue directory: %w", closeErr))
		}
		return fmt.Errorf("sync send queue directory: %w", opErr)
	}
	if err := s.runPersistHook("sync-dir"); err != nil {
		return closeDirOnFailure(err)
	}
	if err := dir.Sync(); err != nil {
		return closeDirOnFailure(err)
	}
	if err := dir.Close(); err != nil {
		return fmt.Errorf("close send queue directory: %w", err)
	}
	return nil
}

func (s *Store) runPersistHook(stage string) error {
	if s.persistHook == nil {
		return nil
	}
	return s.persistHook(stage)
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

func cloneItemPtr(item *Item) *Item {
	if item == nil {
		return nil
	}
	cloned := cloneItem(*item)
	return &cloned
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
