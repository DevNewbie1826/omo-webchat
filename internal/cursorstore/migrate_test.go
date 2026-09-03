package cursorstore

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestLegacySessionCannotOpenInPlaceBeforeMigration(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "legacy.jsonl")
	body := []byte("{\"type\":\"session\",\"id\":\"durable-legacy\",\"version\":3,\"timestamp\":\"2026-09-02T00:00:00Z\",\"cwd\":\"/work\"}\n")
	if err := os.WriteFile(source, body, 0o600); err != nil {
		t.Fatal(err)
	}
	store := mustOpen(t, filepath.Join(dir, "state", "state-v2.json"))
	if err := store.SaveWorkspace(Workspace{ID: "ws", Path: "/work"}); err != nil {
		t.Fatal(err)
	}
	legacy := Chat{ID: "chat", WorkspaceID: "ws", CWD: "/work", SessionFile: source, DurableSessionID: "durable-legacy"}
	if err := store.SaveChat(legacy); err != nil {
		t.Fatal(err)
	}

	if _, err := store.GetChatForOpen("chat"); !errors.Is(err, ErrAdoptionRequired) {
		t.Fatalf("legacy source was openable in place: %v", err)
	}
	migrated, err := store.MigrateLegacySession(context.Background(), "chat")
	if err != nil {
		t.Fatal(err)
	}
	if !IsOwnedSession(migrated, store.OwnedSessionDir()) || migrated.SessionFile == source {
		t.Fatalf("migration did not install an owned copy: %+v", migrated)
	}
	if got, err := os.ReadFile(source); err != nil || !bytes.Equal(got, body) {
		t.Fatalf("legacy source changed: %q, %v", got, err)
	}
	if opened, err := store.GetChatForOpen("chat"); err != nil || opened.SessionFile != migrated.SessionFile {
		t.Fatalf("migrated chat not openable: %+v, %v", opened, err)
	}
}

func TestValidatedInPlaceIdentityBypassesLegacyCopyMigration(t *testing.T) {
	dir := t.TempDir()
	store := mustOpen(t, filepath.Join(dir, "state-v2.json"))
	if err := store.SaveWorkspace(Workspace{ID: "ws"}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveChat(Chat{ID: "chat", WorkspaceID: "ws"}); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "original.jsonl")
	if err := store.UpdateInPlaceIdentity("chat", path, "durable"); err != nil {
		t.Fatal(err)
	}
	opened, err := store.MigrateLegacySession(context.Background(), "chat")
	if err != nil || !IsInPlaceSession(opened) || opened.SessionFile != path {
		t.Fatalf("in-place identity migrated or rejected: %+v, %v", opened, err)
	}
	if _, err := os.Stat(store.OwnedSessionDir()); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("in-place identity created owned copy directory: %v", err)
	}
}

func TestOwnedIdentityRejectsExternalDestination(t *testing.T) {
	dir := t.TempDir()
	store := mustOpen(t, filepath.Join(dir, "state", "state-v2.json"))
	if err := store.SaveWorkspace(Workspace{ID: "ws"}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveChat(Chat{ID: "chat", WorkspaceID: "ws"}); err != nil {
		t.Fatal(err)
	}
	if err := store.UpdateOwnedIdentity("chat", filepath.Join(dir, "external.jsonl"), "durable"); !errors.Is(err, ErrAdoptionRequired) {
		t.Fatalf("external destination accepted as owned: %v", err)
	}
}
