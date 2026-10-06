package session

import (
	"context"
	"testing"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

func lockedTitle(s *Session) (string, string) {
	s.lifecycleMu.Lock()
	defer s.lifecycleMu.Unlock()
	return s.title, s.nameSource
}

// IS5 (plan todo 1): a chat whose STORED name is established - here a
// non-placeholder auto name written when the rpc side named the session - must
// not be replaced by the derived first-prompt title when the user sends a
// message. The session was acquired while the stored name was still the
// creation placeholder, so its in-memory title is empty: the pre-fix rule
// synced from the cursor only for NameSourceUser, and therefore derived a new
// title, renamed the provider-side session and overwrote the stored name.
func TestTitleEstablishedStoredNameSurvivesFirstPrompt(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	store := newMemStore()
	const chatID = "established-stored-name"
	placeholder := Cursor{
		DurableSessionID:   "123e4567-e89b-42d3-a456-426614174000",
		Name:               "New session",
		NameSource:         NameSourceAuto,
		TitleIsPlaceholder: true,
	}
	if err := store.SaveCursor(context.Background(), chatID, placeholder); err != nil {
		t.Fatal(err)
	}
	mgr := testManager(t, client, store, 64)
	sub := newRecorder(64)
	sess, _, detach := acquire(t, mgr, testChat{id: chatID, cwd: t.TempDir()}, sub)
	defer detach()
	sub.next(t) // ready
	if title, _ := lockedTitle(sess); title != "" {
		t.Fatalf("placeholder acquisition seeded a title: %q", title)
	}

	// What enrollment does when the rpc side names the session: the stored
	// name becomes established (non-placeholder, auto source) while the chat
	// stays open in webchat.
	established := placeholder
	established.Name, established.NameSource, established.TitleIsPlaceholder = "RPC title", NameSourceAuto, false
	if err := store.SaveCursor(context.Background(), chatID, established); err != nil {
		t.Fatal(err)
	}

	runScript(t, d, sess, "hello world prompt")

	if cur := store.stored(chatID); cur.Name != "RPC title" || cur.NameSource != NameSourceAuto {
		t.Fatalf("first prompt overwrote the established stored name: %+v", cur)
	}
	if got := d.RequestCount(omorpc.CmdSetSessionName); got != 0 {
		t.Fatalf("first prompt renamed the provider session %d times", got)
	}
	for _, frame := range sub.drain() {
		if frame.Kind == FrameName {
			t.Fatalf("first prompt published a replacement name frame: %+v", frame)
		}
	}
	if title, source := lockedTitle(sess); title != "RPC title" || source != NameSourceAuto {
		t.Fatalf("in-memory title = (%q, %q), want the established stored name", title, source)
	}
}

// The counterpart of the guard above: a chat with no established stored name
// (no cursor at all) must still receive the derived first-prompt title.
func TestTitleEstablishedEmptyStoredNameStillDerives(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	store := newMemStore()
	mgr := testManager(t, client, store, 64)
	sub := newRecorder(64)
	sess, _, detach := acquire(t, mgr, testChat{id: "empty-stored-name", cwd: t.TempDir()}, sub)
	defer detach()
	sub.next(t) // ready

	runScript(t, d, sess, "# Ship   the derived title")

	_, frame := sub.await(t, FrameName)
	data, _ := frame.Data.(map[string]any)
	if data["name"] != "Ship the derived title" || data["origin"] != NameSourceAuto {
		t.Fatalf("derived name frame = %+v", frame)
	}
	if cur := store.stored(sess.ChatID()); cur.Name != "Ship the derived title" || cur.NameSource != NameSourceAuto {
		t.Fatalf("stored derived name = %+v", cur)
	}
}
