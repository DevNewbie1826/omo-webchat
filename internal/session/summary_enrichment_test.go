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

func TestFirstPromptAutoTitlePersistsAndFrames(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	store := newMemStore()
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
	if cur := store.stored(sess.ChatID()); cur.Name != "Ship naming semantics" || cur.NameSource != NameSourceAuto {
		t.Fatalf("stored name = %+v", cur)
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
