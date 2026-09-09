package session

// Permanent regression pins for the four review blockers on the open-fence
// recovery change. Each test reproduces a defect an ultrabrain review found
// with temporary overlays; here the reproductions are first-class:
//
//   - B1: a late SUCCESS arriving after the final recovery grace (and after
//     shutdown) must still be closed epoch-bound and never published. The
//     final grace may stop the manager's bounded WAIT, not its cleanup
//     ownership of the detached correlation.
//   - B2: repeated recovered attempts under a silent engine must not
//     accumulate retained detached-RPC ownership without bound. Recovery
//     releases the per-chat fence, but the detached-open slot stays held
//     until settlement, so admission is bounded by DetachedOpenLimit.
//   - B3: path-based reconciliation must never close another chat's live,
//     manager-owned route; only genuinely unowned matching routes are
//     recoverable.
//   - B4: recovery transitions must revalidate shutdown state and fence
//     ownership together under the manager lock; after CloseAll's shutdown
//     barrier, recovery must neither clear the fence nor act.
//   - B5: a late success's epoch-bound route close strictly precedes both
//     the pending-open fence release and the detached-open slot release.
//     The close is parked mid-RPC at the daemon (channel-gated) and the
//     fence must still be held while it is in flight.
//
// No fixed sleeps: every wait observes a daemon request, a manager
// notification (the fence marker's close, the settlement broadcast, the
// shutdown barrier's done channel), or a channel close.

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

// newReviewManager wires a recovery manager like newRecoveryManager but
// allows per-test config overrides (DetachedOpenLimit, CloseTimeout, ...).
func newReviewManager(t *testing.T, client *omorpc.Client, store CursorStore, mutate func(*Config)) *Manager {
	t.Helper()
	cfg := Config{
		Client:            client,
		Store:             store,
		QueueSize:         64,
		RetryAttempts:     3,
		RetryBackoff:      time.Millisecond,
		CloseTimeout:      25 * time.Millisecond,
		OpenRecoveryAfter: 200 * time.Millisecond,
	}
	if mutate != nil {
		mutate(&cfg)
	}
	m := NewManager(cfg)
	t.Cleanup(func() { _ = m.CloseAll(context.Background()) })
	return m
}

// openFenceMarker snapshots the chat's pending-open fence marker under
// the manager lock. The marker channel closes exactly when that fence
// registration ends (recovery or settlement), so waiting on it observes
// the release transition itself rather than polling for its effect.
func openFenceMarker(m *Manager, chatID string) chan struct{} {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.pendingOpen[chatID]
}

// awaitOpenFenceReleased waits until the chat's pending-open fence is
// released. A nil marker means the fence is already released.
func awaitOpenFenceReleased(t *testing.T, m *Manager, chatID, what string) {
	t.Helper()
	marker := openFenceMarker(m, chatID)
	if marker == nil {
		return
	}
	select {
	case <-marker:
	case <-time.After(testTimeout):
		t.Fatalf("timed out waiting for %s", what)
	}
}

// awaitHeldOpenSlots waits until exactly want detached-open slots are
// held. Every iteration blocks on the manager's settlement broadcast,
// which fires under m.mu on each slot release, so the wait is driven by
// settlement events, never by a timer.
func awaitHeldOpenSlots(t *testing.T, m *Manager, want int, what string) {
	t.Helper()
	deadline := time.NewTimer(testTimeout)
	defer deadline.Stop()
	for {
		m.mu.Lock()
		held := len(m.openSlots)
		signal := m.openSettled
		m.mu.Unlock()
		if held == want {
			return
		}
		select {
		case <-signal:
		case <-deadline.C:
			t.Fatalf("timed out waiting for %s", what)
		}
	}
}

// openFenceHeld reports whether the chat's pending-open fence is still
// registered (recovery must not clear it after the shutdown barrier).
func openFenceHeld(m *Manager, chatID string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.pendingOpen[chatID] != nil
}

// heldOpenSlots counts detached-open slots currently held.
func heldOpenSlots(m *Manager) int {
	return len(m.openSlots)
}

// rawOpen opens a session directly through the client, bypassing the
// manager. The resulting provider route is live yet owned by no chat in the
// manager, which is exactly what a genuinely stale reconciliation target
// looks like from the manager's point of view.
func rawOpen(t *testing.T, client *omorpc.Client, path string) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), testTimeout)
	defer cancel()
	resp, _, err := client.CallInEpoch(ctx, omorpc.OpenSession{CWD: t.TempDir(), SessionPath: path})
	if err != nil || resp == nil || !resp.Success {
		t.Fatalf("raw open of unowned route %s: err=%v resp=%v", path, err, resp)
	}
	var out omorpc.OpenSessionData
	if err := json.Unmarshal(resp.Data, &out); err != nil {
		t.Fatalf("decode raw open of %s: %v", path, err)
	}
	return out.SessionID
}

func containsPath(paths []string, want string) bool {
	for _, p := range paths {
		if p == want {
			return true
		}
	}
	return false
}

// B1: the final grace may stop the manager's bounded waiting, not its
// cleanup ownership. A late SUCCESS that arrives after the final grace -
// here even after CloseAll's shutdown barrier - must still be closed
// epoch-bound and never published.
func TestReviewLateResponseAfterFinalGrace(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	mgr := newRecoveryManager(t, client, newMemStore())
	chat := testChat{id: "a", cwd: t.TempDir()}

	// The engine never answers the open_session within any recovery budget.
	release := d.BlockHandler(omorpc.CmdOpenSession)

	// The caller gives up; the detached wait runs its recovery budget and
	// the final grace expires with the response still outstanding.
	budgetedAcquire(t, mgr, chat, 60*time.Millisecond)

	// CloseAll's cleanup barrier unblocks once the bounded wait ends; the
	// correlation is still unsettled at that point.
	closed := make(chan error, 1)
	go func() { closed <- mgr.CloseAll(context.Background()) }()
	select {
	case err := <-closed:
		if err != nil {
			t.Fatalf("CloseAll after final grace: %v", err)
		}
	case <-time.After(testTimeout):
		t.Fatal("CloseAll did not drain the detached recovery wait")
	}

	// Only now does the late SUCCESS arrive - after the final grace and
	// after shutdown. Cleanup ownership must still settle it.
	release()
	if !d.AwaitCloseCount(1, testTimeout) {
		t.Fatal("late response abandoned after consumer exit: the late successful open was never closed")
	}
	if live := d.LiveSessions(); len(live) != 0 {
		t.Fatalf("late open left live provider routes: %v", live)
	}
	if _, ok := mgr.Get("a"); ok {
		t.Fatal("late response was published after the final grace and shutdown")
	}
}

// B2: repeated recovered attempts under a silent engine must not accumulate
// retained detached-RPC ownership. Recovery clears the per-chat fence so the
// chat can retry, but the detached-open slot stays held until settlement:
// with DetachedOpenLimit=1 no further detached open is admitted while the
// recovered attempt is still retained.
func TestReviewRepeatedSilenceBoundedRetainedOpens(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	mgr := newReviewManager(t, client, newMemStore(), func(cfg *Config) {
		cfg.DetachedOpenLimit = 1
	})

	release := d.BlockHandler(omorpc.CmdOpenSession)
	defer release()

	// First attempt: unanswered. Recovery clears the per-chat fence only.
	budgetedAcquire(t, mgr, testChat{id: "a", cwd: t.TempDir()}, 60*time.Millisecond)
	awaitOpenFenceReleased(t, mgr, "a", "recovery of the first detached open")

	// The single detached-open slot must still be held by the retained
	// recovered attempt; admission may not return to zero while the RPC
	// ownership is retained.
	if held := heldOpenSlots(mgr); held != 1 {
		t.Fatalf("retained detached-open slots after recovery = %d, want 1: repeated recovered attempts accumulate unbounded retained ownership", held)
	}

	// Further attempts - sequential recovered attempts under continued
	// silence - must be refused at admission instead of accumulating more
	// retained correlations.
	for _, chatID := range []string{"b", "c", "d"} {
		result := make(chan error, 1)
		ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
		go func() {
			_, _, _, err := mgr.Acquire(ctx, testChat{id: chatID, cwd: t.TempDir()}, nil)
			result <- err
		}()
		select {
		case err := <-result:
			if !errors.Is(err, ErrOpenBusy) {
				t.Fatalf("acquire %q under a fully retained detached-open limit: err = %v, want ErrOpenBusy (unbounded retained detached opens)", chatID, err)
			}
		case <-time.After(testTimeout):
			t.Fatalf("acquire %q under a fully retained detached-open limit did not return", chatID)
		}
		cancel()
	}

	// Settlement releases the bound: once the retained correlation settles,
	// the slot frees and a later attempt is admitted again.
	release()
	awaitHeldOpenSlots(t, mgr, 0, "settlement of the recovered detached open")
	result := make(chan error, 1)
	go func() {
		_, _, _, err := mgr.Acquire(context.Background(), testChat{id: "e", cwd: t.TempDir()}, nil)
		result <- err
	}()
	select {
	case err := <-result:
		if err != nil {
			t.Fatalf("acquire after settlement: %v", err)
		}
	case <-time.After(testTimeout):
		t.Fatal("acquire after settlement did not return")
	}
}

// B3: path-based reconciliation must not close another chat's live owner.
// A route this manager currently owns and publishes is not the recovering
// chat's to close, no matter that its durable path matches.
func TestReviewRecoveryMustNotCloseAnotherLiveOwner(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	store := newMemStore()
	mgr := newRecoveryManager(t, client, store)

	// A live owner published by this manager.
	ownerSub := newRecorder(16)
	owner, _, _ := acquire(t, mgr, testChat{id: "owner", cwd: t.TempDir()}, ownerSub)
	ownerSub.next(t) // ready
	ownerPath := owner.SessionFile()

	// The victim's cursor targets the owner's live path; its resume open is
	// gated and never answered before recovery.
	victim := testChat{id: "victim", cwd: t.TempDir()}
	if err := store.SaveCursor(context.Background(), victim.id, Cursor{SessionFile: ownerPath}); err != nil {
		t.Fatalf("seed cursor: %v", err)
	}
	release := d.BlockHandlerForPath(omorpc.CmdOpenSession, ownerPath)
	defer release()
	budgetedAcquire(t, mgr, victim, 60*time.Millisecond)

	// Recovery reconciles; the transition completes before the fence clears,
	// so once the fence is gone any wrongful close already happened.
	awaitOpenFenceReleased(t, mgr, victim.id, "recovery of the gated victim open")

	// The owner's route must never have been closed.
	if got := d.RequestCount(omorpc.CmdCloseSession); got != 0 {
		t.Fatalf("recovery closed %d route(s); a live owner route must never be closed by another chat's recovery", got)
	}
	// The owner stays published with a usable route: the round-trip through
	// the provider must still succeed on the original routing handle.
	if _, err := owner.QueryState(context.Background()); err != nil {
		t.Fatalf("recovery destroyed the active owner route: %v", err)
	}
	if _, ok := mgr.Get("owner"); !ok {
		t.Fatal("manager no longer publishes the owner whose route recovery targeted")
	}
	if !containsPath(d.LiveSessions(), ownerPath) {
		t.Fatal("owner's provider route is no longer live after recovery")
	}
}

// B4: recovery must revalidate shutdown state and fence ownership together
// under the manager lock immediately before each transition. Once CloseAll's
// shutdown barrier is crossed, recovery must neither clear the fence nor act.
func TestReviewRecoveryMustNotActAfterShutdownBarrier(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	store := newMemStore()
	mgr := newReviewManager(t, client, store, func(cfg *Config) {
		cfg.CloseTimeout = 150 * time.Millisecond
		cfg.OpenRecoveryAfter = 400 * time.Millisecond
	})

	path := filepath.Join(t.TempDir(), "shutdown-fence.jsonl")
	victim := testChat{id: "victim", cwd: t.TempDir()}
	if err := store.SaveCursor(context.Background(), victim.id, Cursor{SessionFile: path}); err != nil {
		t.Fatalf("seed cursor: %v", err)
	}

	openGate := d.BlockHandlerForPath(omorpc.CmdOpenSession, path)
	defer openGate()
	// Park reconciliation mid-transition: list_sessions is held at the
	// daemon while the recovery goroutine sits between its shutdown check
	// and its fence-clearing transition.
	listGate := d.BlockHandler(omorpc.CmdListSessions)
	defer listGate()

	budgetedAcquire(t, mgr, victim, 60*time.Millisecond)

	// The list request reaching the daemon proves the pre-transition
	// shutdown check already evaluated false.
	if !d.AwaitRequestCount(omorpc.CmdListSessions, 1, testTimeout) {
		t.Fatal("recovery never sent list_sessions")
	}

	// Cross the shutdown barrier while recovery is parked mid-transition.
	closed := make(chan error, 1)
	go func() { closed <- mgr.CloseAll(context.Background()) }()
	select {
	case <-mgr.done:
	case <-time.After(testTimeout):
		t.Fatal("CloseAll's shutdown barrier was not crossed")
	}

	// Let reconciliation finish; CloseAll's cleanup barrier then unblocks
	// after the final grace expires.
	listGate()
	select {
	case err := <-closed:
		if err != nil {
			t.Fatalf("CloseAll after parked recovery: %v", err)
		}
	case <-time.After(testTimeout):
		t.Fatal("CloseAll did not drain the detached recovery wait")
	}

	// The unresolved open fence must survive: clearing it after the
	// shutdown barrier is a lost-wakeup bug for any CloseAll-time owner.
	if !openFenceHeld(mgr, victim.id) {
		t.Fatal("recovery cleared the unresolved open fence after CloseAll's shutdown barrier")
	}
	if got := d.RequestCount(omorpc.CmdCloseSession); got != 0 {
		t.Fatalf("recovery acted after the shutdown barrier: %d close_session request(s)", got)
	}
}

// B5: settlement ordering - the late success's epoch-bound close strictly
// precedes both the pending-open fence release and the detached-open slot
// release. The close is parked mid-RPC at the daemon via a channel gate,
// and while it is provably in flight the fence and slot must still be
// held: only the close's completion may release them. The schedule is
// deterministic - with the recovery budget far above the whole scenario,
// settlement always happens inside the first grace, so recovery never
// interferes with the ordering window, and the parked close cannot expire
// its RPC budget because CloseTimeout equally exceeds the scenario.
func TestReviewLateClosePrecedesFenceRelease(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	mgr := newReviewManager(t, client, newMemStore(), func(cfg *Config) {
		cfg.CloseTimeout = 500 * time.Millisecond
		cfg.OpenRecoveryAfter = 2 * time.Second
	})
	openRelease := d.BlockHandler(omorpc.CmdOpenSession)
	defer openRelease()
	closeRelease := d.BlockHandler(omorpc.CmdCloseSession)
	defer closeRelease()
	budgetedAcquire(t, mgr, testChat{id: "a", cwd: t.TempDir()}, 60*time.Millisecond)

	marker := openFenceMarker(mgr, "a")
	if marker == nil {
		t.Fatal("pending-open fence absent after the caller budget expired")
	}

	// The late SUCCESS lands inside the first grace; its route close parks
	// at the daemon mid-RPC.
	openRelease()
	if !d.AwaitRequestCount(omorpc.CmdCloseSession, 1, testTimeout) {
		t.Fatal("late successful open was never closed")
	}

	// The close is provably in flight: the fence and the detached-open
	// slot must both still be held, because settlement releases them only
	// after the close settles.
	mgr.mu.Lock()
	fenceHeld := mgr.pendingOpen["a"] != nil
	held := len(mgr.openSlots)
	mgr.mu.Unlock()
	if !fenceHeld || held != 1 {
		t.Fatalf("late close in flight but fence held=%v detached-open slots=%d: the release must strictly follow the close", fenceHeld, held)
	}

	// Completing the close is what releases fence and slot.
	closeRelease()
	awaitOpenFenceReleased(t, mgr, "a", "fence release after the late close settled")
	awaitHeldOpenSlots(t, mgr, 0, "detached-open slot release after the late close settled")
	if _, ok := mgr.Get("a"); ok {
		t.Fatal("late success was published")
	}
	if live := d.LiveSessions(); len(live) != 0 {
		t.Fatalf("late open left live provider routes: %v", live)
	}
}
