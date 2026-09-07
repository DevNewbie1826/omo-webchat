package wsbridge

import (
	"context"
	"encoding/json"
	"sync/atomic"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/session"
	"github.com/DevNewbie1826/omo-webchat/internal/wscontract"
	"github.com/lxzan/gws"
)

type todoTestWatch struct {
	h      *inPlaceBridgeHarness
	ticks  chan time.Time
	passes chan struct{}
	sock   *gws.Conn
	frames *collector
	server *connection
}

func newTodoTestWatch(t *testing.T, chat string, read func(context.Context, *session.Session) (session.TodoProjection, error)) *todoTestWatch {
	t.Helper()
	w := &todoTestWatch{h: newInPlaceBridgeHarness(t, chat), ticks: make(chan time.Time), passes: make(chan struct{}, 32)}
	w.h.bridge.cfg.todoWatch = &todoWatchOptions{ticks: w.ticks, read: read, passDone: func() { w.passes <- struct{}{} }}
	w.sock, w.frames = w.h.connect(t)
	writeClient(t, w.sock, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": chat})
	w.frames.next(t, "ready")
	w.server = w.h.soleServerConnection(t)
	awaitTodoSignal(t, w.passes)
	w.frames.next(t, "chat.todo")
	// Finish attach-time control/history work, then consume its coalesced hint.
	awaitCommandFence(t, w.sock, w.frames)
	w.tick(t)
	w.flush(t)
	clearCollector(w.frames)
	return w
}

func awaitTodoSignal(t *testing.T, signal <-chan struct{}) {
	t.Helper()
	select {
	case <-signal:
	case <-time.After(5 * time.Second):
		t.Fatal("todo worker barrier timed out")
	}
}

func (w *todoTestWatch) tick(t *testing.T) {
	t.Helper()
	select {
	case w.ticks <- time.Now():
	case <-time.After(5 * time.Second):
		t.Fatal("todo tick was not consumed")
	}
	awaitTodoSignal(t, w.passes)
}

func (w *todoTestWatch) flush(t *testing.T) {
	t.Helper()
	// This socket write is ordered after the worker completion barrier, without
	// a session command that could reopen an evicted route.
	if err := w.server.write(wscontract.PongFrame{Type: "pong"}); err != nil {
		t.Fatal(err)
	}
	w.frames.next(t, "pong")
}

func (w *todoTestWatch) assertNoTodo(t *testing.T) {
	t.Helper()
	w.flush(t)
	w.frames.mu.Lock()
	defer w.frames.mu.Unlock()
	for _, f := range w.frames.decoded {
		if f.typ == "chat.todo" {
			t.Fatalf("unexpected todo publication: %s", f.raw)
		}
	}
}

func (w *todoTestWatch) hint(t *testing.T, frame session.Frame) {
	t.Helper()
	if err := w.server.sub.DeliverFrame(frame); err != nil {
		t.Fatal(err)
	}
}

func TestTodoWatchIdleMetadataOnlyAndActiveTicks(t *testing.T) {
	w := newTodoTestWatch(t, "todo-idle", nil)
	before := w.h.daemon.RequestCount(omorpc.CmdGetEntries)
	for range 3 {
		w.tick(t)
	}
	if got := w.h.daemon.RequestCount(omorpc.CmdGetEntries); got != before {
		t.Fatalf("idle reads=%d, want %d", got, before)
	}
	w.assertNoTodo(t)
	// Given an active resident run, unchanged file metadata must not hide a
	// custom-only mutation that is still in the resident tail.
	w.h.daemon.EmitSession(w.h.path, map[string]any{"type": "agent_start"})
	w.frames.next(t, "run.started")
	w.tick(t)
	if got := w.h.daemon.RequestCount(omorpc.CmdGetEntries); got != before+1 {
		t.Fatalf("active reads=%d, want %d", got, before+1)
	}
	w.assertNoTodo(t)
}

func TestTodoWatchSubscriberAndRefreshInvalidations(t *testing.T) {
	w := newTodoTestWatch(t, "todo-hints", nil)
	for _, tc := range []struct {
		name  string
		frame session.Frame
		dirty bool
	}{
		{"nested-eval", session.Frame{Kind: session.FrameTool, Data: map[string]any{"phase": "end", "toolName": "eval"}}, true},
		{"other-tool", session.Frame{Kind: session.FrameTool, Data: map[string]any{"phase": "done", "toolName": "read"}}, true},
		{"run-terminal", session.Frame{Kind: session.FrameRunDone}, true},
		{"compaction-terminal", session.Frame{Kind: session.FrameCompactionDone}, true},
		{"history-terminal", session.Frame{Kind: session.FrameEntries, Data: session.EntriesFrame{Entries: []json.RawMessage{}, Final: true}}, true},
		{"history-page", session.Frame{Kind: session.FrameEntries, Data: session.EntriesFrame{Entries: []json.RawMessage{}}}, false},
		{"tool-update", session.Frame{Kind: session.FrameTool, Data: map[string]any{"phase": "update"}}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			before := w.h.daemon.RequestCount(omorpc.CmdGetEntries)
			w.hint(t, tc.frame)
			w.tick(t)
			want := before
			if tc.dirty {
				want++
			}
			if got := w.h.daemon.RequestCount(omorpc.CmdGetEntries); got != want {
				t.Fatalf("acquisitions=%d, want %d", got, want)
			}
		})
	}
	before := w.h.daemon.RequestCount(omorpc.CmdGetEntries)
	writeClient(t, w.sock, map[string]any{"type": "activity.refresh", "sessionId": "todo-hints"})
	awaitCommandFence(t, w.sock, w.frames)
	w.tick(t)
	if got := w.h.daemon.RequestCount(omorpc.CmdGetEntries); got != before+1 {
		t.Fatalf("refresh acquisitions=%d, want %d", got, before+1)
	}
	w.assertNoTodo(t)
}

type todoReadGate struct {
	entered   chan struct{}
	release   chan struct{}
	cancelled chan struct{}
}

func newTodoReadGate() *todoReadGate {
	return &todoReadGate{entered: make(chan struct{}), release: make(chan struct{}), cancelled: make(chan struct{})}
}

func TestTodoWatchOneInflightAndDirtyBit(t *testing.T) {
	controls := make(chan *todoReadGate, 1)
	var calls atomic.Int64
	w := newTodoTestWatch(t, "todo-coalesce", func(ctx context.Context, s *session.Session) (session.TodoProjection, error) {
		calls.Add(1)
		select {
		case gate := <-controls:
			close(gate.entered)
			select {
			case <-gate.release:
			case <-ctx.Done():
				return session.TodoProjection{}, ctx.Err()
			}
		default:
		}
		return s.ReadTodoProjection(ctx)
	})
	before := calls.Load()
	hint := session.Frame{Kind: session.FrameTool, Data: map[string]any{"phase": "end", "toolName": "eval"}}
	for range 20 {
		w.hint(t, hint)
	}
	if got := calls.Load(); got != before {
		t.Fatalf("hints bypassed refresh window: %d -> %d", before, got)
	}
	gate := newTodoReadGate()
	t.Cleanup(func() {
		select {
		case <-gate.release:
		default:
			close(gate.release)
		}
	})
	controls <- gate
	select {
	case w.ticks <- time.Now():
	case <-time.After(5 * time.Second):
		t.Fatal("tick blocked")
	}
	awaitTodoSignal(t, gate.entered)
	for range 20 {
		w.hint(t, hint)
	}
	if got := calls.Load(); got != before+1 {
		t.Fatalf("concurrent readers=%d", got-before)
	}
	close(gate.release)
	awaitTodoSignal(t, w.passes)
	w.tick(t)
	if got := calls.Load(); got != before+2 {
		t.Fatalf("dirty bit lost or multiplied: %d acquisitions", got-before)
	}
	w.tick(t)
	if got := calls.Load(); got != before+2 {
		t.Fatalf("idle tick acquired after dirty bit consumed: %d", got-before)
	}
	w.assertNoTodo(t)
}

func TestTodoWatchUnbindCancelsAcquisitionAndStopsObservation(t *testing.T) {
	controls := make(chan *todoReadGate, 1)
	var calls atomic.Int64
	budgets := make(chan time.Duration, 8)
	w := newTodoTestWatch(t, "todo-close", func(ctx context.Context, s *session.Session) (session.TodoProjection, error) {
		calls.Add(1)
		deadline, ok := ctx.Deadline()
		if !ok {
			budgets <- -1
		} else {
			budgets <- time.Until(deadline)
		}
		select {
		case gate := <-controls:
			close(gate.entered)
			<-ctx.Done()
			close(gate.cancelled)
			return session.TodoProjection{}, ctx.Err()
		default:
			return s.ReadTodoProjection(ctx)
		}
	})
	gate := newTodoReadGate()
	controls <- gate
	w.hint(t, session.Frame{Kind: session.FrameRunDone})
	select {
	case w.ticks <- time.Now():
	case <-time.After(5 * time.Second):
		t.Fatal("tick blocked")
	}
	awaitTodoSignal(t, gate.entered)
	writeClient(t, w.sock, map[string]any{"type": "chat.close", "sessionId": "todo-close"})
	awaitCommandFence(t, w.sock, w.frames)
	awaitTodoSignal(t, gate.cancelled)
	awaitTodoSignal(t, w.passes)
	count := calls.Load()
	w.tick(t)
	w.assertNoTodo(t)
	if calls.Load() != count {
		t.Fatal("unbound socket still acquired todo")
	}
	close(budgets)
	for budget := range budgets {
		if budget <= 0 || budget > todoWatchInterval {
			t.Fatalf("acquisition deadline=%v, want (0,2s]", budget)
		}
	}
	if err := w.sock.WriteClose(1000, nil); err != nil {
		t.Fatal(err)
	}
	awaitTodoSignal(t, w.server.ctx.Done())
}
