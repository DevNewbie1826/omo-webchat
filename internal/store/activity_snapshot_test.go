package store

import (
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/DevNewbie1826/omo-webchat/internal/chat"
)

// snapshotFixture plants a typed activitySnapshot pair plus an unknown
// extension field on one chat record, exercising typed round-trip and
// unknown-field preservation side by side.
const snapshotFixture = `{
  "workspaces": [
    {
      "id": "ws-snap",
      "name": "snap",
      "path": "/tmp/snap",
      "chats": [
        {
          "id": "chat-snap",
          "name": "qa",
          "wsId": "ws-snap",
          "cwd": "/tmp/snap",
          "provider": "omo",
          "createdAt": 5,
          "activitySnapshot": {
            "task": {"task": {"id": "st_seed_001", "status": "completed"}},
            "dag": {"dag": {"nodes": [{"id": "st_seed_001", "status": "completed"}], "edges": []}}
          },
          "x-unknown": {"keep": true}
        }
      ]
    }
  ]
}`

// The persisted activitySnapshot pair must round-trip through Load, survive
// unrelated flushes alongside unknown fields, and be replaceable through
// UpdateChat with the replacement still on disk after a reload.
func TestChatActivitySnapshotRoundTrip(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	dir, err := StateDir()
	if err != nil {
		t.Fatalf("state dir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "state.json"), []byte(snapshotFixture), 0o600); err != nil {
		t.Fatalf("write state: %v", err)
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))

	st, err := LoadDir(dir, logger)
	if err != nil {
		t.Fatalf("load store: %v", err)
	}
	loaded, err := st.GetChat("ws-snap", "chat-snap")
	if err != nil {
		t.Fatalf("get chat: %v", err)
	}
	if loaded.ActivitySnapshot == nil {
		t.Fatalf("loaded chat carries no activity snapshot; want the persisted pair")
	}
	var gotTask, wantTask any
	if err := json.Unmarshal(loaded.ActivitySnapshot.Task, &gotTask); err != nil {
		t.Fatalf("persisted task is not valid JSON: %v (%s)", err, loaded.ActivitySnapshot.Task)
	}
	if err := json.Unmarshal([]byte(`{"task":{"id":"st_seed_001","status":"completed"}}`), &wantTask); err != nil {
		t.Fatalf("fixture data is not valid JSON: %v", err)
	}
	if !reflect.DeepEqual(gotTask, wantTask) {
		t.Fatalf("persisted task = %s, want the seeded payload", loaded.ActivitySnapshot.Task)
	}
	var gotDag, wantDag any
	if err := json.Unmarshal(loaded.ActivitySnapshot.Dag, &gotDag); err != nil {
		t.Fatalf("persisted dag is not valid JSON: %v (%s)", err, loaded.ActivitySnapshot.Dag)
	}
	if err := json.Unmarshal([]byte(`{"dag":{"nodes":[{"id":"st_seed_001","status":"completed"}],"edges":[]}}`), &wantDag); err != nil {
		t.Fatalf("fixture data is not valid JSON: %v", err)
	}
	if !reflect.DeepEqual(gotDag, wantDag) {
		t.Fatalf("persisted dag = %s, want the seeded payload", loaded.ActivitySnapshot.Dag)
	}

	// Replace the pair through a normal update; the write must be atomic with
	// the rest of the store and survive a fresh load.
	replacement := chat.ActivitySnapshotPair{
		Task: json.RawMessage(`{"task":{"id":"st_next","status":"completed"}}`),
		Dag:  json.RawMessage(`{"dag":{"nodes":[{"id":"st_next","status":"completed"}],"edges":[]}}`),
	}
	if _, err := st.UpdateChat("ws-snap", "chat-snap", func(c *Chat) {
		next := replacement
		c.ActivitySnapshot = &next
	}); err != nil {
		t.Fatalf("update chat: %v", err)
	}

	reloaded, err := LoadDir(dir, logger)
	if err != nil {
		t.Fatalf("reload store: %v", err)
	}
	after, err := reloaded.GetChat("ws-snap", "chat-snap")
	if err != nil {
		t.Fatalf("get chat after reload: %v", err)
	}
	if after.ActivitySnapshot == nil {
		t.Fatalf("reloaded activity snapshot is nil, want the replacement pair %+v", &replacement)
	}
	// MarshalIndent re-indents raw payloads on disk, so compare semantically.
	var gotReplaced, wantReplaced any
	if err := json.Unmarshal(after.ActivitySnapshot.Task, &gotReplaced); err != nil {
		t.Fatalf("reloaded task is not valid JSON: %v (%s)", err, after.ActivitySnapshot.Task)
	}
	if err := json.Unmarshal(replacement.Task, &wantReplaced); err != nil {
		t.Fatalf("fixture data is not valid JSON: %v", err)
	}
	if !reflect.DeepEqual(gotReplaced, wantReplaced) {
		t.Fatalf("reloaded task = %s, want the replacement payload %s", after.ActivitySnapshot.Task, replacement.Task)
	}
	var unknown struct {
		Keep bool `json:"keep"`
	}
	if err := json.Unmarshal(after.extra["x-unknown"], &unknown); err != nil || !unknown.Keep {
		t.Fatalf("unknown field x-unknown = %s (err %v), want it preserved beside the typed snapshot", after.extra["x-unknown"], err)
	}
}
