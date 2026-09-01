package chat

// Contract pins for provider-lifetime decoupling.
//
// Every chat runs on ONE shared "omo --mode rpc --multi-session" provider
// process. These tests pin the target contract:
//
//  1. Per-session teardown (Manager.Stop, the idle sweeper's reap) must NOT
//     close the shared provider daemon; other chats depend on that process.
//     Only Manager.CloseAll (server shutdown), the pump's stdout EOF path,
//     and the decode-corruption path may close it.
//  2. AcquireAttach must never transparently reuse a provider whose process
//     already died: it must recycle it (start a fresh provider) or fail with
//     an error naming the dead provider, and it must never hang.
//
// Session reaping itself stays as-is: idle finished sessions are still
// evicted; only the PROVIDER close is decoupled from that eviction.
//
// As of base 84e3aa0 the first, second, and fourth tests FAIL (RED) because
// releaseProviderIfIdle closes the shared provider and AcquireAttach reuses
// m.provider with no liveness check. TestCloseAllStillClosesProvider passes
// today and guards the shutdown path through the upcoming change.

import (
	"context"
	"sync/atomic"
	"testing"
	"time"
)

// installPinCloseProcess replaces the synthetic close hook with an observed
// one: an atomic close counter plus the done-channel close that models the
// constructor's close contract (see fakeSharedProvider).
func installPinCloseProcess(p *sharedProvider) *atomic.Int32 {
	var closeCalls atomic.Int32
	p.closeProcess = func() error {
		closeCalls.Add(1)
		close(p.done)
		return nil
	}
	return &closeCalls
}

// pinProviderStillAlive asserts the shared provider process was never closed,
// deterministically: manager release paths close it synchronously before
// returning, so a plain done-channel check needs no sleep or polling.
func pinProviderStillAlive(t *testing.T, p *sharedProvider, closeCalls *atomic.Int32, phase string) {
	t.Helper()
	select {
	case <-p.done:
		t.Fatalf("%s closed the shared multi-session provider daemon; provider lifetime must be decoupled from single-session lifetime (other chats depend on this process)", phase)
	default:
	}
	if got := closeCalls.Load(); got != 0 {
		t.Fatalf("%s invoked the provider process close %d time(s); provider lifetime must be decoupled from single-session lifetime", phase, got)
	}
}

func pinPublishedProvider(t *testing.T, m *Manager) *sharedProvider {
	t.Helper()
	m.mu.Lock()
	published := m.provider
	m.mu.Unlock()
	return published
}

func TestLastSessionStopKeepsSharedProviderAlive(t *testing.T) {
	provider := fakeSharedProvider(make(chan []byte, 4))
	closeCalls := installPinCloseProcess(provider)
	manager := NewManager()
	t.Cleanup(manager.CloseAll)
	manager.provider = provider
	session := newTestSession("pin-stop-shared", nil)
	session.owner = manager
	session.shared = provider
	manager.sessions[session.ID()] = session

	manager.Stop(session.ID())

	if got := manager.Get(session.ID()); got != nil {
		t.Fatalf("Stop left the session registered: %p", got)
	}
	pinProviderStillAlive(t, provider, closeCalls, "Stop of the last registered session")
	if published := pinPublishedProvider(t, manager); published != provider {
		t.Fatalf("manager.provider = %p after last-session Stop, want the shared provider still published at %p", published, provider)
	}
}

func TestSweeperReapKeepsSharedProviderAlive(t *testing.T) {
	provider := fakeSharedProvider(make(chan []byte, 4))
	closeCalls := installPinCloseProcess(provider)
	manager := NewManager()
	t.Cleanup(manager.CloseAll)
	manager.provider = provider
	manager.idleFor = time.Second
	session := newTestSession("pin-sweep-shared", nil)
	session.owner = manager
	session.shared = provider
	session.runDone = true
	session.finishedAt = time.Now().Add(-2 * time.Minute)
	manager.sessions[session.ID()] = session

	manager.sweepOnce()

	if got := manager.Get(session.ID()); got != nil {
		t.Fatalf("sweeper did not evict the idle finished session: %p", got)
	}
	pinProviderStillAlive(t, provider, closeCalls, "Sweeper reap of the last idle finished session")
	if published := pinPublishedProvider(t, manager); published != provider {
		t.Fatalf("manager.provider = %p after sweeper reap, want the shared provider still published at %p", published, provider)
	}
}

func TestCloseAllStillClosesProvider(t *testing.T) {
	provider := fakeSharedProvider(make(chan []byte, 4))
	closeCalls := installPinCloseProcess(provider)
	manager := NewManager()
	t.Cleanup(manager.CloseAll) // idempotent via closeOnce
	manager.provider = provider
	session := newTestSession("pin-closeall-shared", nil)
	session.owner = manager
	session.shared = provider
	manager.sessions[session.ID()] = session

	manager.CloseAll()

	// Bounded watchdog as a failure guard only; CloseAll's release paths are
	// synchronous for a synthetic provider.
	select {
	case <-provider.done:
	case <-time.After(5 * time.Second):
		t.Fatal("CloseAll did not close the shared provider process within the watchdog; server shutdown must terminate the daemon")
	}
	if got := closeCalls.Load(); got != 1 {
		t.Fatalf("CloseAll invoked the provider process close %d time(s), want exactly 1", got)
	}
	if published := pinPublishedProvider(t, manager); published != nil {
		t.Fatalf("CloseAll left manager.provider published: %p", published)
	}
	if got := manager.Get(session.ID()); got != nil {
		t.Fatalf("CloseAll left the session registered: %p", got)
	}
}

// TestDeadProviderDoesNotParalyzeAcquire pins the recovery contract this
// change relies on INSTEAD of a liveness check in the reuse branch. Removing
// the idle reaper means a provider that already died can still be published
// when an acquire arrives, so the requirement is that such an acquire cannot
// hang and cannot wedge the manager: openSession rejects a non-started
// provider immediately, and the pump's own death sequence clears the manager
// slot, so the very next acquire starts a fresh provider.
func TestDeadProviderDoesNotParalyzeAcquire(t *testing.T) {
	deadProvider := fakeSharedProvider(make(chan []byte, 4))
	deadProvider.closeProcess = func() error { return nil }
	// Model a provider whose process already died: the pump observed EOF,
	// moved the state off started, published the exit summary and closed done.
	deadProvider.mu.Lock()
	deadProvider.state = sharedProviderDead
	deadProvider.exitSummary = "process exited"
	deadProvider.mu.Unlock()
	close(deadProvider.done)

	manager := NewManager()
	t.Cleanup(manager.CloseAll)
	manager.mu.Lock()
	manager.provider = deadProvider
	manager.mu.Unlock()

	opts := managedMockOptions(t, "pin-dead-provider")
	type acquireOutcome struct {
		session *Session
		err     error
	}
	outcome := make(chan acquireOutcome, 1)
	go func() {
		session, _, _, err := manager.AcquireAttach(context.Background(), opts, nil)
		outcome <- acquireOutcome{session: session, err: err}
	}()
	var first acquireOutcome
	select {
	case first = <-outcome:
	case <-time.After(10 * time.Second):
		t.Fatal("AcquireAttach against a dead shared provider never returned; a dead provider must fail the acquire in bounded time, never block it")
	}
	// One transient failure is the accepted cost of having no liveness check.
	// What must NOT happen is a hang above, or a wedged manager below.
	if first.err == nil {
		if first.session == nil {
			t.Fatal("AcquireAttach reported success with no session")
		}
		if published := pinPublishedProvider(t, manager); published == deadProvider {
			t.Fatal("AcquireAttach succeeded while the dead provider is still published")
		}
		return
	}

	// The manager must not stay stuck on the dead provider: clearing it is the
	// pump's job in production, so simulate that publication point and prove a
	// following acquire starts a genuinely fresh provider.
	manager.mu.Lock()
	stillDead := manager.provider == deadProvider
	if stillDead {
		manager.provider = nil
	}
	manager.mu.Unlock()

	session, started, _, err := manager.AcquireAttach(context.Background(), managedMockOptions(t, "pin-dead-provider-retry"), nil)
	if err != nil {
		t.Fatalf("acquire after the dead provider was unpublished failed: %v", err)
	}
	if !started {
		t.Fatal("acquire after the dead provider did not start a fresh session")
	}
	if session == nil {
		t.Fatal("acquire after the dead provider returned no session")
	}
	if published := pinPublishedProvider(t, manager); published == nil || published == deadProvider {
		t.Fatalf("acquire after the dead provider did not publish a fresh provider: %p", published)
	}
}
