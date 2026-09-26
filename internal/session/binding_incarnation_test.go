package session

import (
	"context"
	"encoding/json"
	"sync"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

func incarnationField(t *testing.T, value any) string {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		t.Fatal(err)
	}
	var id string
	if raw := fields["BindingID"]; len(raw) != 0 {
		if err := json.Unmarshal(raw, &id); err != nil {
			t.Fatal(err)
		}
	}
	return id
}

func TestBindingIncarnationLifecycle(t *testing.T) {
	// Given a real manager/provider acquisition, not a socket-local token.
	d := newDaemon(t)
	store := newMemStore()
	m := NewManager(Config{Client: dial(t, d), Store: store})
	t.Cleanup(func() { mustOK(t, m.CloseAll(context.Background())) })
	chat := testChat{id: "incarnation", cwd: t.TempDir()}
	seen := make(map[string]bool)
	var original Cursor
	var originalDurable string
	for _, step := range []string{"X", "same-X", "Y", "X-again"} {
		t.Run(step, func(t *testing.T) {
			if step != "X" {
				mustOK(t, m.Stop(chat.id))
			}
			if step == "Y" || step == "X-again" {
				store.mu.Lock()
				store.cursors[chat.id] = Cursor{}
				if step == "X-again" {
					store.cursors[chat.id] = original
				}
				store.mu.Unlock()
			}
			frames := newRecorder(64)
			s, _, detach := acquire(t, m, chat, frames)
			defer detach()
			_, ready := frames.await(t, FrameReady)
			id := incarnationField(t, ready)
			if id == "" || seen[id] {
				t.Fatalf("binding incarnation missing or reused on %s: %q", step, id)
			}
			seen[id] = true
			if step == "X" {
				original, originalDurable = store.stored(chat.id), s.ID()
			}
			if (step == "same-X" || step == "X-again") && s.ID() != originalDurable {
				t.Fatalf("durable identity changed: %q, want %q", s.ID(), originalDurable)
			}
			if step == "Y" && s.ID() == originalDurable {
				t.Fatal("fixture did not change durable identity")
			}
			// When another subscriber attaches to the same provider binding,
			// all snapshots retain the original incarnation.
			replay := newRecorder(64)
			same, started, detachReplay := acquire(t, m, chat, replay)
			defer detachReplay()
			_, replayReady := replay.await(t, FrameReady)
			if same != s || started || incarnationField(t, replayReady) != id {
				t.Fatal("attaching to a resident binding changed its incarnation")
			}
			rows := m.LiveSummaries()
			if len(rows) != 1 || incarnationField(t, rows[0]) != id {
				t.Fatalf("summary incarnation differs from ready: %+v", rows)
			}
		})
	}
}

func TestBindingIncarnationActivityOriginAndReplay(t *testing.T) {
	// Given a bound session whose emitted frames remain retained by consumers.
	d := newDaemon(t)
	m := NewManager(Config{Client: dial(t, d), Store: newMemStore()})
	t.Cleanup(func() { mustOK(t, m.CloseAll(context.Background())) })
	chat := testChat{id: "buffered-incarnation", cwd: t.TempDir()}
	frames := newRecorder(64)
	s, _, detach := acquire(t, m, chat, frames)
	defer detach()
	_, ready := frames.await(t, FrameReady)
	id := incarnationField(t, ready)
	if id == "" {
		t.Fatal("ready lacks binding incarnation")
	}
	// When task and DAG state is published before the original route retires.
	s.lifecycleMu.Lock()
	for _, name := range []string{"omo.task.updated", "omo.dag.updated", "omo.dag.activity"} {
		s.forwardExtensionEventLocked(map[string]any{"name": name, "data": map[string]any{"tasks": []any{}, "runs": []any{}}})
	}
	s.lifecycleMu.Unlock()
	refresh := s.ActivitySnapshot()
	replay := newRecorder(64)
	detachReplay := s.Attach(replay)
	defer detachReplay()
	replay.await(t, FrameReady)
	buffered := append([]Frame(nil), refresh...)
	for range 3 {
		_, live := frames.await(t, FrameExtensionEvent)
		buffered = append(buffered, live)
	}
	for range 2 {
		_, cached := replay.await(t, FrameExtensionEvent)
		buffered = append(buffered, cached)
	}
	mustOK(t, m.Stop(chat.id))
	replacementFrames := newRecorder(64)
	_, _, detachReplacement := acquire(t, m, chat, replacementFrames)
	defer detachReplacement()
	_, replacementReady := replacementFrames.await(t, FrameReady)
	if next := incarnationField(t, replacementReady); next == "" || next == id {
		t.Fatalf("replacement incarnation = %q; old = %q", next, id)
	}
	// Then retained live, attach replay, and refresh frames keep their origin.
	if len(refresh) != 2 {
		t.Fatalf("refresh frame count = %d", len(refresh))
	}
	for _, frame := range buffered {
		if got := incarnationField(t, frame); got != id {
			t.Fatalf("buffered %s incarnation = %q, want %q", frame.Kind, got, id)
		}
	}
}

func TestBindingIncarnationUniqueAcrossManagerInstances(t *testing.T) {
	// Given identical provider IDs, durable IDs, and chat IDs on two servers.
	data := omorpc.OpenSessionData{SessionID: "route", State: omorpc.SessionState{SessionID: "durable"}}
	first, second := NewManager(Config{}), NewManager(Config{})
	t.Cleanup(func() {
		mustOK(t, first.CloseAll(context.Background()))
		mustOK(t, second.CloseAll(context.Background()))
	})
	// When both managers establish a binding.
	a := newSession(first, "chat", "", data, false, omorpc.EpochToken{})
	b := newSession(second, "chat", "", data, false, omorpc.EpochToken{})
	// Then no deterministic provider/chat identity can recreate an incarnation.
	if a.BindingID() == "" || b.BindingID() == "" || a.BindingID() == b.BindingID() {
		t.Fatalf("manager incarnations collide: %q, %q", a.BindingID(), b.BindingID())
	}
}

func TestBindingIncarnationOverviewQueuedBeforeRebind(t *testing.T) {
	// Given a subscribed overview consumer blocked on its first publication.
	d := newDaemon(t)
	m := NewManager(Config{Client: dial(t, d), Store: newMemStore()})
	t.Cleanup(func() { mustOK(t, m.CloseAll(context.Background())) })
	entered, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	snapshots := make(chan Summary, 8)
	_, unsubscribe := m.SubscribeActivity(true, nil, func(s Summary, _ bool) {
		once.Do(func() { close(entered); <-release })
		snapshots <- s
	})
	defer unsubscribe()
	var releaseOnce sync.Once
	unblock := func() { releaseOnce.Do(func() { close(release) }) }
	defer unblock()
	chat := testChat{id: "queued-incarnation", cwd: t.TempDir()}
	firstFrames := newRecorder(32)
	first, _, detach := acquire(t, m, chat, firstFrames)
	defer detach()
	select {
	case <-entered:
	case <-time.After(testTimeout):
		t.Fatal("overview callback did not start")
	}
	// When the same durable is rebound while the old callback is delayed.
	mustOK(t, m.Stop(chat.id))
	secondFrames := newRecorder(32)
	second, _, detachSecond := acquire(t, m, chat, secondFrames)
	defer detachSecond()
	if first.BindingID() == second.BindingID() {
		t.Fatal("same-durable rebind reused incarnation")
	}
	// Then delayed delivery preserves each publication's own incarnation.
	unblock()
	old := awaitOverview(t, snapshots)
	if old.BindingID != first.BindingID() {
		t.Fatalf("delayed overview incarnation = %q, want %q", old.BindingID, first.BindingID())
	}
	queued := awaitOverview(t, snapshots)
	if queued.BindingID != second.BindingID() {
		t.Fatalf("queued overview incarnation = %q, want %q", queued.BindingID, second.BindingID())
	}
}
