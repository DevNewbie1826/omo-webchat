package session

// Lock order: Session.lifecycleMu -> Manager.mu -> broadcaster.mu.
// A path may skip locks but never acquires them in reverse. No lock is held
// across omorpc.Call, omorpc.Notify, a subscriber callback, or a channel receive.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

type Manager struct {
	cfg Config

	acquireMu sync.Mutex
	mu        sync.Mutex
	byChat    map[string]*Session
	byRoute   map[string]*Session
	done      chan struct{}
	closeOnce sync.Once
}

func NewManager(cfg Config) *Manager {
	if cfg.IdleAfter == 0 {
		cfg.IdleAfter = DefaultIdleAfter
	}
	if cfg.QueueSize == 0 {
		cfg.QueueSize = DefaultQueueSize
	}
	if cfg.RetryAttempts == 0 {
		cfg.RetryAttempts = DefaultRetryAttempt
	}
	if cfg.RetryBackoff == 0 {
		cfg.RetryBackoff = DefaultRetryBackoff
	}
	m := &Manager{cfg: cfg, byChat: make(map[string]*Session), byRoute: make(map[string]*Session), done: make(chan struct{})}
	if cfg.Client != nil {
		go m.eventLoop()
	}
	return m
}

func (m *Manager) eventLoop() {
	dead := false
	for {
		select {
		case <-m.done:
			return
		case ev, ok := <-m.cfg.Client.Events():
			if !ok {
				if !dead {
					m.invalidateEpoch()
					dead = true
				}
				// The closed channel stays closed; pause briefly before
				// re-fetching the next epoch's Events channel.
				select {
				case <-m.done:
					return
				case <-time.After(time.Millisecond):
				}
				continue
			}
			dead = false
			if ev == nil || ev.SessionID == "" {
				continue
			}
			m.mu.Lock()
			s := m.byRoute[ev.SessionID]
			m.mu.Unlock()
			if s != nil {
				s.dispatch(ev)
			}
		}
	}
}

func (m *Manager) invalidateEpoch() {
	m.mu.Lock()
	all := make([]*Session, 0, len(m.byChat))
	for _, s := range m.byChat {
		all = append(all, s)
	}
	m.byRoute = make(map[string]*Session)
	m.mu.Unlock()
	for _, s := range all {
		s.invalidate("provider_disconnected", "provider connection lost")
	}
}

func (m *Manager) Acquire(ctx context.Context, chat ChatRef, sub Subscriber) (*Session, bool, func(), error) {
	if chat == nil || chat.ChatID() == "" {
		return nil, false, nil, errors.New("session: empty chat id")
	}
	if m.cfg.Client == nil {
		return nil, false, nil, errors.New("session: nil rpc client")
	}
	m.acquireMu.Lock()
	defer m.acquireMu.Unlock()

	m.mu.Lock()
	existing := m.byChat[chat.ChatID()]
	m.mu.Unlock()
	if existing != nil && !existing.Resumable() {
		return existing, false, existing.Attach(sub), nil
	}

	cur := Cursor{}
	var err error
	if m.cfg.Store != nil {
		cur, err = m.cfg.Store.CursorFor(ctx, chat.ChatID())
		if err != nil {
			return nil, false, nil, err
		}
	}

	resumed := cur.SessionFile != ""
	data, openErr := m.open(ctx, chat.CWD(), cur.SessionFile)
	var recovery *ErrorInfo
	preserveCursor := false
	if openErr == nil && resumed && cur.DurableSessionID != "" && data.State.SessionID != cur.DurableSessionID {
		openErr = fmt.Errorf("durable session id mismatch: provider %q, stored %q", data.State.SessionID, cur.DurableSessionID)
	}
	if openErr != nil && resumed {
		info := ErrorInfo{Code: "resume_failed", Message: openErr.Error(), StoredIdentity: cur, Dangling: danglingResume(openErr)}
		recovery = &info
		data, err = m.open(ctx, chat.CWD(), "")
		if err != nil {
			return nil, false, nil, fmt.Errorf("resume failed (%v), fallback open failed: %w", openErr, err)
		}
		resumed = false
		preserveCursor = true
	} else if openErr != nil {
		return nil, false, nil, openErr
	}
	if data.SessionID == "" || data.State.SessionID == "" {
		return nil, false, nil, errors.New("session: open_session returned incomplete identity")
	}

	s := newSession(m, chat.ChatID(), chat.CWD(), data, resumed)
	detach := s.Attach(sub)
	newCur := Cursor{SessionFile: data.State.SessionFile, DurableSessionID: data.State.SessionID}
	if m.cfg.Store != nil && !preserveCursor && newCur != cur {
		if err := m.cfg.Store.SaveCursor(ctx, chat.ChatID(), newCur); err != nil {
			detach()
			_ = s.closeContext(context.Background())
			return nil, false, nil, err
		}
	}

	s.lifecycleMu.Lock()
	if recovery != nil {
		s.publishLocked(Frame{Kind: FrameError, SessionID: s.ID(), Data: *recovery})
	}
	s.publishLocked(Frame{Kind: FrameReady, SessionID: s.ID(), Resumed: resumed})
	s.lifecycleMu.Unlock()

	m.mu.Lock()
	old := m.byChat[chat.ChatID()]
	if old != nil {
		delete(m.byRoute, old.routingID)
	}
	m.byChat[chat.ChatID()] = s
	m.byRoute[data.SessionID] = s
	m.mu.Unlock()

	if resumed {
		s.loadEntries(ctx)
	}
	return s, true, detach, nil
}

func (m *Manager) open(ctx context.Context, cwd, path string) (omorpc.OpenSessionData, error) {
	cmd := omorpc.OpenSession{CWD: cwd}
	if path != "" {
		cmd = omorpc.OpenSession{SessionPath: path}
	}
	var last error
	for attempt := 0; attempt < m.cfg.RetryAttempts; attempt++ {
		resp, err := m.cfg.Client.Call(ctx, cmd)
		if err == nil {
			var out omorpc.OpenSessionData
			if err := json.Unmarshal(resp.Data, &out); err != nil {
				return out, fmt.Errorf("session: decode open_session: %w", err)
			}
			return out, nil
		}
		last = err
		var stable *omorpc.StableError
		if !errors.As(err, &stable) || stable.Code != omorpc.ErrCodeSessionPathInUse || attempt+1 >= m.cfg.RetryAttempts {
			break
		}
		t := time.NewTimer(m.cfg.RetryBackoff)
		select {
		case <-t.C:
		case <-ctx.Done():
			t.Stop()
			return omorpc.OpenSessionData{}, ctx.Err()
		}
	}
	return omorpc.OpenSessionData{}, last
}

func danglingResume(err error) bool {
	var stable *omorpc.StableError
	if !errors.As(err, &stable) {
		return false
	}
	return stable.Code == omorpc.ErrCodeInvalidPath || (stable.Code == omorpc.ErrCodeOpenFailed && strings.Contains(strings.ToLower(stable.Detail), "no such"))
}

func (m *Manager) Get(chatID string) (*Session, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.byChat[chatID]
	return s, ok
}

func (m *Manager) LiveSummaries() []Summary {
	m.mu.Lock()
	all := make([]*Session, 0, len(m.byChat))
	for _, s := range m.byChat {
		all = append(all, s)
	}
	m.mu.Unlock()
	out := make([]Summary, 0, len(all))
	for _, s := range all {
		if sum, ok := s.summary(); ok {
			out = append(out, sum)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ChatID < out[j].ChatID })
	return out
}

func (m *Manager) Stop(chatID string) error {
	return m.stopContext(context.Background(), chatID)
}

func (m *Manager) stopContext(ctx context.Context, chatID string) error {
	m.mu.Lock()
	s := m.byChat[chatID]
	if s != nil {
		delete(m.byChat, chatID)
		delete(m.byRoute, s.routingID)
	}
	m.mu.Unlock()
	if s == nil {
		return nil
	}
	return s.closeContext(ctx)
}

func (m *Manager) CloseAll(ctx context.Context) error {
	m.closeOnce.Do(func() { close(m.done) })
	m.mu.Lock()
	all := make([]*Session, 0, len(m.byChat))
	for _, s := range m.byChat {
		all = append(all, s)
	}
	m.byChat = make(map[string]*Session)
	m.byRoute = make(map[string]*Session)
	m.mu.Unlock()
	var first error
	for _, s := range all {
		if err := s.closeContext(ctx); err != nil && first == nil {
			first = err
		}
	}
	return first
}

func (m *Manager) evict(s *Session) {
	s.lifecycleMu.Lock()
	if s.closed || s.resumable || s.activeLocked() || s.broadcast.count() != 0 {
		s.lifecycleMu.Unlock()
		return
	}
	m.mu.Lock()
	if m.byChat[s.chatID] != s {
		m.mu.Unlock()
		s.lifecycleMu.Unlock()
		return
	}
	delete(m.byChat, s.chatID)
	delete(m.byRoute, s.routingID)
	s.closed = true
	s.publishLocked(Frame{Kind: FrameError, SessionID: s.durableID, Data: ErrorInfo{Code: "session_unloaded", Message: "session unloaded after idle timeout"}})
	m.mu.Unlock()
	routing := s.routingID
	s.lifecycleMu.Unlock()
	_, _ = m.cfg.Client.Call(context.Background(), omorpc.CloseSession{SessionID: routing})
}
