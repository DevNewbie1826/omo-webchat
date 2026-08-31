package store

import (
	"context"
	"io"
	"log/slog"
	"path/filepath"
	"testing"
)

// TestChatLastUsedAtRoundTrips pins the MRU persistence contract: a chat's
// last-used stamp survives a flush and a full store reload, and a never-used
// chat omits the optional key from the persisted record entirely.
func TestChatLastUsedAtRoundTrips(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	dir, err := StateDir()
	if err != nil {
		t.Fatalf("state dir: %v", err)
	}
	path := filepath.Join(dir, "state.json")
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	st, err := Load(context.Background(), logger)
	if err != nil {
		t.Fatalf("load store: %v", err)
	}
	ws, err := st.CreateWorkspace("mru", home)
	if err != nil {
		t.Fatalf("create workspace: %v", err)
	}
	used, err := st.NewChat(ws.ID, "used", ws.Path, "", "omo")
	if err != nil {
		t.Fatalf("create chat: %v", err)
	}

	// A never-used chat omits the key (zero means never used).
	if raw, ok := mustFields(t, rawChats(t, path)[used.ID])["lastUsedAt"]; ok {
		t.Fatalf("fresh chat emitted lastUsedAt %s, want omitted", raw)
	}

	const stamp = int64(1_234_567_890_123)
	if _, err := st.UpdateChat(ws.ID, used.ID, func(c *Chat) { c.LastUsedAt = stamp }); err != nil {
		t.Fatalf("touch chat: %v", err)
	}
	raw, ok := mustFields(t, rawChats(t, path)[used.ID])["lastUsedAt"]
	if !ok || string(raw) != "1234567890123" {
		t.Fatalf("persisted lastUsedAt = %q (present %t), want 1234567890123", raw, ok)
	}

	reloaded, err := Load(context.Background(), logger)
	if err != nil {
		t.Fatalf("reload store: %v", err)
	}
	got, err := reloaded.GetChat(ws.ID, used.ID)
	if err != nil {
		t.Fatalf("reload chat: %v", err)
	}
	if got.LastUsedAt != stamp {
		t.Fatalf("reloaded lastUsedAt = %d, want %d", got.LastUsedAt, stamp)
	}
}
