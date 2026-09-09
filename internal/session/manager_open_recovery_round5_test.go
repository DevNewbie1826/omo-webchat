package session

// Round-5 review regressions for the retired-route registry that open
// recovery uses to refuse publication of routes it destroyed:
//
//   - A: retirement was keyed by route handle alone. Route handles are
//     minted per provider process, so a provider restart that reuses the
//     same handle string on a new connection epoch would be fenced by the
//     dead epoch's retirement. Retirement is now scoped to the connection
//     epoch that minted the handle, and epoch death drops the dead epoch's
//     entries so they can never consume the registry bound.
//   - B: the registry evicted its oldest entry FIFO once it filled,
//     silently dropping protection an outstanding publisher may still
//     need. The registry is now admission-bounded: at Config.RetiredRouteLimit
//     recovery refuses to retire NEW routes (deferring their cleanup)
//     instead of forgetting an existing retirement.
//
// Both schedules park an owner acquire between its successful provider
// open and its manager publication (inside UpdateIdentity), exactly the
// window where recovery's retirement must keep fencing that owner's route.

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc/omorpctest"
)

// keyedParkStore parks the named chats' acquires between provider open and
// manager publication (inside UpdateIdentity), each on its own gate.
type keyedParkStore struct {
	*memCursorStore
	mu    sync.Mutex
	gates map[string]*parkGate
}

type parkGate struct {
	entered chan struct{}
	release chan struct{}
	once    sync.Once
}

func newKeyedParkStore() *keyedParkStore {
	return &keyedParkStore{memCursorStore: newMemStore(), gates: make(map[string]*parkGate)}
}

// gate returns (creating if needed) the park gate for chat. Create the gate
// before starting the acquire it must park.
func (s *keyedParkStore) gate(chat string) *parkGate {
	s.mu.Lock()
	defer s.mu.Unlock()
	g := s.gates[chat]
	if g == nil {
		g = &parkGate{entered: make(chan struct{}), release: make(chan struct{})}
		s.gates[chat] = g
	}
	return g
}

func (s *keyedParkStore) UpdateIdentity(ctx context.Context, chat, path, durable string) error {
	s.mu.Lock()
	g := s.gates[chat]
	s.mu.Unlock()
	if g != nil {
		g.once.Do(func() { close(g.entered) })
		select {
		case <-g.release:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return s.memCursorStore.UpdateIdentity(ctx, chat, path, durable)
}

// newBoundedRecoveryManager is newRecoveryManager with an explicit retired
// route admission bound, for the registry-limit regressions.
func newBoundedRecoveryManager(t *testing.T, client *omorpc.Client, store CursorStore, limit int) *Manager {
	t.Helper()
	m := NewManager(Config{
		Client:            client,
		Store:             store,
		QueueSize:         64,
		RetryAttempts:     3,
		RetryBackoff:      time.Millisecond,
		CloseTimeout:      25 * time.Millisecond,
		OpenRecoveryAfter: 200 * time.Millisecond,
		RetiredRouteLimit: limit,
	})
	t.Cleanup(func() { _ = m.CloseAll(context.Background()) })
	return m
}

// startParkedOwner starts an owner acquire for path that parks after its
// successful provider open (before manager publication) and returns its
// release plus result channel.
func startParkedOwner(t *testing.T, mgr *Manager, store *keyedParkStore, chatID, path string) (release func(), done <-chan error) {
	t.Helper()
	g := store.gate(chatID)
	var once sync.Once
	release = func() { once.Do(func() { close(g.release) }) }
	t.Cleanup(release)
	doneCh := make(chan error, 1)
	go func() {
		_, _, _, err := mgr.Acquire(context.Background(), testChat{id: chatID, cwd: filepath.Dir(path)}, nil)
		doneCh <- err
	}()
	awaitSignal(t, g.entered, "owner parked after successful provider open")
	return release, doneCh
}

// runVictimRecovery drives one open-fence recovery for a victim chat
// resuming path: the resume open is never answered, the caller budget
// fails, and recovery settles (retiring any unowned live route on path the
// registry still admits) before releasing the victim's fence.
func runVictimRecovery(t *testing.T, mgr *Manager, d *omorpctest.Daemon, store CursorStore, victimID, path string) {
	t.Helper()
	if err := store.SaveCursor(context.Background(), victimID, Cursor{SessionFile: path}); err != nil {
		t.Fatal(err)
	}
	openRelease := d.BlockHandlerForPath(omorpc.CmdOpenSession, path)
	t.Cleanup(openRelease)
	budgetedAcquire(t, mgr, testChat{id: victimID, cwd: filepath.Dir(path)}, 60*time.Millisecond)
	awaitOpenFenceReleased(t, mgr, victimID, "recovery settled its retirement")
}

// A: retirement must be scoped to the connection epoch that minted the
// handle. A provider restart reusing the same handle string on a new epoch
// must not be fenced by the dead epoch's retirement, and the dead epoch's
// entries must be dropped so they cannot consume the registry bound.
func TestRetirementIsEpochScopedAcrossDaemonRestart(t *testing.T) {
	// Short socket root: the unix path length bound cannot fit t.TempDir().
	root, err := os.MkdirTemp("", "sess-epoch-reuse-")
	if err != nil {
		t.Fatalf("temporary daemon directory: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	oldDaemon := omorpctest.New(root)
	if err := oldDaemon.Start(); err != nil {
		t.Fatalf("start old daemon: %v", err)
	}
	client := dial(t, oldDaemon)
	store := newKeyedParkStore()
	mgr := newRecoveryManager(t, client, store)
	path := filepath.Join(t.TempDir(), "epoch-reuse.jsonl")
	if err := store.SaveCursor(context.Background(), "owner", Cursor{SessionFile: path}); err != nil {
		t.Fatal(err)
	}

	// The owner opens its route on the old epoch and parks before
	// publication; the victim's recovery retires that route.
	releaseOwner, ownerDone := startParkedOwner(t, mgr, store, "owner", path)

	// A witness session on the same epoch observes its invalidation, which
	// proves detachEpoch completed for the dead token.
	witnessRec := newRecorder(4)
	acquire(t, mgr, testChat{id: "witness", cwd: t.TempDir()}, witnessRec)
	witnessRec.next(t) // ready

	runVictimRecovery(t, mgr, oldDaemon, store, "victim", path)
	retiredRoute, _ := oldDaemon.LastRequest(omorpc.CmdCloseSession)["sessionId"].(string)
	if retiredRoute == "" {
		t.Fatal("recovery retired no route for the parked owner")
	}

	// On the live epoch the retirement fences the parked owner.
	releaseOwner()
	select {
	case err := <-ownerDone:
		if !errors.Is(err, ErrSessionResumable) {
			t.Fatalf("parked owner on the retired epoch: acquire = %v, want ErrSessionResumable", err)
		}
	case <-time.After(testTimeout):
		t.Fatal("owner acquire did not settle")
	}

	// The provider dies: live routes are gone. A replacement process on the
	// same socket mints routing handles from scratch, so the next open can
	// carry the exact handle string the old epoch retired.
	_, oldEpochEvents := client.CurrentEpoch()
	oldDaemon.Stop()
	select {
	case <-oldEpochEvents:
	case <-time.After(testTimeout):
		t.Fatal("old epoch did not close")
	}
	witnessRec.awaitError(t, "provider_disconnected")

	// Epoch death must drop the dead epoch's retirements: they can never
	// match a route of a successor epoch, so retaining them only consumes
	// the admission bound.
	mgr.mu.Lock()
	retained := len(mgr.retiredRoutes)
	mgr.mu.Unlock()
	if retained != 0 {
		t.Fatalf("dead-epoch retirements retained after invalidation: %d", retained)
	}

	replacement := omorpctest.New(root)
	if err := replacement.Start(); err != nil {
		t.Fatalf("start replacement daemon: %v", err)
	}
	defer replacement.Stop()

	freshPath := filepath.Join(t.TempDir(), "fresh.jsonl")
	if err := store.SaveCursor(context.Background(), "fresh", Cursor{SessionFile: freshPath}); err != nil {
		t.Fatal(err)
	}
	sess, _, _, err := mgr.Acquire(context.Background(), testChat{id: "fresh", cwd: filepath.Dir(freshPath)}, nil)
	if err != nil {
		t.Fatalf("new-epoch acquire fenced by old epoch retirement: %v", err)
	}
	if sess.routingID != retiredRoute {
		t.Fatalf("handle was not reused across the restart: retired=%q fresh=%q", retiredRoute, sess.routingID)
	}
	if _, err := sess.QueryState(context.Background()); err != nil {
		t.Fatalf("new-epoch route unusable: %v", err)
	}
}

// B: the retired-route registry is admission-bounded, not FIFO-evicted.
// Once the bound is reached, recovery refuses to retire NEW routes
// (deferring their cleanup) instead of dropping protection an outstanding
// publisher may still need.
func TestRetirementBoundRefusesNewRetirements(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	store := newKeyedParkStore()
	mgr := newBoundedRecoveryManager(t, client, store, 1)

	path1 := filepath.Join(t.TempDir(), "first.jsonl")
	path2 := filepath.Join(t.TempDir(), "second.jsonl")
	if err := store.SaveCursor(context.Background(), "owner1", Cursor{SessionFile: path1}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveCursor(context.Background(), "owner2", Cursor{SessionFile: path2}); err != nil {
		t.Fatal(err)
	}

	// Fill the registry to its bound: owner1's route is retired by the
	// first victim's recovery.
	releaseOwner1, owner1Done := startParkedOwner(t, mgr, store, "owner1", path1)
	runVictimRecovery(t, mgr, d, store, "victim1", path1)
	if got := d.RequestCount(omorpc.CmdCloseSession); got != 1 {
		t.Fatalf("closes after first recovery = %d, want exactly the first route's close", got)
	}

	// The second victim's recovery finds owner2's unowned route but the
	// registry is full: retirement is refused and the close deferred, so
	// the route keeps living. The victim's fence still settles.
	releaseOwner2, owner2Done := startParkedOwner(t, mgr, store, "owner2", path2)
	runVictimRecovery(t, mgr, d, store, "victim2", path2)
	if got := d.RequestCount(omorpc.CmdCloseSession); got != 1 {
		t.Fatalf("recovery closed a route past the retirement bound: closes = %d, want 1", got)
	}
	mgr.mu.Lock()
	retained := len(mgr.retiredRoutes)
	mgr.mu.Unlock()
	if retained != 1 {
		t.Fatalf("retired-route registry after refused admission = %d, want the bound 1", retained)
	}

	// The first retirement's protection survived the later churn: the
	// parked owner1 is still rejected as resumable, never
	// published-then-destroyed.
	releaseOwner1()
	select {
	case err := <-owner1Done:
		if !errors.Is(err, ErrSessionResumable) {
			t.Fatalf("parked owner after registry churn: acquire = %v, want ErrSessionResumable", err)
		}
	case <-time.After(testTimeout):
		t.Fatal("owner1 acquire did not settle")
	}

	// The refused route was never closed, so its parked owner publishes
	// normally once released.
	releaseOwner2()
	select {
	case err := <-owner2Done:
		if err != nil {
			t.Fatalf("owner of the refused retirement: acquire = %v, want success", err)
		}
	case <-time.After(testTimeout):
		t.Fatal("owner2 acquire did not settle")
	}
	owner2, ok := mgr.Get("owner2")
	if !ok {
		t.Fatal("owner2 did not publish its route after a refused retirement")
	}
	if _, err := owner2.QueryState(context.Background()); err != nil {
		t.Fatalf("refused-retirement route unusable: %v", err)
	}
}

// Round-6 review regression: recovery admission must refuse a connection
// epoch that died while a stale list_sessions result was in flight. The
// guard runs inside the admission critical section, before any bookkeeping,
// so a dead epoch's retirement can never be reinserted after detachEpoch
// cleared it - and can therefore never consume the admission bound that a
// live successor epoch's reconciliation still needs.
func TestRetirementAdmissionRefusesDeadEpoch(t *testing.T) {
	// Short socket root: the unix path length bound cannot fit t.TempDir().
	root, err := os.MkdirTemp("", "sess-dead-epoch-")
	if err != nil {
		t.Fatalf("temporary daemon directory: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	d := omorpctest.New(root)
	if err := d.Start(); err != nil {
		t.Fatalf("start daemon: %v", err)
	}
	client := dial(t, d)
	mgr := newBoundedRecoveryManager(t, client, newKeyedParkStore(), 1)

	// A witness session observes the old epoch's invalidation, which proves
	// detachEpoch completed for the dead token before the stale admission.
	witnessRec := newRecorder(4)
	acquire(t, mgr, testChat{id: "witness", cwd: t.TempDir()}, witnessRec)
	witnessRec.next(t) // ready

	oldToken, oldEvents := client.CurrentEpoch()
	d.Stop()
	select {
	case <-oldEvents:
	case <-time.After(testTimeout):
		t.Fatal("old epoch did not close")
	}
	witnessRec.awaitError(t, "provider_disconnected")

	// A stale recovery carrying the dead token tries to admit an unowned
	// route it observed on the old epoch. Admission must refuse before any
	// bookkeeping: no retirement record, no cleanup reservation, no
	// retiring registration.
	if cleanup, ok := mgr.beginRecoveryClose("victim", "rpc-stale", oldToken); ok {
		t.Fatalf("recovery admitted a retirement on dead connection epoch: route=rpc-stale")
	} else if cleanup != nil {
		t.Fatal("refused dead-epoch admission still returned cleanup bookkeeping")
	}
	mgr.mu.Lock()
	retired := len(mgr.retiredRoutes)
	cleaning := len(mgr.routeCleanup)
	retiring := len(mgr.retiringByChat)
	mgr.mu.Unlock()
	if retired != 0 || cleaning != 0 || retiring != 0 {
		t.Fatalf("dead-epoch admission left bookkeeping: retired=%d cleanup=%d retiring=%d", retired, cleaning, retiring)
	}
}
