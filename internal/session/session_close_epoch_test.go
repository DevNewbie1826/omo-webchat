package session

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

// A close whose session epoch is dead must never write blindly on the
// current connection: route ids can repeat across epochs, so a blind write
// could close an unrelated session. When no other live session owns the
// route id, the close falls back to the current connection and cleans the
// daemon-side route; when another live session owns the colliding id, the
// close refuses without writing.
func TestExecuteCloseStaleEpochFallsBackOnlyWhenRouteIsUnowned(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	mgr := testManager(t, client, newMemStore(), 16)
	s, _, detach := acquire(t, mgr, testChat{id: "stale-close-epoch", cwd: t.TempDir()}, nil)
	defer detach()

	_, oldEvents := client.CurrentEpoch()
	d.DropConnections()
	select {
	case <-oldEvents:
	case <-time.After(testTimeout):
		t.Fatal("old epoch did not close")
	}
	if _, err := client.Call(context.Background(), omorpc.ListSessions{}); err != nil {
		t.Fatalf("reconnect: %v", err)
	}

	before := d.RequestCount(omorpc.CmdCloseSession)
	route := s.routingID
	// Simulate another live session owning the same route id: the stale
	// close must refuse without writing.
	mgr.mu.Lock()
	other := &Session{chatID: "colliding-owner", routingID: route}
	mgr.byRoute[route] = other
	mgr.mu.Unlock()
	err := s.Close()
	if !errors.Is(err, omorpc.ErrEpochMismatch) {
		t.Fatalf("colliding stale close = %v, want ErrEpochMismatch", err)
	}
	if got := d.RequestCount(omorpc.CmdCloseSession); got != before {
		t.Fatalf("colliding stale close wrote: close requests %d -> %d", before, got)
	}

	// Release the colliding owner: the stale close now falls back to the
	// current connection and settles the daemon-side route.
	mgr.mu.Lock()
	delete(mgr.byRoute, route)
	mgr.mu.Unlock()
	err = s.Close()
	if err != nil {
		t.Fatalf("unowned stale close = %v, want nil", err)
	}
	if got := d.RequestCount(omorpc.CmdCloseSession); got != before+1 {
		t.Fatalf("unowned stale close requests = %d, want %d", got, before+1)
	}
}
