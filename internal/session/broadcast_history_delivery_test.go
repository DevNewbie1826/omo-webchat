package session

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"sync"
	"testing"
	"time"
)

type observedHistorySubscriber struct {
	entered  chan struct{}
	release  chan struct{}
	observed chan Frame
	fail     error
	once     sync.Once
	pump     *subscription
	recorded chan bool
}

func (*observedHistorySubscriber) Deliver(Frame) { panic("DeliverFrame must take precedence") }
func (s *observedHistorySubscriber) DeliverFrame(Frame) error {
	close(s.entered)
	<-s.release
	return s.fail
}
func (s *observedHistorySubscriber) Cancel() error {
	s.once.Do(func() { close(s.release) })
	return nil
}
func (s *observedHistorySubscriber) HistoryFrameDelivered(frame Frame) {
	s.pump.replayMu.Lock()
	_, recorded := s.pump.replayedEntries["entry-1"]
	s.pump.replayMu.Unlock()
	s.recorded <- recorded
	s.observed <- frame
}

func TestHistoryDeliveryObserverFollowsSuccessfulPumpDelivery(t *testing.T) {
	for _, tc := range []struct {
		name    string
		frame   Frame
		ids     []string
		failure error
	}{
		{
			name: "page records entry identities before observer",
			frame: Frame{Kind: FrameEntries, Data: EntriesFrame{
				Entries: []json.RawMessage{json.RawMessage(`{"id":"entry-1"}`)},
			}},
			ids: []string{"entry-1"},
		},
		{name: "empty terminal is observed", frame: Frame{Kind: FrameEntries, Data: EntriesFrame{Final: true}}},
		{name: "terminal history error is observed", frame: Frame{Kind: FrameError, Data: ErrorInfo{Code: "provider_error"}}},
		{name: "non history frame is not observed", frame: Frame{Kind: FrameReady}},
		{name: "delivery error is not observed", frame: Frame{Kind: FrameEntries, Data: EntriesFrame{Final: true}}, failure: errors.New("delivery rejected")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			// Given: history delivery is held at the actual pump's subscriber.
			sub := &observedHistorySubscriber{
				entered: make(chan struct{}), release: make(chan struct{}),
				observed: make(chan Frame, 1), recorded: make(chan bool, 1), fail: tc.failure,
			}
			b := &broadcaster{}
			_, pump, detach := b.attach(sub, 1, nil)
			defer detach()
			defer sub.Cancel()
			sub.pump = pump
			pump.beginReplay()
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			defer cancel()
			done := make(chan error, 1)
			go func() { done <- pump.enqueueReplay(ctx, tc.frame, true, tc.ids) }()
			waitTransferSignal(t, sub.entered)
			if len(sub.observed) != 0 {
				t.Fatal("history observer ran before delivery finished")
			}

			// When: the delivery succeeds or reports its actual error.
			if err := sub.Cancel(); err != nil {
				t.Fatal(err)
			}
			select {
			case err := <-done:
				if tc.failure == nil && err != nil {
					t.Fatalf("replay failed: %v", err)
				}
				if tc.failure != nil && err == nil {
					t.Fatal("DeliverFrame failure was ignored")
				}
			case <-ctx.Done():
				t.Fatal("pump did not resolve replay delivery")
			}
			if tc.failure != nil {
				waitTransferSignal(t, pump.cleanupDone)
			}

			// Then: exactly successful entries frames are observed, after
			// replay IDs are recorded, including terminals with no entries.
			shouldObserve := tc.failure == nil && (tc.frame.Kind == FrameEntries || tc.frame.Kind == FrameError)
			if !shouldObserve {
				if len(sub.observed) != 0 {
					t.Fatal("observer accepted failed delivery or a non-history frame")
				}
				return
			}
			select {
			case got := <-sub.observed:
				if !reflect.DeepEqual(got, tc.frame) {
					t.Fatalf("observed %+v, want %+v", got, tc.frame)
				}
			default:
				t.Fatal("successful history delivery was not observed")
			}
			if recorded := <-sub.recorded; recorded != (len(tc.ids) > 0) {
				t.Fatalf("observer saw replay ID recorded=%v, ids=%v", recorded, tc.ids)
			}
		})
	}
}
