package cursorstore

import (
	"path/filepath"
	"testing"
)

func TestEnrollmentDeletionPersistsOnlyAutoEnrolledTombstones(t *testing.T) {
	for _, auto := range []bool{true, false} {
		name := "native"
		if auto {
			name = "auto-enrolled"
		}
		t.Run(name, func(t *testing.T) {
			// Given: persisted native or automatically enrolled identity.
			path := filepath.Join(t.TempDir(), "state.json")
			store := mustOpen(t, path)
			if err := store.SaveWorkspace(testWorkspace("ws")); err != nil {
				t.Fatal(err)
			}
			chat := testChat("chat", "ws")
			chat.AutoEnrolled, chat.DurableSessionID = auto, "durable"
			if err := store.SaveChat(chat); err != nil {
				t.Fatal(err)
			}
			store = mustOpen(t, path)
			loaded, err := store.GetChat(chat.ID)
			if err != nil || loaded.AutoEnrolled != auto {
				t.Fatalf("AutoEnrolled roundtrip = %+v, %v", loaded, err)
			}
			// When: deleting and reopening the atomic cursor document.
			if err := store.DeleteChat(chat.ID); err != nil {
				t.Fatal(err)
			}
			store = mustOpen(t, path)
			// Then: only automatic enrollment records a durable tombstone.
			if got := store.EnrollmentDeleted("durable"); got != auto {
				t.Fatalf("durable tombstone = %v, want %v", got, auto)
			}
		})
	}
}

func TestRefreshEnrollmentNameRules(t *testing.T) {
	cases := []struct {
		name            string
		source          string
		stored          string
		placeholder     bool
		observed        string
		wantName        string
		wantSource      string
		wantPlaceholder bool
		wantReplaced    bool
	}{
		{name: "placeholder_is_filled", source: NameSourceAuto, stored: "New session", placeholder: true, observed: "Daemon title",
			wantName: "Daemon title", wantSource: NameSourceAuto, wantReplaced: true},
		{name: "placeholder_equal_name_clears_marker", source: NameSourceAuto, stored: "New session", placeholder: true, observed: "New session",
			wantName: "New session", wantSource: NameSourceAuto},
		{name: "auto_is_replaced", source: NameSourceAuto, stored: "Old", observed: "New",
			wantName: "New", wantSource: NameSourceAuto, wantReplaced: true},
		{name: "auto_same_name_is_noop", source: NameSourceAuto, stored: "Same", observed: "Same",
			wantName: "Same", wantSource: NameSourceAuto},
		{name: "user_is_kept", source: NameSourceUser, stored: "User title", observed: "Daemon title",
			wantName: "User title", wantSource: NameSourceUser},
		{name: "legacy_source_is_kept", source: "", stored: "Legacy title", observed: "Daemon title",
			wantName: "Legacy title"},
		{name: "empty_daemon_name_is_ignored", source: NameSourceAuto, stored: "Old", observed: "",
			wantName: "Old", wantSource: NameSourceAuto},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			store := mustOpen(t, filepath.Join(t.TempDir(), "state.json"))
			if err := store.SaveWorkspace(testWorkspace("ws")); err != nil {
				t.Fatal(err)
			}
			chat := testChat("chat", "ws")
			chat.Name, chat.NameSource, chat.TitleIsPlaceholder = tc.stored, tc.source, tc.placeholder
			chat.AutoEnrolled, chat.DurableSessionID = true, "durable"
			if err := store.SaveChat(chat); err != nil {
				t.Fatal(err)
			}
			replaced, err := store.RefreshEnrollment("chat", chat.SessionFile, "durable", tc.observed)
			if err != nil {
				t.Fatal(err)
			}
			got, err := store.GetChat("chat")
			if err != nil {
				t.Fatal(err)
			}
			if replaced != tc.wantReplaced || got.Name != tc.wantName || got.NameSource != tc.wantSource || got.TitleIsPlaceholder != tc.wantPlaceholder {
				t.Fatalf("RefreshEnrollment(%q) = replaced %v, %+v", tc.observed, replaced, got)
			}
		})
	}
}
