package session

import (
	"context"
	"testing"
	"time"
)

// signalingCursorStore reports every cursor read, so a test can prove that an
// asynchronously dispatched name application has entered the session before it
// asserts the outcome.
type signalingCursorStore struct {
	*memCursorStore
	reads chan string
}

func (s *signalingCursorStore) CursorFor(ctx context.Context, chatID string) (Cursor, error) {
	select {
	case s.reads <- chatID:
	default:
	}
	return s.memCursorStore.CursorFor(ctx, chatID)
}

func awaitCursorRead(t *testing.T, reads <-chan string) string {
	t.Helper()
	select {
	case chatID := <-reads:
		return chatID
	case <-time.After(testTimeout):
		t.Fatal("dispatched name application did not read the cursor")
		return ""
	}
}

func TestApplyDaemonNameRoutesToBoundSession(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	store := newMemStore()
	mgr := testManager(t, client, store, 64)
	sub := newRecorder(16)
	sess, _, detach := acquire(t, mgr, testChat{id: "daemon-name-bound", cwd: t.TempDir()}, sub)
	defer detach()
	sub.next(t) // ready

	if ok := mgr.ApplyDaemonName(sess.ChatID(), "Daemon renamed title", freshTitleObservation(sess)); !ok {
		t.Fatal("ApplyDaemonName did not report the route-bound session")
	}
	_, frame := sub.await(t, FrameName)
	data, _ := frame.Data.(map[string]any)
	if data["name"] != "Daemon renamed title" || data["origin"] != "provider" {
		t.Fatalf("name frame = %+v", frame)
	}
	if cur := store.stored(sess.ChatID()); cur.Name != "Daemon renamed title" || cur.NameSource != NameSourceAuto {
		t.Fatalf("stored name = %+v", cur)
	}
	if summary, ok := sess.summary(); !ok || summary.Title != "Daemon renamed title" {
		t.Fatalf("summary title = %+v", summary)
	}
}

func TestApplyDaemonNameUnknownChatChangesNothing(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	store := newMemStore()
	mgr := testManager(t, client, store, 64)

	if ok := mgr.ApplyDaemonName("absent-chat", "Daemon renamed title", time.Now()); ok {
		t.Fatal("ApplyDaemonName claimed a session for an unknown chat")
	}
	if cur := store.stored("absent-chat"); cur.Name != "" || cur.NameSource != "" {
		t.Fatalf("unknown chat was written: %+v", cur)
	}
	if live := mgr.LiveSummaries(); len(live) != 0 {
		t.Fatalf("unknown chat published summaries: %+v", live)
	}
}

func TestApplyDaemonNameKeepsUserTitle(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	store := &signalingCursorStore{memCursorStore: newMemStore(), reads: make(chan string, 8)}
	mgr := testManager(t, client, store, 64)
	sub := newRecorder(16)
	sess, _, detach := acquire(t, mgr, testChat{id: "daemon-name-user", cwd: t.TempDir()}, sub)
	defer detach()
	sub.next(t) // ready
	if err := sess.SetSessionName(context.Background(), "User title"); err != nil {
		t.Fatal(err)
	}
	sub.await(t, FrameName)

	if ok := mgr.ApplyDaemonName(sess.ChatID(), "Daemon replacement", freshTitleObservation(sess)); !ok {
		t.Fatal("ApplyDaemonName did not report the route-bound session")
	}
	// The dispatched application reads the cursor while holding the session's
	// name lock. Awaiting that read proves it is running, and the rename below
	// blocks on the same lock, so it returns only once the application is done.
	if got := awaitCursorRead(t, store.reads); got != sess.ChatID() {
		t.Fatalf("cursor read for %q, want %q", got, sess.ChatID())
	}
	if err := sess.SetSessionName(context.Background(), "User title"); err != nil {
		t.Fatal(err)
	}

	for _, frame := range sub.drain() {
		if frame.Kind != FrameName {
			continue
		}
		data, _ := frame.Data.(map[string]any)
		if data["origin"] != NameSourceUser {
			t.Fatalf("daemon name replaced a webchat user title: %+v", frame)
		}
	}
	if cur := store.stored(sess.ChatID()); cur.Name != "User title" || cur.NameSource != NameSourceUser {
		t.Fatalf("stored user title = %+v", cur)
	}
	if summary, _ := sess.summary(); summary.Title != "User title" {
		t.Fatalf("summary user title = %+v", summary)
	}
}

// lockedTitleChange reads the instant the session's title last changed.
func lockedTitleChange(s *Session) time.Time {
	s.lifecycleMu.Lock()
	defer s.lifecycleMu.Unlock()
	return s.titleChangedAt
}

// freshTitleObservation returns an observation instant that is strictly later
// than the session's last title change. It is derived from that change rather
// than from a second time.Now() because the freshness check is strict: on a
// coarse clock (Windows timer resolution) two back-to-back wall-clock readings
// can be the same instant, and an equal instant is refused.
func freshTitleObservation(s *Session) time.Time {
	return lockedTitleChange(s).Add(time.Millisecond)
}

// staleTitleObservation returns an observation instant strictly earlier than
// the session's last title change, without sleeping.
func staleTitleObservation(s *Session) time.Time {
	return lockedTitleChange(s).Add(-time.Millisecond)
}

// adoptTitleAfter applies a title change that is strictly later than observedAt
// however coarse the clock is. It mirrors the event path's adoptTitleLocked and
// then pins the ordering a test asserts, which a repeated time.Now() cannot.
func adoptTitleAfter(s *Session, name, source string, observedAt time.Time) {
	s.lifecycleMu.Lock()
	defer s.lifecycleMu.Unlock()
	s.adoptTitleLocked(name, source)
	if !s.titleChangedAt.After(observedAt) {
		s.titleChangedAt = observedAt.Add(time.Millisecond)
	}
}

// awaitNameApplications serializes on the session's name lock, so any name
// application dispatched by an earlier call has finished before the caller
// inspects the session.
func awaitNameApplications(s *Session) {
	s.nameMu.Lock()
	s.nameMu.Unlock()
}

// assertNoNameFrame fails when any published frame carries a name.
func assertNoNameFrame(t *testing.T, sub *recorder) {
	t.Helper()
	for _, got := range sub.drain() {
		if got.Kind == FrameName {
			t.Fatalf("name frame published: %+v", got)
		}
	}
}

// G21: a watcher snapshot read before the session's last title change is stale
// and must not revert the newer name; a snapshot read after it still applies.
func TestApplyDaemonNameRefusesStaleSnapshot(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	store := newMemStore()
	mgr := testManager(t, client, store, 64)
	sub := newRecorder(16)
	sess, _, detach := acquire(t, mgr, testChat{id: "stale-snapshot", cwd: t.TempDir()}, sub)
	defer detach()
	sub.next(t) // ready

	// The rpc event path applies and publishes the newer name.
	injectEvent(t, sess, map[string]any{"type": "session_info_changed", "name": "Event title"})
	_, frame := sub.await(t, FrameName)
	if data, _ := frame.Data.(map[string]any); data["name"] != "Event title" {
		t.Fatalf("event name frame = %+v", frame)
	}
	stale := staleTitleObservation(sess)

	// The watcher read this snapshot before that change, so the route refuses
	// it without dispatching anything.
	if ok := mgr.ApplyDaemonName(sess.ChatID(), "Stale snapshot name", stale); !ok {
		t.Fatal("ApplyDaemonName did not report the route-bound session")
	}
	awaitNameApplications(sess)
	assertNoNameFrame(t, sub)
	assertEventTitleKept(t, sess, store)

	// The same refusal inside the name application, driven synchronously so the
	// assertion cannot depend on goroutine scheduling.
	sess.applyProviderName("Stale snapshot name", stale)
	assertNoNameFrame(t, sub)
	assertEventTitleKept(t, sess, store)

	// A snapshot read after the change is current and still applies.
	if ok := mgr.ApplyDaemonName(sess.ChatID(), "Fresh snapshot name", freshTitleObservation(sess)); !ok {
		t.Fatal("ApplyDaemonName did not report the route-bound session")
	}
	_, fresh := sub.await(t, FrameName)
	if data, _ := fresh.Data.(map[string]any); data["name"] != "Fresh snapshot name" {
		t.Fatalf("fresh name frame = %+v", fresh)
	}
	if cur := store.stored(sess.ChatID()); cur.Name != "Fresh snapshot name" {
		t.Fatalf("fresh snapshot stored name = %+v", cur)
	}
}

// assertEventTitleKept checks that the newer event title survived, in memory,
// in the store and in the published summary.
func assertEventTitleKept(t *testing.T, sess *Session, store *memCursorStore) {
	t.Helper()
	if title, source := lockedTitle(sess); title != "Event title" || source != NameSourceAuto {
		t.Fatalf("in-memory title = (%q, %q), want the event title", title, source)
	}
	if cur := store.stored(sess.ChatID()); cur.Name != "Event title" || cur.NameSource != NameSourceAuto {
		t.Fatalf("stored name = %+v, want the event title", cur)
	}
	if summary, ok := sess.summary(); !ok || summary.Title != "Event title" {
		t.Fatalf("summary title = %+v, want the event title", summary)
	}
}

// gatedUpdateStore holds the daemon-side name application at its durable write
// until the test releases it, so the title change that lands in the async gap
// can be applied deterministically.
type gatedUpdateStore struct {
	*memCursorStore
	entered chan struct{}
	release chan struct{}
}

func (s *gatedUpdateStore) UpdateName(ctx context.Context, chatID, name, source string) error {
	s.entered <- struct{}{}
	<-s.release
	return s.memCursorStore.UpdateName(ctx, chatID, name, source)
}

// G22: the commit-point recheck. Both staleness checks pass, then the title
// changes while the name is being persisted, and the stale name must still
// lose. nameMu serializes the event path against this application, so the test
// applies the event's own title assignment (the same helper the event path
// commits with) at the point where the event would land.
func TestApplyDaemonNameCommitPointRecheckKeepsEventTitle(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	store := &gatedUpdateStore{memCursorStore: newMemStore(), entered: make(chan struct{}, 1), release: make(chan struct{})}
	mgr := testManager(t, client, store, 64)
	sub := newRecorder(16)
	sess, _, detach := acquire(t, mgr, testChat{id: "commit-recheck", cwd: t.TempDir()}, sub)
	defer detach()
	sub.next(t) // ready

	// The snapshot must be current when it is dispatched and stale once the
	// event's title change lands, so both instants come from the session's own
	// title clock: a coarse clock can repeat an instant and the check is strict.
	observedAt := freshTitleObservation(sess)
	if ok := mgr.ApplyDaemonName(sess.ChatID(), "Stale snapshot name", observedAt); !ok {
		t.Fatal("ApplyDaemonName did not report the route-bound session")
	}
	select {
	case <-store.entered:
	case <-time.After(testTimeout):
		t.Fatal("dispatched name application never reached its durable write")
	}

	adoptTitleAfter(sess, "Event title", NameSourceAuto, observedAt)
	close(store.release)

	awaitNameApplications(sess)
	for _, got := range sub.drain() {
		if got.Kind == FrameName {
			t.Fatalf("stale name committed after the event landed: %+v", got)
		}
	}
	if title, source := lockedTitle(sess); title != "Event title" || source != NameSourceAuto {
		t.Fatalf("in-memory title = (%q, %q), want the event title", title, source)
	}
	if summary, ok := sess.summary(); !ok || summary.Title != "Event title" {
		t.Fatalf("summary title = %+v", summary)
	}
}
