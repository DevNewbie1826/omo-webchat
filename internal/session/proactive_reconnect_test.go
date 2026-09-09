package session

import (
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

// awaitStreamClosed fails unless the epoch event stream closes within
// testTimeout, proving the client observed the transport loss.
func awaitStreamClosed(t *testing.T, ch <-chan *omorpc.Event) {
	t.Helper()
	deadline := time.NewTimer(testTimeout)
	defer deadline.Stop()
	for {
		select {
		case _, ok := <-ch:
			if !ok {
				return
			}
		case <-deadline.C:
			t.Fatal("timed out waiting for the epoch event stream to close")
		}
	}
}

// TestManagerProactivelyReconnectsAfterSilentTransportLoss is criterion C1:
// after the daemon drops every connection and NO further user request is
// issued, the manager learns of the epoch loss from the client and, because
// it owns a resumable-to-be session with a live subscriber, re-establishes
// the transport on its own within a bounded window.
func TestManagerProactivelyReconnectsAfterSilentTransportLoss(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	mgr := testManager(t, client, newMemStore(), 64)

	frames := newRecorder(16)
	s, _, detach := acquire(t, mgr, testChat{id: "recover-me", cwd: t.TempDir()}, frames)
	defer detach()
	if frame := frames.next(t); frame.Kind != FrameReady {
		t.Fatalf("initial frame = %+v, want ready", frame)
	}

	// The only handshake so far is the initial dial.
	baseline := d.Handshakes()
	d.DropConnections()

	// The manager must reconcile the loss: the subscriber is told and the
	// session becomes resumable. Neither step issues an RPC.
	frames.awaitError(t, "provider_disconnected")
	if !s.Resumable() {
		t.Fatal("session was not marked resumable after transport loss")
	}

	// A second handshake can only come from a proactive reconnect: no user
	// request was issued after the drop.
	if !d.AwaitRequestCount(omorpc.CmdGetProtocolInfo, baseline+1, testTimeout) {
		t.Fatalf("client did not proactively re-establish the transport within %v (handshakes=%d)",
			testTimeout, d.Handshakes())
	}
	if token, _ := client.CurrentEpoch(); token == (omorpc.EpochToken{}) {
		t.Fatal("no live connection epoch after proactive reconnection")
	}
}

// TestManagerSkipsProactiveReconnectWithoutRecoveryWork guards the trigger's
// scope: an epoch loss alone must not dial when the manager owns nothing
// worth recovering — no session at all, or an idle session with no live
// subscriber and no in-flight work. Reconnection then stays reactive, driven
// by the next request.
func TestManagerSkipsProactiveReconnectWithoutRecoveryWork(t *testing.T) {
	t.Run("no sessions", func(t *testing.T) {
		d := newDaemon(t)
		client := dial(t, d)
		_ = testManager(t, client, newMemStore(), 64)

		baseline := d.Handshakes()
		_, oldEvents := client.CurrentEpoch()
		d.DropConnections()
		awaitStreamClosed(t, oldEvents)
		if d.AwaitRequestCount(omorpc.CmdGetProtocolInfo, baseline+1, 250*time.Millisecond) {
			t.Fatalf("manager with no sessions reconnected proactively (handshakes=%d)", d.Handshakes())
		}
	})
	t.Run("idle session without bindings", func(t *testing.T) {
		d := newDaemon(t)
		client := dial(t, d)
		mgr := testManager(t, client, newMemStore(), 64)

		s, _, detach := acquire(t, mgr, testChat{id: "idle", cwd: t.TempDir()}, nil)
		defer detach()
		if s.Resumable() {
			t.Fatal("freshly acquired session reported resumable before any loss")
		}

		baseline := d.Handshakes()
		_, oldEvents := client.CurrentEpoch()
		d.DropConnections()
		awaitStreamClosed(t, oldEvents)
		if d.AwaitRequestCount(omorpc.CmdGetProtocolInfo, baseline+1, 250*time.Millisecond) {
			t.Fatalf("idle session without live bindings triggered a proactive reconnect (handshakes=%d)", d.Handshakes())
		}
	})
}
