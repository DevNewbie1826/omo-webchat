package session

import (
	"errors"
	"sync"
	"testing"
	"time"
)

type gatedOverflowSubscriber struct {
	entered       chan struct{}
	cancelEntered chan struct{}
	allowCancel   chan struct{}
	released      chan struct{}
	recovered     chan struct{}
	once          sync.Once
}

func (s *gatedOverflowSubscriber) Deliver(Frame) {
	s.once.Do(func() { close(s.entered) })
	<-s.released
}

func (s *gatedOverflowSubscriber) Cancel() error { return s.CancelDelivery() }

func (s *gatedOverflowSubscriber) CancelDelivery() error {
	close(s.cancelEntered)
	<-s.allowCancel
	close(s.released)
	return nil
}

func (s *gatedOverflowSubscriber) RecoverSubscriberOverflow() { close(s.recovered) }

func TestOverflowDetachWaitsForDeliveryCancellation(t *testing.T) {
	sub := &gatedOverflowSubscriber{
		entered:       make(chan struct{}),
		cancelEntered: make(chan struct{}),
		allowCancel:   make(chan struct{}),
		released:      make(chan struct{}),
		recovered:     make(chan struct{}),
	}
	b := &broadcaster{}
	_, pump, detach := b.attach(sub, 1, nil)
	b.publish(Frame{Kind: FrameMessageDelta})
	select {
	case <-sub.entered:
	case <-time.After(time.Second):
		t.Fatal("delivery did not start")
	}
	b.publish(Frame{Kind: FrameMessageDelta})
	b.publish(Frame{Kind: FrameMessageDelta})
	select {
	case <-sub.cancelEntered:
	case <-time.After(time.Second):
		t.Fatal("overflow cancellation did not start")
	}

	detached := make(chan struct{})
	go func() {
		detach()
		close(detached)
	}()
	select {
	case <-detached:
		t.Fatal("detach returned before delivery cancellation completed")
	default:
	}
	close(sub.allowCancel)
	select {
	case <-detached:
	case <-time.After(time.Second):
		t.Fatal("detach did not join delivery cancellation")
	}
	select {
	case <-pump.exited:
	default:
		t.Fatal("detach returned before the overflowed pump exited")
	}
	select {
	case <-sub.recovered:
	case <-time.After(time.Second):
		t.Fatal("overflow recovery notification did not finish")
	}
}

type boundedTransferSubscriber struct {
	recovered chan struct{}
}

func (*boundedTransferSubscriber) Deliver(Frame)                         {}
func (*boundedTransferSubscriber) Cancel() error                         { return nil }
func (*boundedTransferSubscriber) CancelDelivery() error                 { return nil }
func (s *boundedTransferSubscriber) RecoverSubscriberOverflow()          { close(s.recovered) }
func (*boundedTransferSubscriber) SubscriberOverflowTransferKey() string { return "bounded-transfer" }

func TestOverflowTransferRejectsBacklogBeyondBound(t *testing.T) {
	sub := &boundedTransferSubscriber{recovered: make(chan struct{})}
	b := &broadcaster{}
	_, pump, detach := b.attach(sub, 1, nil)
	pump.beginReplay()
	for i := range SubscriberOverflowTransferCapacity + 1 {
		b.publish(Frame{Kind: FrameNotice, Data: map[string]any{"seq": i}})
	}
	select {
	case <-sub.recovered:
	case <-time.After(time.Second):
		t.Fatal("overflow recovery notification did not finish")
	}
	detach()

	_, replacement, replacementDetach := b.attach(sub, 1, nil)
	defer replacementDetach()
	if !errors.Is(replacement.stopReason, ErrSubscriberOverflow) {
		t.Fatalf("replacement stop reason = %v, want %v", replacement.stopReason, ErrSubscriberOverflow)
	}
	if got := b.count(); got != 0 {
		t.Fatalf("overflowed transfer left %d active subscriptions", got)
	}
}
