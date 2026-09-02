package cursorstore

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

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
