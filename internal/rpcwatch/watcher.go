// Package rpcwatch observes sessions on the shared omo daemon.
package rpcwatch

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

type Caller interface {
	CallInEpoch(context.Context, omorpc.Command) (*omorpc.Response, omorpc.EpochToken, error)
}

type Session struct {
	SessionID        string   `json:"sessionId"`
	DurableSessionID string   `json:"durableSessionId"`
	SessionPath      string   `json:"sessionPath"`
	Cwd              string   `json:"cwd"`
	Name             string   `json:"name"`
	Status           string   `json:"status"`
	Questions        []string `json:"questions"`
	MessageCount     int      `json:"messageCount"`
	UpdatedAt        int64    `json:"updatedAt"`
}

type Option func(*Watcher)

func WithInterval(interval time.Duration) Option {
	return func(w *Watcher) { w.interval = interval }
}

func WithClock(now func() time.Time) Option {
	return func(w *Watcher) { w.now = now }
}

// WithSnapshot runs after a successful poll, outside the snapshot mutex.
func WithSnapshot(fn func([]Session)) Option {
	return func(w *Watcher) { w.onSnapshot = fn }
}

type record struct {
	session Session
	raw     string
	active  bool
}

type Watcher struct {
	caller     Caller
	interval   time.Duration
	now        func() time.Time
	onSnapshot func([]Session)
	tickMu     sync.Mutex
	mu         sync.RWMutex
	seen       map[string]record
}

func New(caller Caller, opts ...Option) *Watcher {
	w := &Watcher{caller: caller, interval: 3 * time.Second, now: time.Now, seen: make(map[string]record)}
	for _, opt := range opts {
		opt(w)
	}
	return w
}

func (w *Watcher) Run(ctx context.Context) {
	w.Tick(ctx)
	ticker := time.NewTicker(w.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			w.Tick(ctx)
		}
	}
}

// Tick preserves the last snapshot on list failure, and drops absent or
// unknown routes. Transient state errors preserve only the affected row.
func (w *Watcher) Tick(ctx context.Context) {
	w.tickMu.Lock()
	defer w.tickMu.Unlock()
	if ctx.Err() != nil || w.caller == nil {
		return
	}
	var list struct {
		Sessions []struct {
			Session
			File string `json:"sessionFile"`
		} `json:"sessions"`
	}
	if err := w.call(ctx, omorpc.ListSessions{}, &list); err != nil {
		slog.DebugContext(ctx, "rpcwatch list failed", "error", err)
		return
	}
	w.mu.RLock()
	prev := w.seen
	w.mu.RUnlock()
	next := make(map[string]record, len(list.Sessions))
	for _, entry := range list.Sessions {
		if ctx.Err() != nil {
			return
		}
		info := entry.Session
		old, observed := prev[info.SessionID]
		var s omorpc.SessionState
		if err := w.call(ctx, omorpc.GetState{SessionID: info.SessionID}, &s); err != nil {
			var stable *omorpc.StableError
			if errors.As(err, &stable) && stable.Code == omorpc.ErrCodeUnknownSession {
				continue
			}
			if observed {
				next[info.SessionID] = old
			}
			continue
		}
		if s.SessionFile != "" {
			info.SessionPath = s.SessionFile
		} else if info.SessionPath == "" {
			info.SessionPath = entry.File
		}
		if s.SessionID != "" {
			info.DurableSessionID = s.SessionID
		}
		if s.SessionName != "" {
			info.Name = s.SessionName
		}
		raw := "idle"
		switch {
		case len(s.PendingQuestions) > 0:
			raw = "blocked"
		case s.IsStreaming != nil && *s.IsStreaming || s.IsCompacting != nil && *s.IsCompacting:
			raw = "working"
		}
		info.Status, info.MessageCount, info.UpdatedAt = raw, s.MessageCount, w.now().UnixMilli()
		info.Questions = []string{}
		for _, pending := range s.PendingQuestions {
			for _, q := range pending.Questions {
				text := ""
				if q.Question != nil {
					text = *q.Question
				}
				if text == "" && q.Header != nil {
					text = *q.Header
				}
				runes := []rune(text)
				if len(runes) > 200 {
					text = string(runes[:200])
				}
				info.Questions = append(info.Questions, text)
			}
		}
		active := old.active
		if raw == "idle" && observed {
			if active || ((old.raw == "idle" || old.raw == "blocked") && s.MessageCount > old.session.MessageCount) {
				info.Status, active = "done", false
			} else if old.session.Status == "done" {
				info.Status = "done"
			}
		}
		if raw == "working" {
			active = true
		}
		next[info.SessionID] = record{session: info, raw: raw, active: active}
	}
	if ctx.Err() != nil {
		return
	}
	w.mu.Lock()
	w.seen = next
	w.mu.Unlock()
	if w.onSnapshot != nil {
		w.onSnapshot(w.Sessions())
	}
}

func (w *Watcher) call(ctx context.Context, cmd omorpc.Command, target any) error {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	resp, _, err := w.caller.CallInEpoch(ctx, cmd)
	if err != nil {
		return fmt.Errorf("rpcwatch call: %w", err)
	}
	if resp == nil {
		return errors.New("rpcwatch: nil response")
	}
	if err := resp.Err(); err != nil {
		return err
	}
	if err := json.Unmarshal(resp.Data, target); err != nil {
		return fmt.Errorf("rpcwatch decode: %w", err)
	}
	return nil
}

func (w *Watcher) Sessions() []Session {
	w.mu.RLock()
	defer w.mu.RUnlock()
	out := make([]Session, 0, len(w.seen))
	for _, r := range w.seen {
		s := r.session
		s.Questions = slices.Clone(s.Questions)
		out = append(out, s)
	}
	slices.SortFunc(out, func(a, b Session) int {
		if n := strings.Compare(a.Cwd, b.Cwd); n != 0 {
			return n
		}
		return strings.Compare(a.SessionID, b.SessionID)
	})
	return out
}

func (w *Watcher) Lookup(sessionID string) (Session, bool) {
	w.mu.RLock()
	defer w.mu.RUnlock()
	r, ok := w.seen[sessionID]
	s := r.session
	s.Questions = slices.Clone(s.Questions)
	return s, ok
}
