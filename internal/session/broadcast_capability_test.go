package session

import (
	"context"
	"fmt"
	"reflect"
	"testing"
	"time"
)

type capabilitySubscriber struct {
	*ownedTransferSubscriber
	onDemand bool
}

func (s *capabilitySubscriber) OnDemandHistory() bool { return s.onDemand }

func withHistoryVersion(sub *ownedTransferSubscriber, version int) Subscriber {
	if version == 2 {
		return sub // The oldest subscriber does not implement the capability.
	}
	return &capabilitySubscriber{ownedTransferSubscriber: sub, onDemand: version >= 4}
}

func cleanupCapabilitySubscription(t *testing.T, sub *ownedTransferSubscriber, detach func()) {
	t.Helper()
	t.Cleanup(func() {
		sub.permitCancel()
		done := make(chan struct{})
		go func() {
			detach()
			close(done)
		}()
		waitTransferSignal(t, done)
	})
}

func collectedCapabilityFrames(sub *ownedTransferSubscriber) []Frame {
	var frames []Frame
	for len(sub.frames) > 0 {
		frames = append(frames, <-sub.frames)
	}
	return frames
}

func TestBroadcastEntryAppendedRequiresHistoryCapability(t *testing.T) {
	for _, version := range []int{2, 3, 4} {
		for _, replaying := range []bool{false, true} {
			t.Run(fmt.Sprintf("v%d/replay=%v", version, replaying), func(t *testing.T) {
				// Given a real live or replay-gated subscription.
				b := &broadcaster{}
				sub := newOwnedTransferSubscriber()
				_, pump, detach := b.attach(withHistoryVersion(sub, version), 4, nil)
				cleanupCapabilitySubscription(t, sub, detach)
				if replaying {
					pump.beginReplay()
				}
				entry := Frame{Kind: FrameEntryAppended, Data: EntryAppendedInfo{ID: "entry-1"}}
				notice := transferNotice(1)

				// When an entry identity and a normal frame are published.
				b.publish(entry)
				b.publish(notice)
				ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
				defer cancel()
				if err := pump.enqueueReplayBarrier(ctx); err != nil {
					t.Fatal(err)
				}

				// Then only opted-in subscribers receive the entry identity.
				want := []Frame{notice}
				if version == 4 {
					want = []Frame{entry, notice}
				}
				if got := collectedCapabilityFrames(sub); !reflect.DeepEqual(got, want) {
					t.Fatalf("frames=%+v, want %+v", got, want)
				}
			})
		}
	}
}

func TestBroadcastLegacyEntryAppendedDoesNotConsumeCapacity(t *testing.T) {
	for _, version := range []int{2, 3} {
		t.Run(fmt.Sprintf("v%d", version), func(t *testing.T) {
			// Given a legacy replay gate with exactly one live-frame slot.
			b := &broadcaster{}
			sub := newOwnedTransferSubscriber()
			_, pump, detach := b.attach(withHistoryVersion(sub, version), 1, nil)
			cleanupCapabilitySubscription(t, sub, detach)
			pump.beginReplay()

			// When entry identities exceed even the overflow transfer budget.
			for range SubscriberOverflowTransferCapacity + 1 {
				b.publish(Frame{Kind: FrameEntryAppended, Data: EntryAppendedInfo{ID: "entry"}})
			}

			// Then they neither detach the legacy subscriber nor occupy its
			// one slot; its next supported frame can still be delivered.
			if b.count() != 1 {
				t.Fatal("unsupported entries overflowed a legacy subscriber")
			}
			b.publish(transferNotice(1))
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			defer cancel()
			if err := pump.enqueueReplayBarrier(ctx); err != nil {
				t.Fatal(err)
			}
			if got := collectedCapabilityFrames(sub); !reflect.DeepEqual(got, []Frame{transferNotice(1)}) {
				t.Fatalf("legacy frames=%+v", got)
			}
		})
	}
}

func TestBroadcastOverflowReplayHonorsRecipientHistoryCapability(t *testing.T) {
	for _, sourceVersion := range []int{2, 3, 4} {
		for _, targetVersion := range []int{2, 3, 4} {
			t.Run(fmt.Sprintf("v%d-to-v%d", sourceVersion, targetVersion), func(t *testing.T) {
				// Given an actual overflow with entry identities both before
				// overflow and in the suffix retained during cancellation.
				b := &broadcaster{}
				source := newOwnedTransferSubscriber()
				_, pump, detach := b.attach(withHistoryVersion(source, sourceVersion), 1, nil)
				cleanupCapabilitySubscription(t, source, detach)
				pump.beginReplay()
				first := Frame{Kind: FrameEntryAppended, Data: EntryAppendedInfo{ID: "first"}}
				last := Frame{Kind: FrameEntryAppended, Data: EntryAppendedInfo{ID: "last"}}
				b.publish(first)
				b.publish(transferNotice(1))
				b.publish(transferNotice(2))
				transfer := receiveTransfer(t, source)
				b.publish(last)
				if sourceVersion != 4 {
					// Ignored identities must not poison a legacy transfer.
					for range SubscriberOverflowTransferCapacity + 1 {
						b.publish(last)
					}
				}
				source.permitCancel()
				waitTransferSignal(t, pump.cleanupDone)

				// When a replacement consumes the real retained stream.
				target := newOwnedTransferSubscriber()
				target.attachTransfer = transfer
				ready := Frame{Kind: FrameReady}
				_, replacement, stop, err := b.attachWithError(withHistoryVersion(target, targetVersion), 1, []Frame{ready})
				cleanupCapabilitySubscription(t, target, stop)
				if err != nil {
					t.Fatal(err)
				}
				waitTransferSignal(t, replacement.initialDone)

				// Then filtered replay still completes, and opted-in replay
				// preserves entry identities in their publication order.
				want := []Frame{ready, transferNotice(1), transferNotice(2)}
				if sourceVersion == 4 && targetVersion == 4 {
					want = []Frame{ready, first, transferNotice(1), transferNotice(2), last}
				}
				if got := collectedCapabilityFrames(target); !reflect.DeepEqual(got, want) {
					t.Fatalf("replayed frames=%+v, want %+v", got, want)
				}
			})
		}
	}
}
