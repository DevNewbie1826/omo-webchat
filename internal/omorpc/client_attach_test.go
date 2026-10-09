package omorpc

import (
	"context"
	"errors"
	"testing"
)

// TestClientSocketPath reports the path DialWithConfig was given.
func TestClientSocketPath(t *testing.T) {
	d := newMockDaemon(t)
	c := dialForTest(t, d, Config{})
	if got, want := c.SocketPath(), d.SocketPath(); got != want {
		t.Fatalf("SocketPath() = %q, want %q", got, want)
	}
}

// TestClientNoReconnect pins the opt-in that a lost transport retires the
// epoch and never re-dials, while the zero Config keeps today's reconnect.
func TestClientNoReconnect(t *testing.T) {
	t.Run("drops_epoch_without_redial", func(t *testing.T) {
		d := newMockDaemon(t)
		c := dialForTest(t, d, Config{NoReconnect: true})
		token, events := c.CurrentEpoch()
		if !c.EpochCurrent(token) {
			t.Fatal("epoch not current after dial")
		}
		base := d.Connections()
		if base < 1 {
			t.Fatalf("connections after dial = %d, want at least 1", base)
		}
		d.DropConnections()
		awaitChannelClosed(t, events, testAwaitTimeout)
		if c.EpochCurrent(token) {
			t.Fatal("EpochCurrent still true after transport loss")
		}
		_, err := c.Call(context.Background(), ListSessions{})
		if !errors.Is(err, ErrDisconnected) {
			t.Fatalf("call after drop: err=%v, want ErrDisconnected", err)
		}
		if got := d.Connections(); got != base {
			t.Fatalf("connections = %d, want %d (NoReconnect must not dial)", got, base)
		}
		// A second call stays failed and still does not dial. A background
		// retry would show up as another accept.
		_, err = c.Call(context.Background(), ListSessions{})
		if !errors.Is(err, ErrDisconnected) {
			t.Fatalf("second call after drop: err=%v, want ErrDisconnected", err)
		}
		if got := d.Connections(); got != base {
			t.Fatalf("connections after second call = %d, want %d", got, base)
		}
	})

	t.Run("default_client_still_reconnects", func(t *testing.T) {
		d := newMockDaemon(t)
		// Zero Config is the production default (250ms/5s/8). The first
		// reconnect attempt is immediate, so this does not wait out backoff.
		c := dialForTest(t, d, Config{})
		token, events := c.CurrentEpoch()
		base := d.Connections()
		d.DropConnections()
		awaitChannelClosed(t, events, testAwaitTimeout)
		if c.EpochCurrent(token) {
			t.Fatal("default client left the dead epoch current")
		}
		ctx, cancel := context.WithTimeout(context.Background(), testAwaitTimeout)
		defer cancel()
		resp, err := c.Call(ctx, ListSessions{})
		if err != nil {
			t.Fatalf("default client call after drop: %v, want a reconnected success", err)
		}
		if resp == nil || !resp.Success || resp.Command != CmdListSessions {
			t.Fatalf("default client response = %+v", resp)
		}
		if got := d.Connections(); got <= base {
			t.Fatalf("connections = %d, want > %d after default reconnect", got, base)
		}
		if c.EpochCurrent(token) {
			t.Fatal("reconnected client still reports the dead epoch")
		}
		next, _ := c.CurrentEpoch()
		if !c.EpochCurrent(next) || next == token {
			t.Fatal("default reconnect did not publish a new current epoch")
		}
	})
}
