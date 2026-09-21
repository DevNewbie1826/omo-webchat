package session

import (
	"context"
	"errors"
	"reflect"
	"sync"
	"testing"
	"time"
)

type replayDrainOverflowSubscriber struct {
	entered   chan struct{}
	release   chan struct{}
	recovered chan struct{}
	once      sync.Once
	mu        sync.Mutex
	seen      []int
}

func (*replayDrainOverflowSubscriber) SynchronousAttach() {}
func (*replayDrainOverflowSubscriber) SubscriberOverflowTransferKey() string {
	return "replay-drain"
}
func (s *replayDrainOverflowSubscriber) Deliver(f Frame) {
	if f.Kind != FrameNotice {
		return
	}
	seq := f.Data.(map[string]any)["seq"].(int)
	if seq == 1 {
		close(s.entered)
		<-s.release
	}
	s.mu.Lock()
	s.seen = append(s.seen, seq)
	s.mu.Unlock()
}
func (s *replayDrainOverflowSubscriber) CancelDelivery() error {
	s.once.Do(func() { close(s.release) })
	return nil
}
func (s *replayDrainOverflowSubscriber) Cancel() error { return s.CancelDelivery() }
func (s *replayDrainOverflowSubscriber) RecoverSubscriberOverflow() {
	close(s.recovered)
}

func TestOverflowDuringReplayDrainPreservesTail(t *testing.T) {
	// Given: terminal replay has moved two pending live frames into its local
	// drain, and the first frame is held in delivery.
	sub := &replayDrainOverflowSubscriber{
		entered:   make(chan struct{}),
		release:   make(chan struct{}),
		recovered: make(chan struct{}),
	}
	b := &broadcaster{}
	_, pump, detach := b.attach(sub, 2, nil)
	defer detach()
	pump.beginReplay()
	for seq := 1; seq <= 2; seq++ {
		b.publish(Frame{Kind: FrameNotice, Data: map[string]any{"seq": seq}})
	}
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	replayDone := make(chan error, 1)
	go func() { replayDone <- pump.enqueueReplayBarrier(ctx) }()
	select {
	case <-sub.entered:
	case <-ctx.Done():
		t.Fatal("replay drain never entered first live delivery")
	}

	// When: a second burst overflows the pending queue during that drain.
	for seq := 3; seq <= 5; seq++ {
		b.publish(Frame{Kind: FrameNotice, Data: map[string]any{"seq": seq}})
	}
	select {
	case <-sub.recovered:
	case <-ctx.Done():
		t.Fatal("overflow cleanup did not finish")
	}
	detach()
	select {
	case <-replayDone:
	case <-ctx.Done():
		t.Fatal("old replay did not terminate")
	}
	_, _, replacementDetach, err := b.attachWithError(sub, 2, nil)
	if err != nil {
		t.Fatalf("replacement failed instead of recovering: %v", err)
	}
	defer replacementDetach()

	// Then: a successful replacement includes the undelivered local tail.
	sub.mu.Lock()
	seen := append([]int(nil), sub.seen...)
	sub.mu.Unlock()
	if want := []int{1, 2, 3, 4, 5}; !reflect.DeepEqual(seen, want) {
		t.Fatalf("successful recovery delivered %v, want %v (replay-local tail lost)", seen, want)
	}
}

func TestOverflowDuringReplayDrainRejectsTailBeyondTransferBound(t *testing.T) {
	// Given: replay draining and its replacement pending queue together exceed
	// the bounded overflow transfer capacity.
	const queueSize = SubscriberOverflowTransferCapacity/2 + 1
	sub := &replayDrainOverflowSubscriber{
		entered:   make(chan struct{}),
		release:   make(chan struct{}),
		recovered: make(chan struct{}),
	}
	b := &broadcaster{}
	_, pump, detach := b.attach(sub, queueSize, nil)
	defer detach()
	pump.beginReplay()
	for seq := 1; seq <= queueSize; seq++ {
		b.publish(Frame{Kind: FrameNotice, Data: map[string]any{"seq": seq}})
	}
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	replayDone := make(chan error, 1)
	go func() { replayDone <- pump.enqueueReplayBarrier(ctx) }()
	select {
	case <-sub.entered:
	case <-ctx.Done():
		t.Fatal("replay drain never entered first live delivery")
	}

	// When: enough new live frames arrive to overflow the replacement queue.
	for seq := queueSize + 1; seq <= queueSize*2+1; seq++ {
		b.publish(Frame{Kind: FrameNotice, Data: map[string]any{"seq": seq}})
	}
	select {
	case <-sub.recovered:
	case <-ctx.Done():
		t.Fatal("overflow cleanup did not finish")
	}
	detach()
	select {
	case <-replayDone:
	case <-ctx.Done():
		t.Fatal("old replay did not terminate")
	}

	// Then: replacement is rejected explicitly instead of silently truncating.
	_, _, replacementDetach, err := b.attachWithError(sub, queueSize, nil)
	defer replacementDetach()
	if !errors.Is(err, ErrSubscriberOverflow) {
		t.Fatalf("replacement error = %v, want %v", err, ErrSubscriberOverflow)
	}
}
