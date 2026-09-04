package session

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc/omorpctest"
)

func staleCloseFixture(t *testing.T, chatID string) (*Manager, *Session, string, func()) {
	t.Helper()
	root, err := os.MkdirTemp("", "sess-close-epoch-")
	if err != nil {
		t.Fatalf("temporary daemon directory: %v", err)
	}
	oldDaemon := omorpctest.New(root)
	if err := oldDaemon.Start(); err != nil {
		_ = os.RemoveAll(root)
		t.Fatalf("start old daemon: %v", err)
	}
	client := dial(t, oldDaemon)
	mgr := NewManager(Config{Client: client, Store: newMemStore(), QueueSize: 16})
	events := newRecorder(4)
	s, _, detach := acquire(t, mgr, testChat{id: chatID, cwd: t.TempDir()}, events)
	if frame := events.next(t); frame.Kind != FrameReady {
		t.Fatalf("initial frame = %+v, want ready", frame)
	}

	_, oldEpochEvents := client.CurrentEpoch()
	oldDaemon.Stop()
	select {
	case <-oldEpochEvents:
	case <-time.After(testTimeout):
		t.Fatal("old epoch did not close")
	}
	// Waiting for the manager's exact invalidation event also proves that
	// detachEpoch has completed, so later route assertions cannot race it.
	events.awaitError(t, "provider_disconnected")

	cleanup := func() {
		detach()
		ctx, cancel := context.WithTimeout(context.Background(), testTimeout)
		defer cancel()
		_ = mgr.CloseAll(ctx)
		oldDaemon.Stop()
		_ = os.RemoveAll(root)
	}
	return mgr, s, root, cleanup
}

// A dead-epoch fallback must refuse a route already published by another live
// chat without writing close_session on the replacement connection.
func TestExecuteCloseStaleEpochRefusesOwnedRoute(t *testing.T) {
	mgr, stale, root, cleanup := staleCloseFixture(t, "stale-owned")
	replacement := omorpctest.New(root)
	if err := replacement.Start(); err != nil {
		cleanup()
		t.Fatalf("start replacement daemon: %v", err)
	}
	defer replacement.Stop()
	defer cleanup()

	owner, _, ownerDetach := acquire(t, mgr, testChat{id: "colliding-owner", cwd: t.TempDir()}, nil)
	defer ownerDetach()
	if owner.routingID != stale.routingID {
		t.Fatalf("routing IDs did not collide: stale=%q owner=%q", stale.routingID, owner.routingID)
	}
	before := replacement.RequestCount(omorpc.CmdCloseSession)
	if err := stale.Close(); !errors.Is(err, omorpc.ErrEpochMismatch) {
		t.Fatalf("colliding stale close = %v, want ErrEpochMismatch", err)
	}
	if got := replacement.RequestCount(omorpc.CmdCloseSession); got != before {
		t.Fatalf("colliding stale close wrote: close requests %d -> %d", before, got)
	}
	if got, ok := mgr.Get(owner.chatID); !ok || got != owner {
		t.Fatal("owned route was displaced by refused stale close")
	}
}

// With no published owner, a dead-epoch close falls back exactly once on the
// replacement connection. The replacement has reset route IDs but has no live
// route, so unknown_session definitively settles the stale cleanup.
func TestExecuteCloseStaleEpochFallsBackOnceWhenUnowned(t *testing.T) {
	_, stale, root, cleanup := staleCloseFixture(t, "stale-unowned")
	replacement := omorpctest.New(root)
	if err := replacement.Start(); err != nil {
		cleanup()
		t.Fatalf("start replacement daemon: %v", err)
	}
	defer replacement.Stop()
	defer cleanup()

	before := replacement.RequestCount(omorpc.CmdCloseSession)
	if err := stale.Close(); err != nil {
		t.Fatalf("unowned stale close = %v, want nil", err)
	}
	if got := replacement.RequestCount(omorpc.CmdCloseSession); got != before+1 {
		t.Fatalf("unowned stale close requests = %d, want %d", got, before+1)
	}
}

// Regression: before the manager fence, an open completing after the stale
// ownership snapshot could publish the colliding route while close_session was
// still in flight. Holding the close handler makes that interleaving exact.
func TestFallbackCleanupRejectsCollidingOpenUntilMarkerClears(t *testing.T) {
	mgr, stale, root, cleanup := staleCloseFixture(t, "stale-in-flight")
	replacement := omorpctest.New(root)
	if err := replacement.Start(); err != nil {
		cleanup()
		t.Fatalf("start replacement daemon: %v", err)
	}
	defer replacement.Stop()
	defer cleanup()

	releaseClose := replacement.BlockHandler(omorpc.CmdCloseSession)
	defer releaseClose()
	closeResult := make(chan error, 1)
	go func() { closeResult <- stale.Close() }()
	if !replacement.AwaitRequestCount(omorpc.CmdCloseSession, 1, testTimeout) {
		t.Fatal("fallback close was not written")
	}

	chat := testChat{id: "colliding-open", cwd: t.TempDir()}
	colliding, started, detach, err := mgr.Acquire(context.Background(), chat, nil)
	if detach != nil {
		defer detach()
	}
	if !errors.Is(err, ErrSessionResumable) {
		t.Fatalf("colliding acquire = %v, want ErrSessionResumable", err)
	}
	if colliding == nil || !started || !colliding.Resumable() {
		t.Fatalf("colliding acquire = (%v, started=%v), want invalidated opened session", colliding, started)
	}
	if colliding.routingID != stale.routingID {
		t.Fatalf("routing IDs did not collide: stale=%q open=%q", stale.routingID, colliding.routingID)
	}
	mgr.mu.Lock()
	published := mgr.byRoute[stale.routingID]
	_, marked := mgr.routeCleanup[stale.routingID]
	mgr.mu.Unlock()
	if published != nil {
		t.Fatalf("colliding route published during fallback cleanup: %p", published)
	}
	if !marked {
		t.Fatal("fallback cleanup marker cleared before close settled")
	}

	releaseClose()
	select {
	case err := <-closeResult:
		if err != nil {
			t.Fatalf("fallback close: %v", err)
		}
	case <-time.After(testTimeout):
		t.Fatal("fallback close did not settle")
	}
	mgr.mu.Lock()
	_, marked = mgr.routeCleanup[stale.routingID]
	mgr.mu.Unlock()
	if marked {
		t.Fatal("fallback cleanup marker remained after close settled")
	}

	retry, _, retryDetach := acquire(t, mgr, chat, nil)
	defer retryDetach()
	if retry.routingID == stale.routingID {
		t.Fatalf("retry reused cleaned route %q", retry.routingID)
	}
	mgr.mu.Lock()
	routed := mgr.byRoute[retry.routingID]
	mgr.mu.Unlock()
	if routed != retry {
		t.Fatal("retry route was not published after cleanup marker cleared")
	}
}
