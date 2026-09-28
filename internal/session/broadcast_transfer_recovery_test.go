package session

import (
	"errors"
	"reflect"
	"testing"
)

func TestOverflowTransferPreservesMoreThanJournalCapacityWithoutNoticeDuplicates(t *testing.T) {
	// Given: 80 notices span the overflow prefix and the cancellation suffix;
	// a fresh attach snapshot can only replay the most recent 50.
	b := &broadcaster{}
	sub := newOwnedTransferSubscriber()
	pump := attachOwnedTransfer(t, b, sub)
	want := make([]Frame, 0, 80)
	for seq := 1; seq <= 80; seq++ {
		frame := transferNotice(seq)
		want = append(want, frame)
		b.publish(frame)
	}
	transfer := receiveTransfer(t, sub)
	sub.permitCancel()
	waitTransferSignal(t, pump.cleanupDone)

	// When: a replacement consumes the transfer alongside the journal tail.
	replacement := newOwnedTransferSubscriber()
	initial := append([]Frame{{Kind: FrameReady}}, want[30:]...)
	_, nextPump, detach, err := b.attachWithError(replacement, 1, initial)
	defer detach()
	if err != nil {
		t.Fatal(err)
	}
	waitTransferSignal(t, nextPump.initialDone)

	// Then: every notice, including those outside the journal, arrives once
	// in publication order, and successfully consumed ownership is retired.
	got := make([]Frame, 0, len(replacement.frames))
	for len(replacement.frames) > 0 {
		got = append(got, <-replacement.frames)
	}
	if expected := append([]Frame{{Kind: FrameReady}}, want...); !reflect.DeepEqual(got, expected) {
		t.Fatalf("recovery frames = %+v, want %+v", got, expected)
	}
	b.mu.Lock()
	remaining := len(b.overflowTransfers)
	b.mu.Unlock()
	if remaining != 0 {
		t.Fatalf("consumed transfer left %d keys", remaining)
	}
	transfer.Release()
}

func TestOverflowTransferRejectionPreservesPoisonedAndUnfinalizedInstances(t *testing.T) {
	for _, poisoned := range []bool{false, true} {
		name := "unfinalized"
		if poisoned {
			name = "poisoned"
		}
		t.Run(name, func(t *testing.T) {
			// Given: a real overflow transfer is unfinalized or over capacity.
			b := &broadcaster{}
			sub := newOwnedTransferSubscriber()
			pump := attachOwnedTransfer(t, b, sub)
			count := 2
			if poisoned {
				count = SubscriberOverflowTransferCapacity + 1
			}
			for seq := 1; seq <= count; seq++ {
				b.publish(transferNotice(seq))
			}
			transfer := receiveTransfer(t, sub)
			if poisoned {
				sub.permitCancel()
				waitTransferSignal(t, pump.cleanupDone)
			}

			// When: hydration retries the same transfer key twice.
			for range 2 {
				replacement := newOwnedTransferSubscriber()
				_, rejected, detach, err := b.attachWithError(replacement, 1, []Frame{{Kind: FrameReady}})
				detach()
				// Then: neither rejection permits a fresh snapshot to replace
				// the retained stream or emits initial frames.
				if !errors.Is(err, ErrSubscriberOverflow) {
					t.Fatalf("retry bypassed retained transfer: %v", err)
				}
				waitTransferSignal(t, rejected.cleanupDone)
				if len(replacement.frames) != 0 {
					t.Fatal("rejected attach delivered a fresh initial snapshot")
				}
				b.mu.Lock()
				retained := b.overflowTransfers[transfer.key] == transfer.instance
				b.mu.Unlock()
				if !retained {
					t.Fatal("rejection discarded transfer ownership")
				}
			}
			sub.permitCancel()
			waitTransferSignal(t, pump.cleanupDone)
			transfer.Release()
		})
	}
}

func TestOverflowTransferConcurrentShutdownReleaseAndFinalizationJoin(t *testing.T) {
	// Given: overflow cancellation is parked, leaving finalization pending.
	b := &broadcaster{}
	sub := newOwnedTransferSubscriber()
	pump := attachOwnedTransfer(t, b, sub)
	b.publish(transferNotice(1))
	b.publish(transferNotice(2))
	transfer := receiveTransfer(t, sub)
	waitTransferSignal(t, sub.cancelEntered)
	start := make(chan struct{})
	closed := make(chan struct{})
	released := make(chan struct{})
	finalizing := make(chan struct{})
	go func() {
		<-start
		b.close(ErrSessionClosed)
		close(closed)
	}()
	go func() {
		<-start
		transfer.Release()
		transfer.Release()
		close(released)
	}()
	go func() {
		<-start
		sub.permitCancel()
		close(finalizing)
	}()

	// When: shutdown, abandonment, and delivery completion race.
	close(start)

	// Then: all workers and the delivery/cleanup pumps join without reviving
	// the transfer or retaining a subscription.
	for _, done := range []<-chan struct{}{closed, released, finalizing, pump.exited, sub.recovered, pump.cleanupDone} {
		waitTransferSignal(t, done)
	}
	b.mu.Lock()
	transfers, subscribers := len(b.overflowTransfers), len(b.subs)
	b.mu.Unlock()
	if transfers != 0 || subscribers != 0 {
		t.Fatalf("shutdown retained %d transfers and %d subscriptions", transfers, subscribers)
	}
}

func TestOverflowTransferCannotBecomeFreshHydrationOnAnotherSession(t *testing.T) {
	// Given an unconsumed transfer from a real overflow on the old session.
	b := &broadcaster{}
	sub := newOwnedTransferSubscriber()
	pump := attachOwnedTransfer(t, b, sub)
	b.publish(transferNotice(1))
	b.publish(transferNotice(2))
	transfer := receiveTransfer(t, sub)
	sub.permitCancel()
	waitTransferSignal(t, pump.cleanupDone)

	// When the route is replaced, or its old map is cleared during retirement,
	// neither situation may silently replace the undelivered stream.
	b.retireAll(ErrSessionResumable)
	for _, target := range []*broadcaster{b, {}} {
		replacement := newOwnedTransferSubscriber()
		replacement.attachTransfer = transfer
		_, rejected, detach, err := target.attachWithError(replacement, 1, []Frame{{Kind: FrameReady}})
		detach()
		if !errors.Is(err, ErrSubscriberOverflow) {
			t.Fatalf("unconsumed transfer became a fresh hydrate: %v", err)
		}
		waitTransferSignal(t, rejected.cleanupDone)
		if len(replacement.frames) != 0 {
			t.Fatal("fresh snapshot reported recovery over a lost transfer")
		}
	}
	transfer.Release()
}
