package session

// Bounded recovery for an open_session the engine accepted but never
// answered while the connection lived. The caller's acquire fails after its
// own budget; without recovery the per-chat pendingOpen fence, the detached
// open slot, and the detached completion goroutine all persist until the
// connection epoch dies, so every later open for the same chat blocks on
// the fence. These tests pin the manager-level recovery contract:
//
//   - after Config.OpenRecoveryAfter of silence past cleanup expiry the
//     fence and slot are released, so a retry reaches the engine with its
//     own open_session (T1);
//   - a late success arriving after recovery is closed epoch-bound and
//     never published (T2);
//   - a resume open reconciles live provider routes on the targeted path
//     via list_sessions plus epoch-bound close_session (T3);
//   - under a persistently silent engine the detached wait is bounded, so
//     CloseAll still drains (T4).
//
// No fixed sleeps: every wait observes an engine or manager event with a
// bounded timeout, mirroring the merge-gate suite.

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

// newRecoveryManager wires a manager whose open-fence recovery fires fast
// enough to exercise: caller budget and cleanup timeout sit far below the
// recovery budget, matching the documented OpenRecoveryAfter > CloseTimeout
// requirement.
func newRecoveryManager(t *testing.T, client *omorpc.Client, store CursorStore) *Manager {
	t.Helper()
	m := NewManager(Config{
		Client:            client,
		Store:             store,
		QueueSize:         64,
		RetryAttempts:     3,
		RetryBackoff:      time.Millisecond,
		CloseTimeout:      25 * time.Millisecond,
		OpenRecoveryAfter: 200 * time.Millisecond,
	})
	t.Cleanup(func() { _ = m.CloseAll(context.Background()) })
	return m
}

// budgetedAcquire fails the test unless Acquire returns within its caller
// budget with that budget's deadline error, proving the caller actually
// gave up instead of hanging.
func budgetedAcquire(t *testing.T, m *Manager, chat testChat, budget time.Duration) {
	t.Helper()
	result := make(chan error, 1)
	ctx, cancel := context.WithTimeout(context.Background(), budget)
	defer cancel()
	go func() {
		_, _, _, err := m.Acquire(ctx, chat, nil)
		result <- err
	}()
	select {
	case err := <-result:
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("budgeted acquire error = %v, want caller deadline", err)
		}
	case <-time.After(testTimeout):
		t.Fatal("budgeted acquire did not return")
	}
}

// retryAcquire starts a cancellable retry acquire whose context outlives
// the test body, so a failing assertion can never strand the cleanup drain.
func retryAcquire(t *testing.T, m *Manager, chat testChat, sub Subscriber) <-chan error {
	t.Helper()
	result := make(chan error, 1)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go func() {
		_, _, _, err := m.Acquire(ctx, chat, sub)
		result <- err
	}()
	return result
}

func TestOpenRecoveryClearsFenceAndRetries(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	store := newMemStore()
	path := filepath.Join(t.TempDir(), "fenced-resume.jsonl")
	if err := store.SaveCursor(context.Background(), "a", Cursor{SessionFile: path}); err != nil {
		t.Fatalf("seed cursor: %v", err)
	}
	mgr := newRecoveryManager(t, client, store)
	chat := testChat{id: "a", cwd: t.TempDir()}

	// Gate the resume open by path; the gate is never released before
	// recovery, so the first acquire fails on a genuinely unanswered open.
	release := d.BlockHandlerForPath(omorpc.CmdOpenSession, path)
	defer release()
	budgetedAcquire(t, mgr, chat, 60*time.Millisecond)

	// No release, no daemon change: recovery alone must clear the fence so
	// the retry reaches the daemon with its OWN open_session.
	second := retryAcquire(t, mgr, chat, nil)
	if !d.AwaitRequestCount(omorpc.CmdOpenSession, 2, testTimeout) {
		t.Fatal("recovery did not clear the pending-open fence: retry open never reached the daemon")
	}
	if got := d.RequestCount(omorpc.CmdListSessions); got < 1 {
		t.Fatalf("recovery list_sessions calls = %d, want >= 1", got)
	}
	release()
	select {
	case err := <-second:
		if err != nil {
			t.Fatalf("retry acquire after recovery: %v", err)
		}
	case <-time.After(testTimeout):
		t.Fatal("retry acquire did not settle after gate release")
	}
	s, ok := mgr.Get("a")
	if !ok || s.SessionFile() != path {
		t.Fatalf("retry session = (%v, %q), want resume of %q", s, s.SessionFile(), path)
	}
	mgr.mu.Lock()
	pending := len(mgr.pendingOpen)
	mgr.mu.Unlock()
	if pending != 0 {
		t.Fatalf("pendingOpen after recovery = %d, want 0", pending)
	}
}

func TestOpenRecoveryLateSuccessIsClosedAndUnpublished(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	mgr := newRecoveryManager(t, client, newMemStore())
	chat := testChat{id: "a", cwd: t.TempDir()}

	// Gate every open_session; the first acquire fails unanswered.
	release := d.BlockHandler(omorpc.CmdOpenSession)
	budgetedAcquire(t, mgr, chat, 60*time.Millisecond)

	// Recovery clears the fence and the retry issues its own open, still
	// gated. Only then are both responses allowed to arrive.
	sub := newRecorder(16)
	second := retryAcquire(t, mgr, chat, sub)
	if !d.AwaitRequestCount(omorpc.CmdOpenSession, 2, testTimeout) {
		t.Fatal("recovery did not clear the pending-open fence: retry open never reached the daemon")
	}
	release()
	select {
	case err := <-second:
		if err != nil {
			t.Fatalf("retry acquire: %v", err)
		}
	case <-time.After(testTimeout):
		t.Fatal("retry acquire did not settle")
	}
	if f := sub.next(t); f.Kind != FrameReady {
		t.Fatalf("retry ready frame: %+v", f)
	}

	// The late success must be closed epoch-bound and never published.
	if !d.AwaitCloseCount(1, testTimeout) {
		t.Fatal("late successful open was not closed after recovery")
	}
	lateID, _ := d.LastRequest(omorpc.CmdCloseSession)["sessionId"].(string)
	if lateID == "" {
		t.Fatal("late close carried no routing id")
	}
	s, ok := mgr.Get("a")
	if !ok {
		t.Fatal("retry acquire did not publish its session")
	}
	if s.routingID == lateID {
		t.Fatalf("published route %q is the late closed route", s.routingID)
	}
	live := d.LiveSessions()
	if len(live) != 1 || live[0] != s.SessionFile() {
		t.Fatalf("live provider routes = %v, want exactly the retry's %q", live, s.SessionFile())
	}
	mgr.mu.Lock()
	pending := len(mgr.pendingOpen)
	mgr.mu.Unlock()
	if pending != 0 {
		t.Fatalf("pendingOpen after late success = %d, want 0", pending)
	}
}

func TestOpenRecoveryReconcilesStaleRouteOnTargetedPath(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	store := newMemStore()
	mgr := newRecoveryManager(t, client, store)
	sub := newRecorder(16)
	owner, _, _ := acquire(t, mgr, testChat{id: "owner", cwd: t.TempDir()}, sub)
	sub.next(t) // ready
	path := owner.SessionFile()

	// A live route the manager does not own: opened directly through the
	// client, so no chat in this manager publishes it. This is what a
	// genuinely stale reconciliation target looks like.
	orphanPath := filepath.Join(t.TempDir(), "orphan-resume.jsonl")
	rawOpen(t, client, orphanPath)

	// Two gated resume opens: one targeting the owner's live path, one
	// targeting the orphan's path. Neither is ever answered before recovery.
	ownerVictim := testChat{id: "owner-victim", cwd: t.TempDir()}
	orphanVictim := testChat{id: "orphan-victim", cwd: t.TempDir()}
	if err := store.SaveCursor(context.Background(), ownerVictim.id, Cursor{SessionFile: path}); err != nil {
		t.Fatalf("seed cursor: %v", err)
	}
	if err := store.SaveCursor(context.Background(), orphanVictim.id, Cursor{SessionFile: orphanPath}); err != nil {
		t.Fatalf("seed cursor: %v", err)
	}
	releaseOwner := d.BlockHandlerForPath(omorpc.CmdOpenSession, path)
	defer releaseOwner()
	releaseOrphan := d.BlockHandlerForPath(omorpc.CmdOpenSession, orphanPath)
	defer releaseOrphan()
	budgetedAcquire(t, mgr, ownerVictim, 60*time.Millisecond)
	budgetedAcquire(t, mgr, orphanVictim, 60*time.Millisecond)

	// Both reconciliations complete before their fences clear, so once both
	// fences are gone every recovery close already happened.
	awaitOpenFenceReleased(t, mgr, ownerVictim.id, "recovery of the owner-path gated open")
	awaitOpenFenceReleased(t, mgr, orphanVictim.id, "recovery of the orphan-path gated open")

	// Only the unowned orphan route was recoverable: the owner's live route
	// is owned and published by this manager and must survive with a usable
	// route, while the genuinely stale matching route still gets closed.
	if got := d.RequestCount(omorpc.CmdListSessions); got < 1 {
		t.Fatalf("reconciliation list_sessions calls = %d, want >= 1", got)
	}
	if got := d.RequestCount(omorpc.CmdCloseSession); got != 1 {
		t.Fatalf("reconciliation close_session requests = %d, want exactly the one unowned orphan close (the live owner route must survive)", got)
	}
	live := d.LiveSessions()
	if !containsPath(live, path) {
		t.Fatalf("owner's live route was closed by another chat's recovery: live = %v", live)
	}
	if containsPath(live, orphanPath) {
		t.Fatalf("unowned orphan route survived reconciliation: live = %v", live)
	}
	if _, err := owner.QueryState(context.Background()); err != nil {
		t.Fatalf("owner route unusable after another chat's recovery: %v", err)
	}

	// The fences are clear: the orphan victim can retry and take over the
	// orphaned path. The owner-victim retry stays gated: resuming the
	// owner's live path would reassign the shared routing handle in the
	// mock, which is not the behavior under test here.
	second := retryAcquire(t, mgr, orphanVictim, nil)
	if !d.AwaitRequestCountForPath(omorpc.CmdOpenSession, orphanPath, 2, testTimeout) {
		t.Fatal("retry resume never reached the daemon")
	}
	releaseOrphan()
	select {
	case err := <-second:
		if err != nil {
			t.Fatalf("orphan victim retry after reconciliation: %v", err)
		}
	case <-time.After(testTimeout):
		t.Fatal("orphan victim retry did not settle")
	}
}

func TestOpenRecoveryBoundsDetachedCleanupWait(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	mgr := newRecoveryManager(t, client, newMemStore())
	release := d.BlockHandler(omorpc.CmdOpenSession)
	defer release()

	// The engine stays silent forever; the caller fails after its budget
	// and recovery must eventually stop waiting instead of retaining the
	// detached goroutine until epoch death.
	budgetedAcquire(t, mgr, testChat{id: "a", cwd: t.TempDir()}, 60*time.Millisecond)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	closed := make(chan error, 1)
	go func() { closed <- mgr.CloseAll(ctx) }()
	select {
	case err := <-closed:
		if err != nil {
			t.Fatalf("CloseAll under a persistently silent engine: %v", err)
		}
	case <-time.After(testTimeout):
		t.Fatal("CloseAll did not drain the recovered detached open")
	}
}
