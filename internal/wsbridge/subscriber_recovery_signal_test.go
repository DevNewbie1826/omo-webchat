package wsbridge

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/session"
)

// A pump barrier controls delivery and callback order, not the overflow
// decision: every recovery here is produced by the real session broadcaster.
type recoverySignalSubscriber struct {
	*subscriber
	entered      chan struct{}
	delivery     chan struct{}
	finalized    chan struct{}
	notify       chan struct{}
	notified     chan struct{}
	enterOnce    sync.Once
	deliveryOnce sync.Once
	armed        atomic.Bool
}

func newRecoverySignalSubscriber(c *connection) *recoverySignalSubscriber {
	return &recoverySignalSubscriber{
		subscriber: newSubscriber(c), entered: make(chan struct{}),
		delivery: make(chan struct{}), finalized: make(chan struct{}),
		notify: make(chan struct{}), notified: make(chan struct{}),
	}
}

func (s *recoverySignalSubscriber) DeliverFrame(f session.Frame) error {
	if f.Kind == session.FrameNotice && s.armed.Load() {
		s.enterOnce.Do(func() { close(s.entered) })
		select {
		case <-s.delivery:
		case <-s.conn.ctx.Done():
			return s.conn.ctx.Err()
		}
	}
	return s.subscriber.DeliverFrame(f)
}

func (s *recoverySignalSubscriber) CancelDelivery() error {
	err := s.subscriber.CancelDelivery()
	s.deliveryOnce.Do(func() { close(s.delivery) })
	return err
}

func (s *recoverySignalSubscriber) RecoverSubscriberOverflow() {
	close(s.finalized)
	// A delayed callback can outlive replacement. Its lifetime is explicitly
	// joined in the test, including the connection-shutdown branch.
	go func() {
		defer close(s.notified)
		select {
		case <-s.notify:
			s.subscriber.RecoverSubscriberOverflow()
		case <-s.conn.ctx.Done():
			s.subscriber.RecoverSubscriberOverflow()
		}
	}()
}

func publishRecoverySignalNotices(t *testing.T, h *inPlaceBridgeHarness, observer *overflowNoticeObserver, count int) {
	t.Helper()
	for i := range count {
		h.daemon.EmitSession(h.path, map[string]any{"type": "extension_notify", "seq": i})
		for {
			select {
			case frame := <-observer.frames:
				if frame.Kind == session.FrameNotice {
					goto delivered
				}
			case <-time.After(10 * time.Second):
				t.Fatal("notice ingestion did not complete")
			}
		}
	delivered:
	}
}

func TestRecoveryWakeKeepsCurrentAcrossReversedBindings(t *testing.T) {
	for _, reverse := range []bool{false, true} {
		name := "old-first"
		if reverse {
			name = "current-first"
		}
		t.Run(name, func(t *testing.T) {
			// Given a run loop held inside a client create hook, and a real
			// retained session that is rebound while that hook is blocked.
			h := newInPlaceBridgeHarnessWithHistory(t, "signal-order", 10)
			h.bridge.cfg.todoWatch = &todoWatchOptions{
				ticks: make(chan time.Time),
				read: func(context.Context, *session.Session) (session.TodoProjection, error) {
					return session.TodoProjection{}, nil
				},
			}
			var hold atomic.Bool
			entered, release := make(chan struct{}), make(chan struct{})
			releaseOnce := sync.OnceFunc(func() { close(release) })
			defer releaseOnce()
			h.bridge.cfg.PrepareChatVersion = func(ctx context.Context, _, _ string) (uint64, error) {
				if hold.CompareAndSwap(true, false) {
					close(entered)
					select {
					case <-release:
					case <-ctx.Done():
					}
					return 0, errors.New("create hook rejected")
				}
				return 0, nil
			}
			client, frames := h.connect(t)
			attachAndAwaitHistory(t, client, frames, "signal-order")
			c := h.soleServerConnection(t)
			_, sess := c.binding()
			hold.Store(true)
			writeClient(t, client, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": "signal-order"})
			awaitRecoverySignal(t, entered)

			observer := &overflowNoticeObserver{frames: make(chan session.Frame, 1024)}
			detachObserver := sess.Attach(observer)
			defer detachObserver()
			c.stateMu.Lock()
			c.wsID, c.chatID, c.sess = "ws-1", "signal-order", sess
			generation := c.bindingGeneration
			c.stateMu.Unlock()
			binding := recoveryBinding{workspaceID: "ws-1", stale: queryBinding{chatID: "signal-order", generation: generation, session: sess}}
			old := newRecoverySignalSubscriber(c)
			oldDetach := sess.Attach(old)
			if !c.bindRecovered(t.Context(), &binding, &stagedRecovery{session: sess, sub: old.subscriber, detach: oldDetach}) {
				t.Fatal("first retained binding failed")
			}
			old.armed.Store(true)
			publishRecoverySignalNotices(t, h, observer, session.DefaultQueueSize+2)
			awaitRecoverySignal(t, old.finalized)
			current := newRecoverySignalSubscriber(c)
			currentDetach := sess.Attach(current)
			if !c.bindRecovered(t.Context(), &binding, &stagedRecovery{session: sess, sub: current.subscriber, detach: currentDetach}) {
				t.Fatal("replacement retained binding failed")
			}
			current.armed.Store(true)
			publishRecoverySignalNotices(t, h, observer, session.DefaultQueueSize+2)
			awaitRecoverySignal(t, current.finalized)

			// When both actual overflow notifications arrive before the run
			// loop can drain its capacity-one wake, either arrival order works.
			first, second := old, current
			if reverse {
				first, second = current, old
			}
			close(first.notify)
			awaitRecoverySignal(t, first.notified)
			close(second.notify)
			awaitRecoverySignal(t, second.notified)
			if c.closed.Load() {
				t.Fatal("a full recovery wake closed a healthy socket")
			}
			before := h.daemon.RequestCount(omorpc.CmdGetEntries)
			releaseOnce()
			frames.nextMatching(t, "entries", 15*time.Second, func(frame map[string]any) bool {
				return frame["final"] == true
			})
			// Fence c.run after the recovered terminal, not the heartbeat
			// fast path. Rejected unknown frames are processed serially.
			writeClient(t, client, map[string]any{"type": "recovery.test.fence"})
			frames.nextMatching(t, "error", 10*time.Second, func(frame map[string]any) bool {
				return frame["code"] == "unknown_type"
			})
			c.stateMu.Lock()
			count, bound := c.recoveryCount, c.sub
			c.stateMu.Unlock()
			if c.closed.Load() || count != 1 || bound == current.subscriber {
				t.Fatalf("recovery closed=%v count=%d replaced=%v", c.closed.Load(), count, bound != current.subscriber)
			}
			if got := h.daemon.RequestCount(omorpc.CmdGetEntries) - before; got != 1 {
				t.Fatalf("automatic hydration count=%d, want 1", got)
			}
			old.mu.Lock()
			oldTransfer := old.transfer
			old.mu.Unlock()
			if oldTransfer != nil {
				t.Fatal("discarded subscriber retained its transfer")
			}
		})
	}
}

func TestRecoveryNotificationRacingShutdownIsJoined(t *testing.T) {
	// Given a real overflow whose finalized callback has not notified yet.
	h := newInPlaceBridgeHarnessWithHistory(t, "signal-shutdown", 10)
	client, frames := h.connect(t)
	attachAndAwaitHistory(t, client, frames, "signal-shutdown")
	c := h.soleServerConnection(t)
	wsID, chatID, generation, sess := c.bindingSnapshot()
	sub := newRecoverySignalSubscriber(c)
	detach := sess.Attach(sub)
	binding := recoveryBinding{workspaceID: wsID, stale: queryBinding{chatID: chatID, generation: generation, session: sess}}
	if !c.bindRecovered(t.Context(), &binding, &stagedRecovery{session: sess, sub: sub.subscriber, detach: detach}) {
		t.Fatal("retained binding failed")
	}
	sub.armed.Store(true)
	observer := &overflowNoticeObserver{frames: make(chan session.Frame, 1024)}
	detachObserver := sess.Attach(observer)
	defer detachObserver()
	publishRecoverySignalNotices(t, h, observer, session.DefaultQueueSize+2)
	awaitRecoverySignal(t, sub.finalized)
	before := h.daemon.RequestCount(omorpc.CmdGetEntries)

	// When shutdown races the delayed enqueue, join both participants.
	shutdownDone := make(chan struct{})
	go func() {
		c.shutdown()
		close(shutdownDone)
	}()
	awaitRecoverySignal(t, sub.notified)
	awaitRecoverySignal(t, shutdownDone)
	c.recoverSubscriber()

	// Then there is no reattach and the abandoned instance is released.
	if got := h.daemon.RequestCount(omorpc.CmdGetEntries); got != before {
		t.Fatalf("hydration after shutdown: %d -> %d", before, got)
	}
	sub.mu.Lock()
	retained, abandoned := sub.transfer, sub.abandoned
	sub.mu.Unlock()
	if retained != nil || !abandoned {
		t.Fatalf("shutdown retained transfer=%v abandoned=%v", retained, abandoned)
	}
}
