package session

import (
	"context"
	"encoding/json"
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

// A replacement for the same chat is still a distinct route holder. The stale
// session must not close it merely because both holders have the same chat ID.
func TestExecuteCloseStaleEpochRefusesSameChatReplacement(t *testing.T) {
	mgr, stale, root, cleanup := staleCloseFixture(t, "same-chat")
	replacementDaemon := omorpctest.New(root)
	if err := replacementDaemon.Start(); err != nil {
		cleanup()
		t.Fatalf("start replacement daemon: %v", err)
	}
	defer replacementDaemon.Stop()
	defer cleanup()

	resp, epoch, err := mgr.cfg.Client.CallInEpoch(context.Background(), omorpc.OpenSession{CWD: t.TempDir()})
	if err != nil {
		t.Fatalf("open same-chat replacement: %v", err)
	}
	var opened omorpc.OpenSessionData
	if err := json.Unmarshal(resp.Data, &opened); err != nil {
		t.Fatalf("decode same-chat replacement: %v", err)
	}
	replacement := newSession(mgr, stale.chatID, t.TempDir(), opened, false, epoch)
	if replacement.routingID != stale.routingID {
		t.Fatalf("routing IDs did not collide: stale=%q replacement=%q", stale.routingID, replacement.routingID)
	}
	mgr.mu.Lock()
	mgr.byChat[stale.chatID] = replacement
	mgr.byRoute[replacement.routingID] = replacement
	mgr.mu.Unlock()
	before := replacementDaemon.RequestCount(omorpc.CmdCloseSession)
	if err := stale.Close(); !errors.Is(err, omorpc.ErrEpochMismatch) {
		t.Fatalf("stale close with same-chat replacement = %v, want ErrEpochMismatch", err)
	}
	if got := replacementDaemon.RequestCount(omorpc.CmdCloseSession); got != before {
		t.Fatalf("stale close wrote against same-chat replacement: close requests %d -> %d", before, got)
	}
	if live := replacementDaemon.LiveSessions(); len(live) != 1 {
		t.Fatalf("same-chat replacement was closed: live sessions %v", live)
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
func TestFallbackCleanupMarkerSurvivesCallerTimeout(t *testing.T) {
	mgr, stale, root, cleanup := staleCloseFixture(t, "stale-timeout")
	mgr.cfg.CloseTimeout = 20 * time.Millisecond
	replacementDaemon := omorpctest.New(root)
	if err := replacementDaemon.Start(); err != nil {
		cleanup()
		t.Fatalf("start replacement daemon: %v", err)
	}
	defer replacementDaemon.Stop()
	defer cleanup()

	releaseClose := replacementDaemon.BlockHandler(omorpc.CmdCloseSession)
	defer releaseClose()
	if err := stale.Close(); !errors.Is(err, omorpc.ErrWrittenUnanswered) || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("timed-out fallback close = %v, want ErrWrittenUnanswered + DeadlineExceeded", err)
	}
	cleanupDone := mgr.RouteCleanupDone(stale.routingID)
	select {
	case <-cleanupDone:
		t.Fatal("fallback cleanup marker cleared at caller timeout")
	default:
	}

	releaseClose()
	select {
	case <-cleanupDone:
	case <-time.After(testTimeout):
		t.Fatal("fallback cleanup marker did not close after retained completion")
	}

	colliding, _, detach := acquire(t, mgr, testChat{id: "after-timeout", cwd: t.TempDir()}, nil)
	defer detach()
	if colliding.routingID != stale.routingID {
		t.Fatalf("routing IDs did not collide: stale=%q open=%q", stale.routingID, colliding.routingID)
	}
	if live := replacementDaemon.LiveSessions(); len(live) != 1 {
		t.Fatalf("colliding route opened after marker completion was closed: %v", live)
	}
}

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
