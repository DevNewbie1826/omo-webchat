package session

// Round-2 review regressions for the open-fence recovery change: the two
// remaining concurrency windows an ultrabrain round found in stale-route
// reconciliation, adapted from the reviewer's probe schedules into
// permanent tests.
//
//   - A: reconcileStaleRoutes' ownership check and the close it decides on
//     are not one transaction. Another chat can publish the listed route
//     between the check and the close, and recovery then destroys a route
//     this manager owns: the owner's routing handle is closed underneath
//     it and every later command answers unknown_session.
//   - B: the same interval lets CloseAll cross its shutdown barrier before
//     recovery registers its close, so a close_session fires after the
//     barrier with no retiring record the barrier could have observed.
//
// Both schedules park recovery INSIDE the window - after the
// ownership/shutdown check, before the close - using a gate keyed on the
// structured reconciliation-decision fields (chat_id, session_path,
// routing_id), and park the racing publication inside the owner's identity
// persistence via a store wrapper. No manager or provider behavior is
// replaced, and no wait is a fixed sleep.

import (
	"context"
	"log/slog"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

// recoveryDecisionGate parks the first reconciliation decision record for
// the victim chat between its ownership/shutdown check and its close.
type recoveryDecisionGate struct {
	entered chan struct{}
	release chan struct{}
	once    sync.Once
}

func (h *recoveryDecisionGate) Enabled(context.Context, slog.Level) bool { return true }
func (h *recoveryDecisionGate) WithAttrs([]slog.Attr) slog.Handler       { return h }
func (h *recoveryDecisionGate) WithGroup(string) slog.Handler            { return h }
func (h *recoveryDecisionGate) Handle(_ context.Context, r slog.Record) error {
	var chat, route, path string
	r.Attrs(func(a slog.Attr) bool {
		switch a.Key {
		case "chat_id":
			chat = a.Value.String()
		case "routing_id":
			route = a.Value.String()
		case "session_path":
			path = a.Value.String()
		}
		return true
	})
	if chat == "victim" && route != "" && path != "" {
		h.once.Do(func() { close(h.entered); <-h.release })
	}
	return nil
}

// installRecoveryDecisionGate swaps the default slog handler for the
// decision gate and restores it on cleanup. The returned release unparks
// the gated record.
func installRecoveryDecisionGate(t *testing.T) (entered <-chan struct{}, release func()) {
	t.Helper()
	h := &recoveryDecisionGate{entered: make(chan struct{}), release: make(chan struct{})}
	old := slog.Default()
	slog.SetDefault(slog.New(h))
	var once sync.Once
	release = func() { once.Do(func() { close(h.release) }) }
	t.Cleanup(func() { release(); slog.SetDefault(old) })
	return h.entered, release
}

func awaitSignal(t *testing.T, signal <-chan struct{}, what string) {
	t.Helper()
	select {
	case <-signal:
	case <-time.After(testTimeout):
		t.Fatalf("timed out: %s", what)
	}
}

// identityParkedStore parks the owner's acquire between its provider open
// (route live at the engine) and its manager publication (byRoute
// registration): the exact publication that must win the admission race
// against recovery's close decision.
type identityParkedStore struct {
	*memCursorStore
	entered chan struct{}
	release chan struct{}
	once    sync.Once
}

func (s *identityParkedStore) UpdateIdentity(ctx context.Context, chat, path, durable string) error {
	if chat == "owner" {
		s.once.Do(func() { close(s.entered) })
		select {
		case <-s.release:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return s.memCursorStore.UpdateIdentity(ctx, chat, path, durable)
}

// A: a route published after reconciliation's ownership check must never
// be closed by that recovery. The owner opens the shared path and parks
// before publication; the victim's recovery lists the route, observes it
// as unowned, and parks inside the admission window; the owner then
// publishes the exact route recovery decided to close.
func TestReviewRecoveryMustNotCloseRoutePublishedAfterCheck(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	store := &identityParkedStore{memCursorStore: newMemStore(), entered: make(chan struct{}), release: make(chan struct{})}
	mgr := newRecoveryManager(t, client, store)
	path := filepath.Join(t.TempDir(), "publication-race.jsonl")
	for _, chat := range []string{"owner", "victim"} {
		if err := store.SaveCursor(context.Background(), chat, Cursor{SessionFile: path}); err != nil {
			t.Fatalf("seed cursor for %s: %v", chat, err)
		}
	}
	var releaseOnce sync.Once
	releaseStore := func() { releaseOnce.Do(func() { close(store.release) }) }
	defer releaseStore()

	// The owner opens the shared path at the engine and parks before
	// publishing it in the manager.
	ownerDone := make(chan error, 1)
	ownerCtx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		_, _, _, err := mgr.Acquire(ownerCtx, testChat{id: "owner", cwd: filepath.Dir(path)}, nil)
		ownerDone <- err
	}()
	awaitSignal(t, store.entered, "owner opened the shared path and parked before publication")

	// The victim's resume open on the same path is never answered; its
	// recovery lists the owner's route - unowned at check time - and parks
	// between the ownership check and the close.
	openRelease := d.BlockHandlerForPath(omorpc.CmdOpenSession, path)
	defer openRelease()
	entered, releaseDecision := installRecoveryDecisionGate(t)
	defer releaseDecision()
	budgetedAcquire(t, mgr, testChat{id: "victim", cwd: t.TempDir()}, 60*time.Millisecond)
	marker := openFenceMarker(mgr, "victim")
	if marker == nil {
		t.Fatal("victim pending-open fence absent before recovery")
	}
	awaitSignal(t, entered, "recovery observed the route as unowned and parked before the close")

	// The owner publishes the exact route recovery decided to close.
	releaseStore()
	select {
	case err := <-ownerDone:
		if err != nil {
			t.Fatalf("owner acquisition: %v", err)
		}
	case <-time.After(testTimeout):
		t.Fatal("owner acquisition did not settle")
	}
	owner, ok := mgr.Get("owner")
	if !ok {
		t.Fatal("owner did not publish its route")
	}
	if _, err := owner.QueryState(context.Background()); err != nil {
		t.Fatalf("owner route unusable before recovery resumed: %v", err)
	}

	// The close admission must revalidate ownership atomically: the
	// now-owned route is not this recovery's to close anymore.
	releaseDecision()
	awaitSignal(t, marker, "recovery settled and released the victim fence")
	if got := d.RequestCount(omorpc.CmdCloseSession); got != 0 {
		t.Fatalf("recovery closed %d route(s) published after its ownership check", got)
	}
	if _, err := owner.QueryState(context.Background()); err != nil {
		t.Fatalf("recovery destroyed a route published after its ownership check: %v", err)
	}
	if _, ok := mgr.Get("owner"); !ok {
		t.Fatal("manager no longer publishes the owner whose route recovery targeted")
	}
}

// B: a close_session must never fire after CloseAll's shutdown barrier
// without having been registered before it. Recovery parks inside the
// admission window; CloseAll crosses its barrier with nothing registered;
// the resumed admission must refuse to act.
func TestReviewRecoveryMustNotRegisterCloseAfterShutdownBarrier(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	store := newMemStore()
	mgr := newRecoveryManager(t, client, store)
	path := filepath.Join(t.TempDir(), "shutdown-race.jsonl")
	rawOpen(t, client, path) // unowned live route on the targeted path
	if err := store.SaveCursor(context.Background(), "victim", Cursor{SessionFile: path}); err != nil {
		t.Fatalf("seed cursor: %v", err)
	}
	openRelease := d.BlockHandlerForPath(omorpc.CmdOpenSession, path)
	defer openRelease()
	entered, releaseDecision := installRecoveryDecisionGate(t)
	defer releaseDecision()
	budgetedAcquire(t, mgr, testChat{id: "victim", cwd: t.TempDir()}, 60*time.Millisecond)
	awaitSignal(t, entered, "recovery parked between its ownership/shutdown check and the close")

	// Cross the shutdown barrier while recovery is parked inside the
	// admission window.
	closed := make(chan error, 1)
	go func() { closed <- mgr.CloseAll(context.Background()) }()
	awaitSignal(t, mgr.done, "shutdown barrier")
	mgr.mu.Lock()
	retained := len(mgr.retiringByChat["victim"])
	mgr.mu.Unlock()
	if retained != 0 {
		t.Fatalf("close already registered before the barrier: %d retiring route(s)", retained)
	}

	// The resumed admission must refuse: no close may be registered or
	// sent after the barrier.
	releaseDecision()
	select {
	case err := <-closed:
		if err != nil {
			t.Fatalf("CloseAll racing parked recovery: %v", err)
		}
	case <-time.After(testTimeout):
		t.Fatal("CloseAll did not drain the recovered detached open")
	}
	if got := d.RequestCount(omorpc.CmdCloseSession); got != 0 {
		t.Fatalf("recovery issued %d close_session after the shutdown barrier; no close was registered at the barrier", got)
	}
}
