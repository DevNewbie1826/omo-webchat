package session

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func TestDeriveSessionTitleMatchesLegacyRules(t *testing.T) {
	for _, test := range []struct{ prompt, want string }{
		{prompt: "  # Build   the thing\nignored", want: "Build the thing"},
		{prompt: "/compact", want: ""},
		{prompt: strings.Repeat("界", 51), want: strings.Repeat("界", 50) + "…"},
	} {
		if got := DeriveSessionTitle(test.prompt); got != test.want {
			t.Fatalf("DeriveSessionTitle(%q) = %q, want %q", test.prompt, got, test.want)
		}
	}
}

func TestOpenIdentityUpdatePreservesConcurrentUserRename(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	store := newMemStore()
	releaseOpen := d.BlockHandler("open_session")
	defer releaseOpen()
	mgr := testManager(t, client, store, 64)
	chat := testChat{id: "rename-during-open", cwd: t.TempDir()}

	done := make(chan error, 1)
	go func() {
		_, _, _, err := mgr.Acquire(context.Background(), chat, nil)
		done <- err
	}()
	if !d.AwaitRequestCount("open_session", 1, testTimeout) {
		t.Fatal("open_session did not block")
	}
	if err := store.UpdateName(context.Background(), chat.id, "User won", NameSourceUser); err != nil {
		t.Fatal(err)
	}
	releaseOpen()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	cur := store.stored(chat.id)
	if cur.Name != "User won" || cur.NameSource != NameSourceUser {
		t.Fatalf("open completion clobbered concurrent rename: %+v", cur)
	}
	if cur.SessionFile == "" || cur.DurableSessionID == "" {
		t.Fatalf("open completion did not persist identity: %+v", cur)
	}
}

func TestCursorFieldUpdatesDoNotClobberOtherFields(t *testing.T) {
	store := newMemStore()
	ctx := context.Background()
	const chatID = "scoped"
	initial := Cursor{SessionFile: "/old", DurableSessionID: "old-id", Name: "Old name", NameSource: NameSourceUser}
	if err := store.SaveCursor(ctx, chatID, initial); err != nil {
		t.Fatal(err)
	}
	if err := store.UpdateIdentity(ctx, chatID, "/new", "new-id"); err != nil {
		t.Fatal(err)
	}
	if got := store.stored(chatID); got.Name != initial.Name || got.NameSource != initial.NameSource {
		t.Fatalf("identity update clobbered name fields: %+v", got)
	}
	if err := store.UpdateName(ctx, chatID, "New name", NameSourceAuto); err != nil {
		t.Fatal(err)
	}
	if got := store.stored(chatID); got.SessionFile != "/new" || got.DurableSessionID != "new-id" {
		t.Fatalf("name update clobbered identity fields: %+v", got)
	}
}

func TestSetSessionNamePersistsAndFramesUserTitle(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	store := newMemStore()
	mgr := testManager(t, client, store, 64)
	sub := newRecorder(16)
	sess, _, _ := acquire(t, mgr, testChat{id: "rename-title", cwd: t.TempDir()}, sub)
	sub.next(t) // ready

	if err := sess.SetSessionName(context.Background(), "User title"); err != nil {
		t.Fatal(err)
	}
	_, frame := sub.await(t, FrameName)
	data, _ := frame.Data.(map[string]any)
	if data["name"] != "User title" || data["origin"] != NameSourceUser {
		t.Fatalf("name frame = %+v", frame)
	}
	if summary, ok := sess.summary(); !ok || summary.Title != "User title" {
		t.Fatalf("summary after rename = %+v", summary)
	}
	if cur := store.stored(sess.ChatID()); cur.Name != "User title" || cur.NameSource != NameSourceUser {
		t.Fatalf("stored name = %+v", cur)
	}
}

func TestDurableOnlyCreationPlaceholderDerivesOnFirstPrompt(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	store := newMemStore()
	if err := store.SaveCursor(context.Background(), "auto-title", Cursor{
		DurableSessionID:   "123e4567-e89b-42d3-a456-426614174000",
		Name:               "workspace",
		NameSource:         NameSourceAuto,
		TitleIsPlaceholder: true,
	}); err != nil {
		t.Fatal(err)
	}
	mgr := testManager(t, client, store, 64)
	sub := newRecorder(16)
	sess, _, _ := acquire(t, mgr, testChat{id: "auto-title", cwd: t.TempDir()}, sub)
	sub.next(t) // ready

	runScript(t, d, sess, "# Ship   naming semantics")
	_, frame := sub.await(t, FrameName)
	data, _ := frame.Data.(map[string]any)
	if data["name"] != "Ship naming semantics" || data["origin"] != NameSourceAuto {
		t.Fatalf("name frame = %+v", frame)
	}
	if cur := store.stored(sess.ChatID()); cur.Name != "Ship naming semantics" || cur.NameSource != NameSourceAuto || cur.TitleIsPlaceholder {
		t.Fatalf("stored name = %+v", cur)
	}
}

func TestDurableOnlyEstablishedAutoTitleSurvivesPlainPrompt(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	store := newMemStore()
	const chatID = "durable-only-established-title"
	if err := store.SaveCursor(context.Background(), chatID, Cursor{
		DurableSessionID: "123e4567-e89b-42d3-a456-426614174000",
		Name:             "Established title",
		NameSource:       NameSourceAuto,
	}); err != nil {
		t.Fatal(err)
	}
	mgr := testManager(t, client, store, 64)
	sub := newRecorder(16)
	sess, _, _ := acquire(t, mgr, testChat{id: chatID, cwd: t.TempDir()}, sub)
	sub.next(t) // ready

	runScript(t, d, sess, "A later plain prompt")
	if cur := store.stored(chatID); cur.Name != "Established title" || cur.NameSource != NameSourceAuto {
		t.Fatalf("established title changed: %+v", cur)
	}
	if summary, ok := sess.summary(); !ok || summary.Title != "Established title" {
		t.Fatalf("summary lost established title: %+v", summary)
	}
	for _, frame := range sub.drain() {
		if frame.Kind == FrameName {
			t.Fatalf("plain prompt emitted replacement name: %+v", frame)
		}
	}
}

func TestStoredAutoTitleSurvivesRestartAndPlainPrompt(t *testing.T) {
	d := newDaemon(t)
	store := newMemStore()
	chat := testChat{id: "stable-auto-title", cwd: t.TempDir()}

	client := dial(t, d)
	mgr := testManager(t, client, store, 64)
	sub := newRecorder(32)
	sess, _, detach := acquire(t, mgr, chat, sub)
	sub.next(t)
	runScript(t, d, sess, "Established title")
	sub.await(t, FrameName)
	detach()
	if err := mgr.CloseAll(context.Background()); err != nil {
		t.Fatal(err)
	}
	_ = client.Close()
	d.Restart()

	client = dial(t, d)
	mgr = testManager(t, client, store, 64)
	sub = newRecorder(32)
	sess, _, _ = acquire(t, mgr, chat, sub)
	sub.next(t)
	sub.await(t, FrameEntries)
	runScript(t, d, sess, "A later plain prompt")
	if got := store.stored(chat.id); got.Name != "Established title" || got.NameSource != NameSourceAuto {
		t.Fatalf("persisted auto title changed after restart: %+v", got)
	}
	if summary, ok := sess.summary(); !ok || summary.Title != "Established title" {
		t.Fatalf("recreated session lost auto title: %+v", summary)
	}
	for _, frame := range sub.drain() {
		if frame.Kind == FrameName {
			t.Fatalf("plain prompt emitted replacement name: %+v", frame)
		}
	}
}

func TestProviderNameOnlyOverwritesAutoSource(t *testing.T) {
	t.Run("auto", func(t *testing.T) {
		d := newDaemon(t)
		client := dial(t, d)
		store := newMemStore()
		mgr := testManager(t, client, store, 64)
		sub := newRecorder(16)
		sess, _, _ := acquire(t, mgr, testChat{id: "provider-auto", cwd: t.TempDir()}, sub)
		sub.next(t) // ready

		injectEvent(t, sess, map[string]any{"type": "session_info_changed", "name": "Provider title"})
		_, frame := sub.await(t, FrameName)
		data, _ := frame.Data.(map[string]any)
		if data["name"] != "Provider title" || data["origin"] != "provider" {
			t.Fatalf("name frame = %+v", frame)
		}
		if cur := store.stored(sess.ChatID()); cur.Name != "Provider title" || cur.NameSource != NameSourceAuto {
			t.Fatalf("stored name = %+v", cur)
		}
	})

	t.Run("user", func(t *testing.T) {
		d := newDaemon(t)
		client := dial(t, d)
		store := newMemStore()
		mgr := testManager(t, client, store, 64)
		sub := newRecorder(16)
		sess, _, _ := acquire(t, mgr, testChat{id: "provider-user", cwd: t.TempDir()}, sub)
		sub.next(t) // ready
		if err := sess.SetSessionName(context.Background(), "User title"); err != nil {
			t.Fatal(err)
		}
		sub.await(t, FrameName)

		injectEvent(t, sess, map[string]any{"type": "session_info_changed", "name": "Provider title"})
		injectEvent(t, sess, map[string]any{"type": "state_changed"})
		prior, _ := sub.await(t, FrameState)
		if counts(prior)[FrameName] != 0 {
			t.Fatalf("provider emitted name after user rename: %+v", prior)
		}
		if cur := store.stored(sess.ChatID()); cur.Name != "User title" || cur.NameSource != NameSourceUser {
			t.Fatalf("stored user name overwritten = %+v", cur)
		}
		if summary, _ := sess.summary(); summary.Title != "User title" {
			t.Fatalf("summary title overwritten = %+v", summary)
		}
	})
}

func TestSummaryCarriesBoundedActivityPairDigestsAndOversizedFlags(t *testing.T) {
	s := &Session{
		chatID:               "v2",
		durableID:            "durable",
		activitySnapshots:    make(map[string]json.RawMessage),
		activityOversized:    make(map[string]bool),
		completedCompactions: make(map[string]struct{}),
	}
	task := map[string]any{"tasks": []any{map[string]any{"task_id": "t1", "status": "running"}}}
	dag := map[string]any{"runs": []any{map[string]any{"run_id": "r1", "status": "running", "nodes": []any{map[string]any{"state": "running", "task_id": "t1"}}}}}
	for name, data := range map[string]any{activitySnapshotOrder[0]: task, activitySnapshotOrder[1]: dag} {
		s.lifecycleMu.Lock()
		s.forwardExtensionEventLocked(map[string]any{"name": name, "data": data})
		s.lifecycleMu.Unlock()
	}
	s.title = DeriveSessionTitle("# Ship v2 summaries")

	summary, ok := s.summary()
	if !ok {
		t.Fatal("summary absent")
	}
	if summary.Title != "Ship v2 summaries" || len(summary.ActivityPair.Task) == 0 || len(summary.ActivityPair.Dag) == 0 {
		t.Fatalf("summary = %+v", summary)
	}
	if summary.TaskDigest == nil || len(summary.TaskDigest.Tasks) != 1 || summary.DagDigest == nil || len(summary.DagDigest.Runs) != 1 {
		t.Fatalf("digests = (%+v, %+v)", summary.TaskDigest, summary.DagDigest)
	}

	oversized := map[string]any{"pad": strings.Repeat("x", maxActivitySnapshotBytes+1)}
	s.lifecycleMu.Lock()
	s.forwardExtensionEventLocked(map[string]any{"name": activitySnapshotOrder[0], "data": oversized})
	s.lifecycleMu.Unlock()
	after, _ := s.summary()
	if !after.TaskOversized {
		t.Fatal("TaskOversized = false")
	}
	if len(after.ActivityPair.Task) > maxActivitySnapshotBytes {
		t.Fatalf("retained task grew to %d bytes", len(after.ActivityPair.Task))
	}
}
