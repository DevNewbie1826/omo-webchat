// Package rpcwatch observes shared daemon sessions without changing their routes.
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

// Caller is implemented by the session manager's shared RPC client.
type Caller interface {
	CallInEpoch(context.Context, omorpc.Command) (*omorpc.Response, omorpc.EpochToken, error)
}

// Session is a daemon route's latest observed state.
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

// Option configures a watcher before it starts.
type Option func(*Watcher)

// WithInterval sets the polling interval. It must be positive.
func WithInterval(interval time.Duration) Option {
	return func(w *Watcher) { w.interval = interval }
}

// WithClock supplies the clock for snapshot observation timestamps.
func WithClock(now func() time.Time) Option {
	return func(w *Watcher) { w.now = now }
}

type record struct {
	session Session
	raw     string
	active  bool
}

// Watcher serializes polls while allowing concurrent snapshot readers.
type Watcher struct {
	caller   Caller
	interval time.Duration
	now      func() time.Time
	tickMu   sync.Mutex
	mu       sync.RWMutex
	seen     map[string]record
}

// New constructs a watcher polling every three seconds by default.
// A nil caller disables observations.
func New(caller Caller, opts ...Option) *Watcher {
	w := &Watcher{caller: caller, interval: 3 * time.Second, now: time.Now, seen: make(map[string]record)}
	for _, opt := range opts {
		opt(w)
	}
	return w
}

// Run polls immediately and then periodically until ctx is cancelled.
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

type state struct {
	Pending []struct {
		Questions []struct {
			Question string `json:"question"`
			Header   string `json:"header"`
		} `json:"questions"`
	} `json:"pendingQuestions"`
	Streaming  bool   `json:"isStreaming"`
	Compacting bool   `json:"isCompacting"`
	Count      int    `json:"messageCount"`
	DurableID  string `json:"sessionId"`
	Path       string `json:"sessionFile"`
	Name       string `json:"sessionName"`
}

// Tick refreshes the snapshot; a list failure leaves it unchanged.
// Routes absent from the list or returning unknown_session are removed.
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
	now := w.now().UnixMilli()
	for _, entry := range list.Sessions {
		if ctx.Err() != nil {
			return
		}
		info := entry.Session
		id := info.SessionID
		old, observed := prev[id]
		var s state
		if err := w.call(ctx, omorpc.GetState{SessionID: id}, &s); err != nil {
			var stable *omorpc.StableError
			if errors.As(err, &stable) && stable.Code == omorpc.ErrCodeUnknownSession {
				continue
			}
			slog.DebugContext(ctx, "rpcwatch state failed", "session_id", id, "error", err)
			if observed {
				next[id] = old
			}
			continue
		}
		if s.Path != "" {
			info.SessionPath = s.Path
		} else if info.SessionPath == "" {
			info.SessionPath = entry.File
		}
		if s.DurableID != "" {
			info.DurableSessionID = s.DurableID
		}
		if s.Name != "" {
			info.Name = s.Name
		}
		raw := "idle"
		switch {
		case len(s.Pending) > 0:
			raw = "blocked"
		case s.Streaming || s.Compacting:
			raw = "working"
		}
		info.Status, info.MessageCount, info.UpdatedAt = raw, s.Count, now
		info.Questions = []string{}
		if raw == "blocked" {
			for _, pending := range s.Pending {
				for _, q := range pending.Questions {
					text := q.Question
					if text == "" {
						text = q.Header
					}
					runes := []rune(text)
					if len(runes) > 200 {
						text = string(runes[:200])
					}
					info.Questions = append(info.Questions, text)
				}
			}
		}
		active := old.active
		if raw == "idle" && observed {
			if active || ((old.raw == "idle" || old.raw == "blocked") && s.Count > old.session.MessageCount) {
				info.Status, active = "done", false
			} else if old.session.Status == "done" {
				info.Status = "done"
			}
		}
		if raw == "working" {
			active = true
		}
		next[id] = record{session: info, raw: raw, active: active}
	}
	if ctx.Err() != nil {
		return
	}
	w.mu.Lock()
	w.seen = next
	w.mu.Unlock()
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

// Sessions returns independent copies sorted by cwd, then daemon session ID.
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

// Lookup returns an independent copy of a currently observed session.
func (w *Watcher) Lookup(sessionId string) (Session, bool) {
	w.mu.RLock()
	defer w.mu.RUnlock()
	r, ok := w.seen[sessionId]
	s := r.session
	s.Questions = slices.Clone(s.Questions)
	return s, ok
}
