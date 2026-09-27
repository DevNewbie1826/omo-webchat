package session

import (
	"fmt"
	"reflect"
	"sync"
	"testing"
	"time"
)

type ownedTransferSubscriber struct {
	retained       chan *SubscriberOverflowTransfer
	retainDone     chan struct{}
	cancelEntered  chan struct{}
	allowCancel    chan struct{}
	recovered      chan struct{}
	frames         chan Frame
	cancelOnce     sync.Once
	allowOnce      sync.Once
	onRetain       func(*SubscriberOverflowTransfer)
	retainAtCancel bool
	attachTransfer *SubscriberOverflowTransfer
}

func newOwnedTransferSubscriber() *ownedTransferSubscriber {
	return &ownedTransferSubscriber{
		retained:      make(chan *SubscriberOverflowTransfer, 1),
		retainDone:    make(chan struct{}),
		cancelEntered: make(chan struct{}),
		allowCancel:   make(chan struct{}),
		recovered:     make(chan struct{}),
		frames:        make(chan Frame, SubscriberOverflowTransferCapacity+8),
	}
}

func (*ownedTransferSubscriber) SynchronousAttach()                    {}
func (*ownedTransferSubscriber) SubscriberOverflowTransferKey() string { return "owned-transfer" }
func (s *ownedTransferSubscriber) SubscriberOverflowTransfer() *SubscriberOverflowTransfer {
	return s.attachTransfer
}
func (s *ownedTransferSubscriber) Deliver(f Frame)            { s.frames <- f }
func (s *ownedTransferSubscriber) Cancel() error              { return s.CancelDelivery() }
func (s *ownedTransferSubscriber) RecoverSubscriberOverflow() { close(s.recovered) }
func (s *ownedTransferSubscriber) permitCancel()              { s.allowOnce.Do(func() { close(s.allowCancel) }) }
func (s *ownedTransferSubscriber) RetainSubscriberOverflowTransfer(transfer *SubscriberOverflowTransfer) {
	if s.onRetain != nil {
		s.onRetain(transfer)
	}
	s.retained <- transfer
	close(s.retainDone)
}
func (s *ownedTransferSubscriber) CancelDelivery() error {
	s.cancelOnce.Do(func() {
		select {
		case <-s.retainDone:
			s.retainAtCancel = true
		default:
		}
		close(s.cancelEntered)
		<-s.allowCancel
	})
	return nil
}

func waitTransferSignal(t *testing.T, signal <-chan struct{}) {
	t.Helper()
	select {
	case <-signal:
	case <-time.After(5 * time.Second):
		t.Fatal("broadcaster lifecycle signal did not arrive")
	}
}

func receiveTransfer(t *testing.T, sub *ownedTransferSubscriber) *SubscriberOverflowTransfer {
	t.Helper()
	select {
	case transfer := <-sub.retained:
		return transfer
	case <-time.After(5 * time.Second):
		t.Fatal("overflow transfer was not retained")
		return nil
	}
}

func attachOwnedTransfer(t *testing.T, b *broadcaster, sub *ownedTransferSubscriber) *subscription {
	t.Helper()
	_, pump, detach, err := b.attachWithError(sub, 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		sub.permitCancel()
		done := make(chan struct{})
		go func() {
			detach()
			close(done)
		}()
		waitTransferSignal(t, done)
	})
	pump.beginReplay()
	return pump
}

func transferNotice(seq int) Frame {
	return Frame{Kind: FrameNotice, Data: map[string]any{"nid": fmt.Sprintf("notice-%d", seq), "seq": seq}}
}

func TestOverflowTransferStaleReleaseAndFinalizationPreserveReplacement(t *testing.T) {
	// Given: T1 has overflowed but its delivery cancellation has not finished.
	b := &broadcaster{}
	first := newOwnedTransferSubscriber()
	firstPump := attachOwnedTransfer(t, b, first)
	b.publish(transferNotice(1))
	b.publish(transferNotice(2))
	t1 := receiveTransfer(t, first)
	waitTransferSignal(t, first.cancelEntered)
	t1.Release()

	second := newOwnedTransferSubscriber()
	secondPump := attachOwnedTransfer(t, b, second)
	b.publish(transferNotice(3))
	b.publish(transferNotice(4))
	t2 := receiveTransfer(t, second)
	waitTransferSignal(t, second.cancelEntered)

	// When: stale cleanup for T1 runs after T2 owns the identical key.
	t1.Release()
	first.permitCancel()
	waitTransferSignal(t, firstPump.cleanupDone)

	// Then: neither stale release nor finalization can consume or finalize T2.
	b.mu.Lock()
	current := b.overflowTransfers[t2.key]
	untouched := current == t2.instance && !current.finalized
	b.mu.Unlock()
	if !untouched {
		t.Fatal("stale T1 cleanup removed or finalized T2")
	}
	second.permitCancel()
	waitTransferSignal(t, secondPump.cleanupDone)
	replacement := newOwnedTransferSubscriber()
	_, pump, detach, err := b.attachWithError(replacement, 1, nil)
	defer detach()
	if err != nil {
		t.Fatalf("T2 could not be consumed: %v", err)
	}
	waitTransferSignal(t, pump.initialDone)
	if got := len(replacement.frames); got != 2 {
		t.Fatalf("replacement delivered %d frames, want 2", got)
	}
	got := []Frame{<-replacement.frames, <-replacement.frames}
	if want := []Frame{transferNotice(3), transferNotice(4)}; !reflect.DeepEqual(got, want) {
		t.Fatalf("replacement delivered %+v, want %+v", got, want)
	}
}

func TestOverflowTransferDiscardReleasesOutsideBroadcasterLockBeforeCancellation(t *testing.T) {
	// Given: the subscriber abandons its transfer from the retain callback.
	b := &broadcaster{}
	sub := newOwnedTransferSubscriber()
	lockAvailable := make(chan bool, 1)
	sub.onRetain = func(transfer *SubscriberOverflowTransfer) {
		acquired := b.mu.TryLock()
		lockAvailable <- acquired
		if acquired {
			b.mu.Unlock()
			transfer.Release()
		}
	}
	pump := attachOwnedTransfer(t, b, sub)

	// When: actual publication overflows the replay queue.
	b.publish(transferNotice(1))
	b.publish(transferNotice(2))
	transfer := receiveTransfer(t, sub)
	waitTransferSignal(t, sub.cancelEntered)

	// Then: ownership was handed off outside the lock before cancellation,
	// and late finalization cannot recreate the discarded transfer.
	if !<-lockAvailable {
		t.Fatal("retain callback ran under the broadcaster lock")
	}
	if !sub.retainAtCancel {
		t.Fatal("cancellation preceded ownership handoff")
	}
	b.mu.Lock()
	remaining := len(b.overflowTransfers)
	b.mu.Unlock()
	if remaining != 0 {
		t.Fatalf("discard retained %d transfers", remaining)
	}
	sub.permitCancel()
	waitTransferSignal(t, pump.cleanupDone)
	transfer.Release()
	b.mu.Lock()
	remaining = len(b.overflowTransfers)
	b.mu.Unlock()
	if remaining != 0 {
		t.Fatalf("late finalization recreated %d transfers", remaining)
	}
}
