package session

// Shared RED-suite support: fake cursor store, chat ref, frame recorder,
// daemon bootstrapping. No fixed sleeps anywhere: every wait is a channel
// receive with a bounded timeout.

import (
	"context"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc/omorpctest"
)

const testTimeout = 5 * time.Second

// ---- fakes ----

type testChat struct {
	id  string
	cwd string
}

func (c testChat) ChatID() string { return c.id }
func (c testChat) CWD() string    { return c.cwd }

// memCursorStore is the in-memory CursorStore the tests assert against.
type memCursorStore struct {
	mu      sync.Mutex
	cursors map[string]Cursor
	saves   []Cursor // every SaveCursor payload, in order
}

func newMemStore() *memCursorStore {
	return &memCursorStore{cursors: map[string]Cursor{}}
}

func (s *memCursorStore) CursorForOpen(ctx context.Context, chatID string) (Cursor, error) {
	return s.CursorFor(ctx, chatID)
}

func (s *memCursorStore) CursorFor(_ context.Context, chatID string) (Cursor, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.cursors[chatID], nil
}

func (s *memCursorStore) SaveCursor(_ context.Context, chatID string, cur Cursor) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cursors == nil {
		s.cursors = map[string]Cursor{}
	}
	s.cursors[chatID] = cur
	s.saves = append(s.saves, cur)
	return nil
}

func (s *memCursorStore) UpdateIdentity(_ context.Context, chatID, sessionFile, durableID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cursors == nil {
		s.cursors = map[string]Cursor{}
	}
	cur := s.cursors[chatID]
	cur.SessionFile, cur.DurableSessionID = sessionFile, durableID
	s.cursors[chatID] = cur
	return nil
}

func (s *memCursorStore) UpdateName(_ context.Context, chatID, name, source string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cursors == nil {
		s.cursors = map[string]Cursor{}
	}
	cur := s.cursors[chatID]
	cur.Name, cur.NameSource = name, source
	cur.TitleIsPlaceholder = false
	s.cursors[chatID] = cur
	return nil
}

func (s *memCursorStore) stored(chatID string) Cursor {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.cursors[chatID]
}

func (s *memCursorStore) saveCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.saves)
}

// recorder is a Subscriber that funnels frames into a channel so tests can
// await specific frames and preserve arrival order.
type recorder struct {
	ch chan Frame
}

func newRecorder(buf int) *recorder {
	return &recorder{ch: make(chan Frame, buf)}
}

func (r *recorder) Deliver(f Frame) {
	select {
	case r.ch <- f:
	default:
		// recorder itself never blocks the manager; capacity sized by the test
	}
}
func (r *recorder) Cancel() error { return nil }

// next awaits the next frame of any kind.
func (r *recorder) next(t *testing.T) Frame {
	t.Helper()
	select {
	case f := <-r.ch:
		return f
	case <-time.After(testTimeout):
		t.Fatalf("timed out waiting for next frame")
		return Frame{}
	}
}

// await awaits the next frame of the given kind, returning the frames seen
// before it in arrival order.
func (r *recorder) await(t *testing.T, kind FrameKind) (prior []Frame, f Frame) {
	t.Helper()
	deadline := time.After(testTimeout)
	for {
		select {
		case got := <-r.ch:
			if got.Kind == kind {
				return prior, got
			}
			prior = append(prior, got)
		case <-deadline:
			t.Fatalf("timed out waiting for frame kind %q", kind)
			return nil, Frame{}
		}
	}
}

// awaitError awaits the next FrameError with the given stable code.
func (r *recorder) awaitError(t *testing.T, code string) (prior []Frame, f Frame) {
	t.Helper()
	// Generous bound: under parallel full-suite load the invalidation
	// publication can trail the epoch close by well past the tight
	// interactive testTimeout; waiting longer weakens nothing.
	deadline := time.After(30 * time.Second)
	for {
		select {
		case got := <-r.ch:
			if got.Kind == FrameError {
				info, _ := got.Data.(ErrorInfo)
				if info.Code == code {
					return prior, got
				}
			}
			prior = append(prior, got)
		case <-deadline:
			t.Fatalf("timed out waiting for error frame %q", code)
			return nil, Frame{}
		}
	}
}

func (r *recorder) drain() []Frame {
	var out []Frame
	for {
		select {
		case f := <-r.ch:
			out = append(out, f)
		default:
			return out
		}
	}
}

// ---- wiring ----

// newDaemon boots the shared mock daemon on a short temp dir.
func newDaemon(t *testing.T) *omorpctest.Daemon {
	t.Helper()
	dir, err := os.MkdirTemp("", "sess-*")
	if err != nil {
		t.Fatalf("temp dir: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	d := omorpctest.New(dir)
	if err := d.Start(); err != nil {
		t.Fatalf("daemon start: %v", err)
	}
	t.Cleanup(d.Stop)
	return d
}

// dial connects a client with fast reconnect so epoch-death tests resolve
// in milliseconds, not the production backoff schedule.
func dial(t *testing.T, d *omorpctest.Daemon) *omorpc.Client {
	t.Helper()
	c, err := omorpc.DialWithConfig(context.Background(), d.SocketPath(), omorpc.Config{
		EventBuffer:          256,
		ReconnectInitial:     time.Millisecond,
		ReconnectMax:         2 * time.Millisecond,
		ReconnectMaxAttempts: 2,
	})
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { _ = c.Close() })
	return c
}

func testManager(t *testing.T, client *omorpc.Client, store CursorStore, queueSize int) *Manager {
	t.Helper()
	m := NewManager(Config{
		Client:        client,
		Store:         store,
		QueueSize:     queueSize,
		RetryAttempts: 3,
		RetryBackoff:  5 * time.Millisecond,
	})
	t.Cleanup(func() { _ = m.CloseAll(context.Background()) })
	return m
}

// mustOK fails the test on any error (the RED signal: stub methods return
// ErrNotImplemented).
func mustOK(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatalf("unexpected error (RED: not implemented yet?): %v", err)
	}
}

// acquire opens or resumes the chat's session, failing the test on error.
func acquire(t *testing.T, m *Manager, chat testChat, sub Subscriber) (*Session, bool, func()) {
	t.Helper()
	s, started, detach, err := m.Acquire(context.Background(), chat, sub)
	if err != nil {
		t.Fatalf("Acquire: %v", err)
	}
	return s, started, detach
}

// runEvents is the canonical scripted run: start, streaming deltas, a tool
// turn, a completed message, then the ONLY terminal event.
func runEvents() []map[string]any {
	return []map[string]any{
		{"type": omorpctest.EventAgentStart},
		{"type": omorpctest.EventMessageDelta, "delta": "he"},
		{"type": omorpctest.EventMessageDelta, "delta": "llo"},
		{"type": omorpctest.EventTool, "toolCallId": "t1", "toolName": "bash", "phase": "start"},
		{"type": omorpctest.EventTool, "toolCallId": "t1", "phase": "done", "result": "ok"},
		{"type": omorpctest.EventMessage, "message": map[string]any{"role": "assistant", "content": "hello"}},
		{"type": omorpctest.EventAgentSettled, "reason": "end_turn"},
	}
}

func counts(frames []Frame) map[FrameKind]int {
	m := map[FrameKind]int{}
	for _, f := range frames {
		m[f.Kind]++
	}
	return m
}

func frameIndex(frames []Frame, kind FrameKind) int {
	for i, f := range frames {
		if f.Kind == kind {
			return i
		}
	}
	return -1
}
