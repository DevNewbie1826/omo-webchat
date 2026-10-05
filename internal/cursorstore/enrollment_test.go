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
