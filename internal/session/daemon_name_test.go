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

	if ok := mgr.ApplyDaemonName(sess.ChatID(), "Daemon renamed title"); !ok {
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

	if ok := mgr.ApplyDaemonName("absent-chat", "Daemon renamed title"); ok {
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

	if ok := mgr.ApplyDaemonName(sess.ChatID(), "Daemon replacement"); !ok {
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
