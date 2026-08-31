package store

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
)

// legacyDirFixture is a minimal valid state file in the shape store_test.go
// persists: one workspace holding one omo chat. It seeds the legacy
// ~/.terminal-hub/state.json location.
const legacyDirFixture = `{
  "workspaces": [
    {
      "id": "ws-1",
      "name": "legacy-ws",
      "path": "/tmp/legacy",
      "chats": [
        {"id":"chat-1","name":"legacy-chat","piSessionId":"pi-1","wsId":"ws-1","cwd":"/tmp/one","provider":"omo","createdAt":1}
      ]
    }
  ]
}`

// overwrittenFixture replaces the migrated state with a different workspace
// identity, so "new wins" is observable through ListWorkspaces.
const overwrittenFixture = `{
  "workspaces": [
    {
      "id": "ws-2",
      "name": "fresh-ws",
      "path": "/tmp/fresh",
      "chats": [
        {"id":"chat-2","name":"fresh-chat","wsId":"ws-2","cwd":"/tmp/two","provider":"omo","createdAt":2}
      ]
    }
  ]
}`

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// seedLegacyState writes legacyDirFixture to the legacy ~/.terminal-hub
// location under home and returns the legacy path.
func seedLegacyState(t *testing.T, home string) string {
	t.Helper()
	dir := filepath.Join(home, ".terminal-hub")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatalf("create legacy dir: %v", err)
	}
	path := filepath.Join(dir, "state.json")
	if err := os.WriteFile(path, []byte(legacyDirFixture), 0o600); err != nil {
		t.Fatalf("write legacy state: %v", err)
	}
	return path
}

// seedCliWebchatState writes legacyDirFixture to the previous product state
// location under home ($HOME/.local/state/cli-webchat) and returns that path.
func seedCliWebchatState(t *testing.T, home string) string {
	t.Helper()
	dir := filepath.Join(home, ".local", "state", "cli-webchat")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatalf("create cli-webchat state dir: %v", err)
	}
	path := filepath.Join(dir, "state.json")
	if err := os.WriteFile(path, []byte(legacyDirFixture), 0o600); err != nil {
		t.Fatalf("write cli-webchat state: %v", err)
	}
	return path
}

func TestStateDirRespectsXDGStateHome(t *testing.T) {
	// Given
	home := t.TempDir()
	xdg := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_STATE_HOME", xdg)

	// When
	dir, err := StateDir()

	// Then
	if err != nil {
		t.Fatalf("state dir: %v", err)
	}
	if want := filepath.Join(xdg, "omo-webchat"); dir != want {
		t.Fatalf("StateDir() = %q, want %q", dir, want)
	}
}

func TestStateDirDefaultsUnderHome(t *testing.T) {
	// Given
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_STATE_HOME", "")

	// When
	dir, err := StateDir()

	// Then
	if err != nil {
		t.Fatalf("state dir: %v", err)
	}
	if want := filepath.Join(home, ".local", "state", "omo-webchat"); dir != want {
		t.Fatalf("StateDir() = %q, want %q", dir, want)
	}
}

// TestLoadMigratesLegacyState pins the one-way copy: the legacy bytes land
// byte-identical at the new location and the legacy file is left untouched.
func TestLoadMigratesLegacyState(t *testing.T) {
	// Given
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_STATE_HOME", "")
	legacyPath := seedLegacyState(t, home)
	migratedPath := filepath.Join(home, ".local", "state", "omo-webchat", "state.json")

	// When
	st, err := Load(context.Background(), discardLogger())

	// Then
	if err != nil {
		t.Fatalf("load store: %v", err)
	}
	if st == nil {
		t.Fatal("store is nil")
	}
	migrated, err := os.ReadFile(migratedPath)
	if err != nil {
		t.Fatalf("migrated state missing: %v", err)
	}
	if string(migrated) != legacyDirFixture {
		t.Fatalf("migrated state:\n got: %s\nwant: %s", migrated, legacyDirFixture)
	}
	legacy, err := os.ReadFile(legacyPath)
	if err != nil {
		t.Fatalf("legacy state gone: %v", err)
	}
	if string(legacy) != legacyDirFixture {
		t.Fatalf("legacy state mutated:\n%s", legacy)
	}
}

// TestLoadMigrationIsIdempotentAndNewWins proves re-runs do not re-copy over
// a newer state file: once the target exists, the legacy file is ignored.
func TestLoadMigrationIsIdempotentAndNewWins(t *testing.T) {
	// Given — first Load performs the migration
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_STATE_HOME", "")
	seedLegacyState(t, home)
	migratedPath := filepath.Join(home, ".local", "state", "omo-webchat", "state.json")
	if _, err := Load(context.Background(), discardLogger()); err != nil {
		t.Fatalf("first load: %v", err)
	}
	if err := os.WriteFile(migratedPath, []byte(overwrittenFixture), 0o600); err != nil {
		t.Fatalf("overwrite migrated state: %v", err)
	}

	// When — Load runs again with both files present
	st, err := Load(context.Background(), discardLogger())

	// Then — the newer file wins and is not stomped by the legacy copy
	if err != nil {
		t.Fatalf("second load: %v", err)
	}
	listed := st.ListWorkspaces()
	if len(listed) != 1 || listed[0].Name != "fresh-ws" {
		t.Fatalf("ListWorkspaces() = %#v, want single workspace fresh-ws", listed)
	}
	got, err := os.ReadFile(migratedPath)
	if err != nil {
		t.Fatalf("read migrated state: %v", err)
	}
	if string(got) != overwrittenFixture {
		t.Fatalf("migrated state after reload:\n got: %s\nwant: %s", got, overwrittenFixture)
	}
}

// TestLoadMigratesCliWebchatState pins the one-way copy from the previous
// product state dir: seeded $HOME/.local/state/cli-webchat/state.json lands
// byte-identical at omo-webchat and the old file is left untouched.
func TestLoadMigratesCliWebchatState(t *testing.T) {
	// Given
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_STATE_HOME", "")
	oldPath := seedCliWebchatState(t, home)
	migratedPath := filepath.Join(home, ".local", "state", "omo-webchat", "state.json")

	// When
	st, err := Load(context.Background(), discardLogger())

	// Then
	if err != nil {
		t.Fatalf("load store: %v", err)
	}
	if st == nil {
		t.Fatal("store is nil")
	}
	migrated, err := os.ReadFile(migratedPath)
	if err != nil {
		t.Fatalf("migrated state missing: %v", err)
	}
	if string(migrated) != legacyDirFixture {
		t.Fatalf("migrated state:\n got: %s\nwant: %s", migrated, legacyDirFixture)
	}
	old, err := os.ReadFile(oldPath)
	if err != nil {
		t.Fatalf("cli-webchat state gone: %v", err)
	}
	if string(old) != legacyDirFixture {
		t.Fatalf("cli-webchat state mutated:\n%s", old)
	}
}

// TestLoadCliWebchatMigrationNewWins proves a pre-existing omo-webchat
// state.json is never overwritten by an old cli-webchat directory.
func TestLoadCliWebchatMigrationNewWins(t *testing.T) {
	// Given
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_STATE_HOME", "")
	seedCliWebchatState(t, home)
	migratedPath := filepath.Join(home, ".local", "state", "omo-webchat", "state.json")
	if err := os.MkdirAll(filepath.Dir(migratedPath), 0o700); err != nil {
		t.Fatalf("create omo-webchat state dir: %v", err)
	}
	if err := os.WriteFile(migratedPath, []byte(overwrittenFixture), 0o600); err != nil {
		t.Fatalf("seed omo-webchat state: %v", err)
	}

	// When
	st, err := Load(context.Background(), discardLogger())

	// Then — the existing file wins and is not stomped by the cli-webchat copy
	if err != nil {
		t.Fatalf("load store: %v", err)
	}
	listed := st.ListWorkspaces()
	if len(listed) != 1 || listed[0].Name != "fresh-ws" {
		t.Fatalf("ListWorkspaces() = %#v, want single workspace fresh-ws", listed)
	}
	got, err := os.ReadFile(migratedPath)
	if err != nil {
		t.Fatalf("read omo-webchat state: %v", err)
	}
	if string(got) != overwrittenFixture {
		t.Fatalf("omo-webchat state after load:\n got: %s\nwant: %s", got, overwrittenFixture)
	}
}

// TestLoadPrefersCliWebchatOverTerminalHub pins source precedence when both
// fallback locations exist and keeps both source files byte-identical.
func TestLoadPrefersCliWebchatOverTerminalHub(t *testing.T) {
	// Given
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_STATE_HOME", "")
	legacyPath := seedLegacyState(t, home)
	cliPath := seedCliWebchatState(t, home)
	if err := os.WriteFile(cliPath, []byte(overwrittenFixture), 0o600); err != nil {
		t.Fatalf("overwrite cli-webchat state: %v", err)
	}
	legacyBefore, err := os.ReadFile(legacyPath)
	if err != nil {
		t.Fatalf("read seeded legacy state: %v", err)
	}
	cliBefore, err := os.ReadFile(cliPath)
	if err != nil {
		t.Fatalf("read written cli-webchat state: %v", err)
	}
	migratedPath := filepath.Join(home, ".local", "state", "omo-webchat", "state.json")

	// When
	st, err := Load(context.Background(), discardLogger())

	// Then
	if err != nil {
		t.Fatalf("load store: %v", err)
	}
	if st == nil {
		t.Fatal("store is nil")
	}
	migrated, err := os.ReadFile(migratedPath)
	if err != nil {
		t.Fatalf("migrated state missing: %v", err)
	}
	if string(migrated) != string(cliBefore) {
		t.Fatalf("migrated state = %q, want cli-webchat bytes %q", migrated, cliBefore)
	}
	legacyAfter, err := os.ReadFile(legacyPath)
	if err != nil {
		t.Fatalf("legacy state gone: %v", err)
	}
	if string(legacyAfter) != string(legacyBefore) {
		t.Fatalf("legacy state mutated: got %q, want %q", legacyAfter, legacyBefore)
	}
	cliAfter, err := os.ReadFile(cliPath)
	if err != nil {
		t.Fatalf("cli-webchat state gone: %v", err)
	}
	if string(cliAfter) != string(cliBefore) {
		t.Fatalf("cli-webchat state mutated: got %q, want %q", cliAfter, cliBefore)
	}
}

// TestLoadMigratesTerminalHubWhenCliWebchatAbsent pins that a fresh home
// containing only ~/.terminal-hub/state.json still lands in omo-webchat.
func TestLoadMigratesTerminalHubWhenCliWebchatAbsent(t *testing.T) {
	// Given — only the original terminal-hub location exists
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_STATE_HOME", "")
	legacyPath := seedLegacyState(t, home)
	migratedPath := filepath.Join(home, ".local", "state", "omo-webchat", "state.json")
	cliWebchatDir := filepath.Join(home, ".local", "state", "cli-webchat")

	// When
	st, err := Load(context.Background(), discardLogger())

	// Then
	if err != nil {
		t.Fatalf("load store: %v", err)
	}
	if st == nil {
		t.Fatal("store is nil")
	}
	migrated, err := os.ReadFile(migratedPath)
	if err != nil {
		t.Fatalf("migrated state missing: %v", err)
	}
	if string(migrated) != legacyDirFixture {
		t.Fatalf("migrated state:\n got: %s\nwant: %s", migrated, legacyDirFixture)
	}
	legacy, err := os.ReadFile(legacyPath)
	if err != nil {
		t.Fatalf("legacy state gone: %v", err)
	}
	if string(legacy) != legacyDirFixture {
		t.Fatalf("legacy state mutated:\n%s", legacy)
	}
	if _, err := os.Stat(cliWebchatDir); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("cli-webchat state dir should not exist: stat error = %v", err)
	}
}

// TestLoadMigratesCliWebchatStateFromXDGStateHome is the absolute
// XDG_STATE_HOME variant of TestLoadMigratesCliWebchatState.
func TestLoadMigratesCliWebchatStateFromXDGStateHome(t *testing.T) {
	// Given
	home := t.TempDir()
	xdg := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_STATE_HOME", xdg)
	oldDir := filepath.Join(xdg, "cli-webchat")
	if err := os.MkdirAll(oldDir, 0o700); err != nil {
		t.Fatalf("create cli-webchat xdg dir: %v", err)
	}
	oldPath := filepath.Join(oldDir, "state.json")
	if err := os.WriteFile(oldPath, []byte(legacyDirFixture), 0o600); err != nil {
		t.Fatalf("write cli-webchat xdg state: %v", err)
	}
	migratedPath := filepath.Join(xdg, "omo-webchat", "state.json")

	// When
	st, err := Load(context.Background(), discardLogger())

	// Then
	if err != nil {
		t.Fatalf("load store: %v", err)
	}
	if st == nil {
		t.Fatal("store is nil")
	}
	migrated, err := os.ReadFile(migratedPath)
	if err != nil {
		t.Fatalf("migrated state missing: %v", err)
	}
	if string(migrated) != legacyDirFixture {
		t.Fatalf("migrated state:\n got: %s\nwant: %s", migrated, legacyDirFixture)
	}
	old, err := os.ReadFile(oldPath)
	if err != nil {
		t.Fatalf("cli-webchat state gone: %v", err)
	}
	if string(old) != legacyDirFixture {
		t.Fatalf("cli-webchat state mutated:\n%s", old)
	}
}

// TestLoadDirSkipsLegacyMigration pins that an explicit state directory is
// fully independent: a seeded legacy ~/.terminal-hub/state.json is ignored,
// left byte-identical, and the default XDG location is never created.
func TestLoadDirSkipsLegacyMigration(t *testing.T) {
	// Given
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_STATE_HOME", "")
	legacyPath := seedLegacyState(t, home)
	dir := t.TempDir()

	// When
	st, err := LoadDir(dir, discardLogger())

	// Then
	if err != nil {
		t.Fatalf("LoadDir() error = %v", err)
	}
	if listed := st.ListWorkspaces(); len(listed) != 0 {
		t.Fatalf("ListWorkspaces() = %#v, want empty (legacy state must be ignored)", listed)
	}
	legacy, err := os.ReadFile(legacyPath)
	if err != nil {
		t.Fatalf("legacy state gone: %v", err)
	}
	if string(legacy) != legacyDirFixture {
		t.Fatalf("legacy state mutated:\n%s", legacy)
	}
	if _, err := os.Stat(filepath.Join(home, ".local", "state", "omo-webchat")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("default XDG state dir should not exist: stat error = %v", err)
	}
}

func TestLoadWithoutLegacyStartsEmpty(t *testing.T) {
	// Given — a home with no ~/.terminal-hub at all
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_STATE_HOME", "")

	// When
	st, err := Load(context.Background(), discardLogger())

	// Then
	if err != nil {
		t.Fatalf("load store: %v", err)
	}
	if listed := st.ListWorkspaces(); len(listed) != 0 {
		t.Fatalf("ListWorkspaces() = %#v, want empty", listed)
	}
}

// TestStateDirIgnoresRelativeXDGStateHome pins the XDG spec rule that a
// relative XDG_STATE_HOME is invalid and ignored: the home fallback applies
// instead of resolving state relative to the working directory.
func TestStateDirIgnoresRelativeXDGStateHome(t *testing.T) {
	// Given
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_STATE_HOME", "relative/state")

	// When
	dir, err := StateDir()

	// Then
	if err != nil {
		t.Fatalf("state dir: %v", err)
	}
	if want := filepath.Join(home, ".local", "state", "omo-webchat"); dir != want {
		t.Fatalf("StateDir() = %q, want %q (relative XDG_STATE_HOME must be ignored)", dir, want)
	}
}

// TestWriteStateNoClobberLeavesExistingTarget pins the race winner rule: when
// the target already exists (a concurrent creator won), the helper reports
// not-installed and leaves the existing bytes untouched.
func TestWriteStateNoClobberLeavesExistingTarget(t *testing.T) {
	// Given
	dir := t.TempDir()
	path := filepath.Join(dir, "state.json")
	if err := os.WriteFile(path, []byte("existing"), 0o600); err != nil {
		t.Fatalf("seed target: %v", err)
	}

	// When
	installed, err := writeStateNoClobber(path, []byte("migrated"))

	// Then
	if err != nil {
		t.Fatalf("writeStateNoClobber() error = %v", err)
	}
	if installed {
		t.Fatal("writeStateNoClobber() installed = true, want false for existing target")
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read target: %v", err)
	}
	if string(got) != "existing" {
		t.Fatalf("target bytes = %q, want %q (existing state must never be clobbered)", got, "existing")
	}
}

// TestWriteStateNoClobberInstallsWhenAbsent pins the absent-target path: the
// bytes land with 0600, and no temporary leftovers remain in the directory.
func TestWriteStateNoClobberInstallsWhenAbsent(t *testing.T) {
	// Given
	dir := t.TempDir()
	path := filepath.Join(dir, "state.json")

	// When
	installed, err := writeStateNoClobber(path, []byte("migrated"))

	// Then
	if err != nil {
		t.Fatalf("writeStateNoClobber() error = %v", err)
	}
	if !installed {
		t.Fatal("writeStateNoClobber() installed = false, want true for absent target")
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read target: %v", err)
	}
	if string(got) != "migrated" {
		t.Fatalf("target bytes = %q, want %q", got, "migrated")
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat target: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("target mode = %v, want 0600", info.Mode().Perm())
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read dir: %v", err)
	}
	if len(entries) != 1 || entries[0].Name() != "state.json" {
		t.Fatalf("dir holds %v, want only state.json (no temp leftovers)", entries)
	}
}
