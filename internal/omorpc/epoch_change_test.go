package omorpc

import (
	"context"
	"testing"
	"time"
)

// TestClientEpochChangeNotifications pins the epoch-transition contract:
// establishment fires on dial, loss fires when the transport dies (reported
// after the epoch's stream and pending requests have settled), and
// EnsureConnected re-establishes the transport without any request, firing
// establishment for the successor epoch. The observer can also be installed
// after dial, which is how an orchestration layer subscribes.
func TestClientEpochChangeNotifications(t *testing.T) {
	d := newMockDaemon(t)
	type transition struct{ prev, next EpochToken }
	changes := make(chan transition, 8)
	cfg := Config{
		EventBuffer:          16,
		ReconnectInitial:     time.Millisecond,
		ReconnectMax:         2 * time.Millisecond,
		ReconnectMaxAttempts: 2,
		OnEpochChange: func(prev, next EpochToken) {
			changes <- transition{prev, next}
		},
	}
	c := dialForTest(t, d, cfg)

	select {
	case got := <-changes:
		if got.prev != (EpochToken{}) {
			t.Fatalf("dial establishment reported prev=%v, want the zero token", got.prev)
		}
		if got.next == (EpochToken{}) {
			t.Fatal("dial establishment reported the zero token as next")
		}
		if !c.EpochCurrent(got.next) {
			t.Fatal("established token is not the current epoch")
		}
	case <-time.After(testAwaitTimeout):
		t.Fatal("no establishment notification during dial")
	}

	// An orchestration layer subscribes after dial by replacing the observer.
	c.SetEpochChangeObserver(func(prev, next EpochToken) {
		changes <- transition{prev, next}
	})

	first, _ := c.CurrentEpoch()
	events := c.EventsInEpoch(first)
	d.DropConnections()
	var lost transition
	select {
	case lost = <-changes:
	case <-time.After(testAwaitTimeout):
		t.Fatal("no loss notification after transport death")
	}
	if lost.prev != first {
		t.Fatalf("loss reported prev=%v, want the dead epoch %v", lost.prev, first)
	}
	if lost.next != (EpochToken{}) {
		t.Fatalf("loss reported next=%v, want the zero token", lost.next)
	}
	awaitChannelClosed(t, events, testAwaitTimeout)

	// Proactive re-establishment: no request is issued anywhere in this
	// section, so the handshake below can only come from EnsureConnected.
	if err := c.EnsureConnected(context.Background()); err != nil {
		t.Fatalf("EnsureConnected: %v", err)
	}
	select {
	case got := <-changes:
		if got.prev != (EpochToken{}) || got.next == (EpochToken{}) || got.next == first {
			t.Fatalf("re-establishment reported %+v, want a fresh successor epoch", got)
		}
		if !c.EpochCurrent(got.next) {
			t.Fatal("re-established token is not the current epoch")
		}
	case <-time.After(testAwaitTimeout):
		t.Fatal("no establishment notification after EnsureConnected")
	}
}
