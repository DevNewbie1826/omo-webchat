package wsbridge

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/DevNewbie1826/omo-webchat/internal/adoptcopy"
	"github.com/DevNewbie1826/omo-webchat/internal/cursorstore"
)

func TestPrepareWriteMissingSourceThenExistingBackup(t *testing.T) {
	// Given: an in-place route whose provider has not persisted its file yet.
	dir := t.TempDir()
	store, err := cursorstore.Open(filepath.Join(dir, "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SaveWorkspace(cursorstore.Workspace{ID: "ws", Path: dir}); err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(dir, "session.jsonl")
	if err := store.SaveChat(cursorstore.Chat{
		ID: "chat", WorkspaceID: "ws", CWD: dir, SessionFile: source,
		DurableSessionID: "durable", SessionProvenance: cursorstore.SessionProvenanceInPlace,
	}); err != nil {
		t.Fatal(err)
	}
	cursor := (*CursorStore)(store)
	backupDir := filepath.Join(store.StateDir(), "takeover-backups")

	// When: preparing the first write without pre-existing content.
	if err := cursor.PrepareWrite(t.Context(), "chat"); err != nil {
		t.Fatal(err)
	}
	// Then: there is no snapshot to create.
	if _, err := os.Lstat(backupDir); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("absent source backup directory: %v", err)
	}

	// Given: a subsequent takeover now has persisted content to protect.
	body := "{\"type\":\"session\",\"id\":\"durable\",\"version\":3,\"cwd\":" + string(mustJSON(t, dir)) + "}\n"
	body += "{\"type\":\"message\",\"id\":\"root\",\"parentId\":null,\"message\":{\"role\":\"user\",\"content\":\"persisted\"}}\n"
	if err := os.WriteFile(source, []byte(body), 0600); err != nil {
		t.Fatal(err)
	}
	// When: preparing again with the existing file.
	if err := cursor.PrepareWrite(t.Context(), "chat"); err != nil {
		t.Fatal(err)
	}
	// Then: normal takeover protection preserves all pre-existing bytes.
	backup, err := os.ReadFile(filepath.Join(backupDir, adoptcopy.DestinationName("durable")))
	if err != nil || string(backup) != body {
		t.Fatalf("existing source backup = %q, err=%v", backup, err)
	}
}

func TestPrepareWriteNonInPlaceMissingSource(t *testing.T) {
	// Given: a native chat with no session file yet.
	dir := t.TempDir()
	store, err := cursorstore.Open(filepath.Join(dir, "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SaveWorkspace(cursorstore.Workspace{ID: "ws", Path: dir}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveChat(cursorstore.Chat{
		ID: "chat", WorkspaceID: "ws", CWD: dir,
		SessionFile:       filepath.Join(dir, "absent.jsonl"),
		SessionProvenance: cursorstore.SessionProvenanceNative,
	}); err != nil {
		t.Fatal(err)
	}
	// When: preparing a non-in-place write.
	if err := (*CursorStore)(store).PrepareWrite(t.Context(), "chat"); err != nil {
		t.Fatal(err)
	}
	// Then: takeover protection remains inapplicable.
	if _, err := os.Lstat(filepath.Join(store.StateDir(), "takeover-backups")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("native source backup directory: %v", err)
	}
}
