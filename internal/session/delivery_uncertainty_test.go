package session

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

type sessionTriggeredDeadline struct {
	context.Context
	done chan struct{}
	once sync.Once
}

func newSessionTriggeredDeadline() *sessionTriggeredDeadline {
	return &sessionTriggeredDeadline{Context: context.Background(), done: make(chan struct{})}
}

func (c *sessionTriggeredDeadline) Done() <-chan struct{} { return c.done }
func (c *sessionTriggeredDeadline) Err() error {
	select {
	case <-c.done:
		return context.DeadlineExceeded
	default:
		return nil
	}
}
func (c *sessionTriggeredDeadline) expire() { c.once.Do(func() { close(c.done) }) }

type closeJoinContext struct {
	context.Context
	entered chan struct{}
	done    chan struct{}
	once    sync.Once
}

func newCloseJoinContext() *closeJoinContext {
	return &closeJoinContext{Context: context.Background(), entered: make(chan struct{}), done: make(chan struct{})}
}

func (c *closeJoinContext) Done() <-chan struct{} {
	c.once.Do(func() { close(c.entered) })
	return c.done
}

type cancelRecorder struct {
	*recorder
	canceled chan struct{}
	once     sync.Once
}

func newCancelRecorder(buf int) *cancelRecorder {
	return &cancelRecorder{recorder: newRecorder(buf), canceled: make(chan struct{})}
}

func (r *cancelRecorder) Cancel() error {
	r.once.Do(func() { close(r.canceled) })
	return nil
}

func awaitWrittenUnanswered(t *testing.T, result <-chan error) {
	t.Helper()
	select {
	case err := <-result:
		if !errors.Is(err, omorpc.ErrWrittenUnanswered) || !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("deadline result = %v, want ErrWrittenUnanswered + DeadlineExceeded", err)
		}
	case <-time.After(testTimeout):
		t.Fatal("mutation did not return at its deadline")
	}
}

func TestDeliveryUncertaintyPromptLateOutcome(t *testing.T) {
	for _, tc := range []struct {
		name   string
		reject bool
	}{
		{name: "success"},
		{name: "rejection", reject: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := newDaemon(t)
			client := dial(t, d)
			mgr := testManager(t, client, newMemStore(), 64)
			sub := newRecorder(64)
			s, _, detach := acquire(t, mgr, testChat{id: "prompt-" + tc.name, cwd: t.TempDir()}, sub)
			sub.next(t)
			releasePrompt := d.BlockHandler(omorpc.CmdPrompt)
			defer releasePrompt()
			if tc.reject {
				// This case exercises generic late rejection rollback. Definitive
				// route-loss codes instead invalidate the session for recovery.
				d.FailNext(omorpc.CmdPrompt, omorpc.ErrCodeTooManySessions)
			}
			ctx := newSessionTriggeredDeadline()
			returned := make(chan error, 1)
			go func() { returned <- s.SendPrompt(ctx, "late", nil) }()
			if !d.AwaitRequestCount(omorpc.CmdPrompt, 1, testTimeout) {
				t.Fatal("prompt was not written")
			}
			ctx.expire()
			awaitWrittenUnanswered(t, returned)
			if snapshot := s.RunSnapshot(); !snapshot.Streaming {
				t.Fatal("uncertain prompt rolled back its run latch")
			}

			if tc.reject {
				// With no attachment, rejection clearing the final active latch
				// deterministically triggers idle close. The close request is the
				// completion signal; no polling is needed.
				releaseClose := d.BlockHandler(omorpc.CmdCloseSession)
				defer releaseClose()
				s.lifecycleMu.Lock()
				s.idleAfter = 0
				s.lifecycleMu.Unlock()
				detach()
				releasePrompt()
				if !d.AwaitRequestCount(omorpc.CmdCloseSession, 1, testTimeout) {
					t.Fatal("late prompt rejection did not clear the latch and schedule idle close")
				}
				s.lifecycleMu.Lock()
				active := s.promptInFlight || s.providerRunActive || s.localCommandActive
				s.lifecycleMu.Unlock()
				if active {
					t.Fatal("prompt latch remained active after late rejection")
				}
				return
			}

			injectEvent(t, s, map[string]any{"type": "command_invocation", "command": map[string]any{"source": "extension"}})
			if got := sub.drain(); counts(got)[FrameRunDone] != 0 {
				t.Fatalf("uncertain prompt completed before its response: %+v", got)
			}
			releasePrompt()
			_, done := sub.await(t, FrameRunDone)
			if done.Data.(RunInfo).Reason != "local_command" {
				t.Fatalf("late prompt success terminal = %+v", done)
			}
			if snapshot := s.RunSnapshot(); snapshot.Streaming {
				t.Fatal("prompt latch remained active after late success")
			}
		})
	}
}

func TestDeliveryUncertaintyCompactLateOutcome(t *testing.T) {
	for _, tc := range []struct {
		name   string
		reject bool
	}{
		{name: "success"},
		{name: "rejection", reject: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := newDaemon(t)
			client := dial(t, d)
			mgr := testManager(t, client, newMemStore(), 64)
			sub := newRecorder(64)
			s, _, _ := acquire(t, mgr, testChat{id: "compact-" + tc.name, cwd: t.TempDir()}, sub)
			sub.next(t)
			release := d.BlockHandler(omorpc.CmdCompact)
			defer release()
			if tc.reject {
				d.FailNext(omorpc.CmdCompact, omorpc.ErrCodeUnknownSession)
			}
			ctx := newSessionTriggeredDeadline()
			returned := make(chan error, 1)
			go func() { returned <- s.Compact(ctx) }()
			if !d.AwaitRequestCount(omorpc.CmdCompact, 1, testTimeout) {
				t.Fatal("compact was not written")
			}
			ctx.expire()
			awaitWrittenUnanswered(t, returned)
			if snapshot := s.RunSnapshot(); !snapshot.Compacting {
				t.Fatal("uncertain compact rolled back its latch")
			}
			if got := counts(sub.drain()); got[FrameCompactionDone] != 0 {
				t.Fatal("uncertain compact published a terminal frame")
			}

			release()
			_, done := sub.await(t, FrameCompactionDone)
			info := done.Data.(CompactionInfo)
			if tc.reject && info.Error == "" {
				t.Fatalf("late compact rejection published success: %+v", done)
			}
			if !tc.reject && info.Error != "" {
				t.Fatalf("late compact success published error: %+v", done)
			}
			if snapshot := s.RunSnapshot(); snapshot.Compacting {
				t.Fatal("compact latch remained active after late outcome")
			}
		})
	}
}

func TestDeliveryUncertaintyControlLateOutcome(t *testing.T) {
	for _, tc := range []struct {
		name   string
		reject bool
	}{
		{name: "success"},
		{name: "rejection", reject: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := newDaemon(t)
			client := dial(t, d)
			mgr := testManager(t, client, newMemStore(), 64)
			sub := newRecorder(64)
			s, _, _ := acquire(t, mgr, testChat{id: "control-" + tc.name, cwd: t.TempDir()}, sub)
			sub.next(t)
			release := d.BlockHandler(omorpc.CmdSetModel)
			defer release()
			if tc.reject {
				d.FailNext(omorpc.CmdSetModel, omorpc.ErrCodeUnknownSession)
			}
			ctx := newSessionTriggeredDeadline()
			returned := make(chan error, 1)
			go func() { returned <- s.SetModel(ctx, "anthropic", "late-model", "control-1") }()
			if !d.AwaitRequestCount(omorpc.CmdSetModel, 1, testTimeout) {
				t.Fatal("control was not written")
			}
			ctx.expire()
			awaitWrittenUnanswered(t, returned)
			if got := counts(sub.drain()); got[FrameControlResult] != 0 {
				t.Fatal("uncertain control published a rollback result")
			}

			release()
			_, result := sub.await(t, FrameControlResult)
			data := result.Data.(map[string]any)
			if success, _ := data["success"].(bool); success == tc.reject {
				t.Fatalf("late control result = %+v, reject=%v", result, tc.reject)
			}
		})
	}
}

func TestDeliveryUncertaintyCloseLateOutcome(t *testing.T) {
	for _, tc := range []struct {
		name   string
		reject bool
	}{
		{name: "success"},
		{name: "rejection", reject: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := newDaemon(t)
			client := dial(t, d)
			mgr := testManager(t, client, newMemStore(), 64)
			sub := newCancelRecorder(64)
			s, _, _ := acquire(t, mgr, testChat{id: "close-" + tc.name, cwd: t.TempDir()}, sub)
			sub.next(t)
			injectEvent(t, s, map[string]any{"type": "agent_start"})
			sub.await(t, FrameRunStarted)
			release := d.BlockHandler(omorpc.CmdCloseSession)
			defer release()
			if tc.reject {
				d.FailNext(omorpc.CmdCloseSession, omorpc.ErrCodeMissingSessionID)
			}
			ctx := newSessionTriggeredDeadline()
			returned := make(chan error, 1)
			go func() { returned <- mgr.StopContext(ctx, s.ChatID()) }()
			if !d.AwaitRequestCount(omorpc.CmdCloseSession, 1, testTimeout) {
				t.Fatal("close was not written")
			}
			ctx.expire()
			awaitWrittenUnanswered(t, returned)
			if _, live := mgr.Get(s.ChatID()); !live {
				t.Fatal("uncertain close removed the routing handle")
			}
			if _, err := s.QueryState(context.Background()); !errors.Is(err, ErrSessionClosed) {
				t.Fatalf("uncertain close revived route: %v", err)
			}
			injectEvent(t, s, map[string]any{"type": "agent_settled", "reason": "buffered"})
			if got := counts(sub.drain()); got[FrameRunDone] != 0 {
				t.Fatal("closing session exposed provider lifecycle before close outcome")
			}

			release()
			if tc.reject {
				_, done := sub.await(t, FrameRunDone)
				if done.Data.(RunInfo).Reason != "buffered" {
					t.Fatalf("late close rejection replay = %+v", done)
				}
				if _, live := mgr.Get(s.ChatID()); !live {
					t.Fatal("late close rejection did not revive the route")
				}
				return
			}
			select {
			case <-sub.canceled:
			case <-time.After(testTimeout):
				t.Fatal("late close success did not terminate the subscription")
			}
			if _, live := mgr.Get(s.ChatID()); live {
				t.Fatal("late close success did not remove the route")
			}
		})
	}
}

func TestDeliveryUncertaintyIdleCloseRetainsLateOutcome(t *testing.T) {
	for _, tc := range []struct {
		name   string
		reject bool
	}{
		{name: "success"},
		{name: "rejection", reject: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := newDaemon(t)
			client := dial(t, d)
			mgr := NewManager(Config{Client: client, Store: newMemStore(), QueueSize: 64, IdleAfter: time.Hour, CloseTimeout: 20 * time.Millisecond})
			t.Cleanup(func() { _ = mgr.CloseAll(context.Background()) })
			s, _, _, err := mgr.Acquire(context.Background(), testChat{id: "idle-late-" + tc.name, cwd: t.TempDir()}, nil)
			if err != nil {
				t.Fatal(err)
			}
			release := d.BlockHandler(omorpc.CmdCloseSession)
			defer release()
			if tc.reject {
				d.FailNext(omorpc.CmdCloseSession, omorpc.ErrCodeMissingSessionID)
			}
			evicted := make(chan struct{})
			go func() { mgr.evict(s); close(evicted) }()
			if !d.AwaitRequestCount(omorpc.CmdCloseSession, 1, testTimeout) {
				t.Fatal("idle close was not written")
			}
			select {
			case <-evicted:
			case <-time.After(testTimeout):
				t.Fatal("idle eviction did not return at its close budget")
			}
			if got, live := mgr.Get(s.ChatID()); !live || got != s {
				t.Fatal("unanswered idle close retired the route before its outcome")
			}
			if _, err := s.QueryState(context.Background()); !errors.Is(err, ErrSessionClosed) {
				t.Fatalf("unanswered idle close revived the route: %v", err)
			}

			joined := newCloseJoinContext()
			observed := make(chan error, 1)
			go func() { observed <- s.closeContext(joined) }()
			select {
			case <-joined.entered:
			case <-time.After(testTimeout):
				t.Fatal("explicit close did not join idle close transaction")
			}
			if got := d.RequestCount(omorpc.CmdCloseSession); got != 1 {
				t.Fatalf("joined idle close requests = %d, want 1", got)
			}
			release()
			err = <-observed
			if tc.reject {
				var stable *omorpc.StableError
				if !errors.As(err, &stable) || stable.Code != omorpc.ErrCodeMissingSessionID {
					t.Fatalf("joined rejection = %v, want %s", err, omorpc.ErrCodeMissingSessionID)
				}
				if got, live := mgr.Get(s.ChatID()); !live || got != s {
					t.Fatal("definitively rejected idle close did not retain the route")
				}
				if _, err := s.QueryState(context.Background()); err != nil {
					t.Fatalf("rejected idle close did not revive route: %v", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("joined success = %v", err)
			}
			if _, live := mgr.Get(s.ChatID()); live {
				t.Fatal("late idle close success did not retire route")
			}
		})
	}
}

func TestDeliveryUncertaintyOverlappingClosesShareTransaction(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	mgr := testManager(t, client, newMemStore(), 64)
	s, _, _ := acquire(t, mgr, testChat{id: "overlapping-close", cwd: t.TempDir()}, nil)
	release := d.BlockHandler(omorpc.CmdCloseSession)
	defer release()
	d.FailNext(omorpc.CmdCloseSession, omorpc.ErrCodeMissingSessionID)

	first := make(chan error, 1)
	go func() { first <- s.Close() }()
	if !d.AwaitRequestCount(omorpc.CmdCloseSession, 1, testTimeout) {
		t.Fatal("first close was not written")
	}
	joined := newCloseJoinContext()
	second := make(chan error, 1)
	go func() { second <- s.closeContext(joined) }()
	select {
	case <-joined.entered:
	case <-time.After(testTimeout):
		t.Fatal("second close did not join pending transaction")
	}
	if got := d.RequestCount(omorpc.CmdCloseSession); got != 1 {
		t.Fatalf("overlapping close requests = %d, want 1", got)
	}

	release()
	for i, result := range []<-chan error{first, second} {
		select {
		case err := <-result:
			var stable *omorpc.StableError
			if !errors.As(err, &stable) || stable.Code != omorpc.ErrCodeMissingSessionID {
				t.Fatalf("close %d outcome = %v, want shared %s rejection", i+1, err, omorpc.ErrCodeMissingSessionID)
			}
		case <-time.After(testTimeout):
			t.Fatalf("close %d did not settle", i+1)
		}
	}
	if got, live := mgr.Get(s.ChatID()); !live || got != s {
		t.Fatal("single rejected close outcome did not leave route live")
	}
	if _, err := s.QueryState(context.Background()); err != nil {
		t.Fatalf("rejected shared close did not revive route: %v", err)
	}
}

func TestDeliveryUncertaintyCloseEpochDeathSettlesTransaction(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	mgr := testManager(t, client, newMemStore(), 64)
	s, _, _ := acquire(t, mgr, testChat{id: "close-epoch-death", cwd: t.TempDir()}, nil)
	release := d.BlockHandler(omorpc.CmdCloseSession)
	defer release()
	closed := make(chan error, 1)
	go func() { closed <- s.Close() }()
	if !d.AwaitRequestCount(omorpc.CmdCloseSession, 1, testTimeout) {
		t.Fatal("close was not written")
	}
	d.DropConnections()
	select {
	case err := <-closed:
		if !errors.Is(err, omorpc.ErrDisconnected) {
			t.Fatalf("close epoch death = %v, want ErrDisconnected", err)
		}
	case <-time.After(testTimeout):
		t.Fatal("epoch death did not settle close transaction")
	}
	if !s.Resumable() {
		t.Fatal("close epoch death did not make session resumable")
	}
	mgr.mu.Lock()
	_, routed := mgr.byRoute[s.RoutingID()]
	mgr.mu.Unlock()
	if routed {
		t.Fatal("dead close epoch retained a live route")
	}
}

func TestDeliveryUncertaintyEpochDeathSettlesSessionLatch(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	mgr := testManager(t, client, newMemStore(), 64)
	sub := newRecorder(64)
	s, _, _ := acquire(t, mgr, testChat{id: "epoch-death", cwd: t.TempDir()}, sub)
	sub.next(t)
	release := d.BlockHandler(omorpc.CmdCompact)
	defer release()
	ctx := newSessionTriggeredDeadline()
	returned := make(chan error, 1)
	go func() { returned <- s.Compact(ctx) }()
	if !d.AwaitRequestCount(omorpc.CmdCompact, 1, testTimeout) {
		t.Fatal("compact was not written")
	}
	ctx.expire()
	awaitWrittenUnanswered(t, returned)
	d.DropConnections()
	sub.awaitError(t, "provider_disconnected")
	if !s.Resumable() {
		t.Fatal("epoch death did not invalidate the uncertain mutation")
	}
	if snapshot := s.RunSnapshot(); snapshot.Streaming || snapshot.Compacting {
		t.Fatalf("epoch death left session latches active: %+v", snapshot)
	}
}
