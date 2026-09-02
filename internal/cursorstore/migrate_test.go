package cursorstore

import (
	"bytes"
	"context"
	"encoding/json"
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

func TestMigrateV1MixedRowsIsReadOnlyAndIdempotent(t *testing.T) {
	dir := t.TempDir()
	legacy := filepath.Join(dir, "state.json")
	original := []byte(`{"layout":{"sidebar":true},"workspaces":[{"id":"ws-1","name":"Demo","path":"/work","chats":[{"id":"path","name":"Path","wsId":"ws-1","cwd":"/work","piSessionId":"/sessions/path.jsonl","createdAt":1,"lastUsedAt":4,"provider":"omo","sessionDir":"drop","lastEntryId":"drop","activitySnapshot":{"drop":true},"notices":[{"drop":true}]},{"id":"uuid","name":"UUID","nameSource":"user","wsId":"ws-1","cwd":"/work","piSessionId":"123e4567-e89b-42d3-a456-426614174000","createdAt":2},{"id":"empty","name":"Empty","wsId":"ws-1","cwd":"/work","createdAt":3}]}]}`)
	if err := os.WriteFile(legacy, original, 0o600); err != nil {
		t.Fatal(err)
	}
	dst, err := Open(filepath.Join(dir, "state-v2.json"))
	if err != nil {
		t.Fatal(err)
	}
	summary, err := MigrateV1(legacy, dst)
	if err != nil {
		t.Fatal(err)
	}
	if summary != (MigrationSummary{Workspaces: 1, Chats: 3}) {
		t.Fatalf("summary=%+v", summary)
	}
	path, _ := dst.GetChat("path")
	if path.SessionFile != "/sessions/path.jsonl" || path.DurableSessionID != "" || path.NameSource != NameSourceAuto || path.LastUsedAt != 4 {
		t.Fatalf("path=%+v", path)
	}
	uuid, _ := dst.GetChat("uuid")
	if uuid.SessionFile != "" || uuid.DurableSessionID != "123e4567-e89b-42d3-a456-426614174000" || uuid.NameSource != NameSourceUser {
		t.Fatalf("uuid=%+v", uuid)
	}
	empty, _ := dst.GetChat("empty")
	if empty.SessionFile != "" || empty.DurableSessionID != "" || empty.NameSource != NameSourceAuto {
		t.Fatalf("empty=%+v", empty)
	}
	if string(dst.GetLayout()) != `{"sidebar":true}` {
		t.Fatalf("layout=%s", dst.GetLayout())
	}
	again, err := MigrateV1(legacy, dst)
	if err != nil {
		t.Fatal(err)
	}
	if again != (MigrationSummary{Skipped: 3}) {
		t.Fatalf("again=%+v", again)
	}
	after, err := os.ReadFile(legacy)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(after, original) {
		t.Fatal("migration modified v1 state.json")
	}
}

func TestLoadMigratesCliWebchatState(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_STATE_HOME", "")
	stateDir, err := StateDir()
	if err != nil {
		t.Fatal(err)
	}
	cliPath := filepath.Join(home, ".local", "state", "cli-webchat", "state.json")
	terminalPath := filepath.Join(home, ".terminal-hub", "state.json")
	writeV1Fixture(t, cliPath, "from-cli")
	writeV1Fixture(t, terminalPath, "from-terminal")

	dst, err := Open(filepath.Join(stateDir, "state-v2.json"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := MigrateV1FromStateDir(stateDir, true, dst); err != nil {
		t.Fatal(err)
	}
	if got, err := dst.GetWorkspace("ws"); err != nil || got.Name != "from-cli" {
		t.Fatalf("workspace=%+v err=%v, want cli-webchat source", got, err)
	}
	if _, err := os.Stat(filepath.Join(stateDir, "state.json")); !os.IsNotExist(err) {
		t.Fatalf("migration unexpectedly copied the source: %v", err)
	}
	assertFileExists(t, cliPath)
	assertFileExists(t, terminalPath)
}

func TestLoadMigratesTerminalHubWhenCliWebchatAbsent(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_STATE_HOME", "")
	stateDir, err := StateDir()
	if err != nil {
		t.Fatal(err)
	}
	terminalPath := filepath.Join(home, ".terminal-hub", "state.json")
	writeV1Fixture(t, terminalPath, "from-terminal")

	dst, err := Open(filepath.Join(stateDir, "state-v2.json"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := MigrateV1FromStateDir(stateDir, true, dst); err != nil {
		t.Fatal(err)
	}
	if got, err := dst.GetWorkspace("ws"); err != nil || got.Name != "from-terminal" {
		t.Fatalf("workspace=%+v err=%v, want terminal-hub source", got, err)
	}
	if _, err := os.Stat(filepath.Join(home, ".local", "state", "cli-webchat")); !os.IsNotExist(err) {
		t.Fatalf("migration created cli-webchat directory: %v", err)
	}
	assertFileExists(t, terminalPath)
}

func TestMigrateV1PrefersCurrentState(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_STATE_HOME", "")
	stateDir, err := StateDir()
	if err != nil {
		t.Fatal(err)
	}
	writeV1Fixture(t, filepath.Join(stateDir, "state.json"), "from-omo")
	writeV1Fixture(t, filepath.Join(home, ".local", "state", "cli-webchat", "state.json"), "from-cli")

	dst, err := Open(filepath.Join(stateDir, "state-v2.json"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := MigrateV1FromStateDir(stateDir, true, dst); err != nil {
		t.Fatal(err)
	}
	if got, err := dst.GetWorkspace("ws"); err != nil || got.Name != "from-omo" {
		t.Fatalf("workspace=%+v err=%v, want current omo-webchat source", got, err)
	}
}

func TestMigrateV1PreservesUnsupportedProviderAndHidesItFromListings(t *testing.T) {
	dir := t.TempDir()
	legacy := filepath.Join(dir, "state.json")
	raw := []byte(`{"workspaces":[{"id":"ws","path":"/work","chats":[{"id":"omo","provider":"omo","createdAt":2},{"id":"omp","provider":"omp","createdAt":3}]}]}`)
	if err := os.WriteFile(legacy, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	dst := mustOpen(t, filepath.Join(dir, "state-v2.json"))
	if _, err := MigrateV1(legacy, dst); err != nil {
		t.Fatal(err)
	}
	unsupported, err := dst.GetChat("omp")
	if err != nil || unsupported.Provider != "omp" {
		t.Fatalf("raw unsupported chat=%+v err=%v", unsupported, err)
	}
	listed := dst.ListChats("ws")
	if len(listed) != 1 || listed[0].ID != "omo" {
		t.Fatalf("launchable listing=%+v, want only omo", listed)
	}
	reopened := mustOpen(t, filepath.Join(dir, "state-v2.json"))
	if got, err := reopened.GetChat("omp"); err != nil || got.Provider != "omp" {
		t.Fatalf("reopened unsupported chat=%+v err=%v", got, err)
	}
}

func TestMigrateV1PreservesTimestampsAndOrdersMixedResolutionMRU(t *testing.T) {
	dir := t.TempDir()
	legacy := filepath.Join(dir, "state.json")
	raw := []byte(`{"workspaces":[{"id":"ws","path":"/work","chats":[{"id":"seconds","createdAt":1600000000,"lastUsedAt":1800000000},{"id":"millis","createdAt":1600000000000,"lastUsedAt":1700000000000}]}]}`)
	if err := os.WriteFile(legacy, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	dst := mustOpen(t, filepath.Join(dir, "state-v2.json"))
	if _, err := MigrateV1(legacy, dst); err != nil {
		t.Fatal(err)
	}
	seconds, _ := dst.GetChat("seconds")
	if seconds.CreatedAt != 1600000000 || seconds.LastUsedAt != 1800000000 {
		t.Fatalf("timestamps rewritten: %+v", seconds)
	}
	listed := dst.ListChats("ws")
	if len(listed) != 2 || listed[0].ID != "seconds" {
		t.Fatalf("mixed-resolution MRU=%+v, want seconds first", listed)
	}
}

func TestMigrateV1CoversLegacyFallbacksAndExistingDestination(t *testing.T) {
	dir := t.TempDir()
	legacy := filepath.Join(dir, "state.json")
	raw := []byte(`{"layout":{"legacy":true},"workspaces":[{"id":"ws","name":"legacy","path":"/legacy","terminals":[{"id":"terminal","name":"Terminal","nameSource":"default","piSessionId":"123e4567-e89b-42d3-a456-426614174000","createdAt":7}]}]}`)
	if err := os.WriteFile(legacy, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	dst := mustOpen(t, filepath.Join(dir, "state-v2.json"))
	if err := dst.SaveWorkspace(Workspace{ID: "ws", Name: "existing", Path: "/existing"}); err != nil {
		t.Fatal(err)
	}
	if err := dst.SetLayout(json.RawMessage(`{"existing":true}`)); err != nil {
		t.Fatal(err)
	}
	summary, err := MigrateV1(legacy, dst)
	if err != nil {
		t.Fatal(err)
	}
	if summary != (MigrationSummary{Chats: 1}) {
		t.Fatalf("summary=%+v", summary)
	}
	if ws, _ := dst.GetWorkspace("ws"); ws.Name != "existing" || ws.Path != "/existing" {
		t.Fatalf("existing workspace overwritten: %+v", ws)
	}
	if got := string(dst.GetLayout()); got != `{"existing":true}` {
		t.Fatalf("existing layout overwritten: %s", got)
	}
	chat, err := dst.GetChat("terminal")
	if err != nil {
		t.Fatal(err)
	}
	if chat.WorkspaceID != "ws" || chat.CWD != "/legacy" || chat.NameSource != NameSourceAuto || chat.DurableSessionID == "" {
		t.Fatalf("terminal fallback migration=%+v", chat)
	}
}

func writeV1Fixture(t *testing.T, path, workspaceName string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(legacyState{Workspaces: []legacyWorkspace{{ID: "ws", Name: workspaceName, Path: "/work"}}})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
}

func assertFileExists(t *testing.T, path string) {
	t.Helper()
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("source %s was changed or removed: %v", path, err)
	}
}
