package store

import (
	"encoding/json"
	"log/slog"
	"path/filepath"
	"testing"
)

func TestNewChatSetsDefaultNameSource(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	st := &Store{path: filepath.Join(home, "state.json"), logger: slog.Default(), data: state{Workspaces: []Workspace{{ID: "ws-1", Path: "/tmp/demo"}}}}

	got, err := st.NewChat("ws-1", "demo-1", "/tmp/demo", "", "omo")
	if err != nil {
		t.Fatalf("new chat: %v", err)
	}
	if got.NameSource != "default" {
		t.Fatalf("name source = %q, want %q", got.NameSource, "default")
	}
}

func TestLegacyChatNameSourceDefaultsToEmpty(t *testing.T) {
	var got Chat
	if err := json.Unmarshal([]byte(`{"id":"chat-1","name":"legacy"}`), &got); err != nil {
		t.Fatalf("unmarshal legacy chat: %v", err)
	}
	if got.NameSource != "" {
		t.Fatalf("legacy name source = %q, want empty", got.NameSource)
	}
}

func TestUpdateChatSetsNameAndNameSourceTogether(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	st := &Store{path: filepath.Join(home, "state.json"), logger: slog.Default(), data: state{Workspaces: []Workspace{{ID: "ws-1", Path: "/tmp/demo"}}}}
	if err := st.AddChat("ws-1", Chat{ID: "chat-1", Name: "demo-1", WsID: "ws-1"}); err != nil {
		t.Fatalf("add chat: %v", err)
	}

	got, err := st.UpdateChat("ws-1", "chat-1", func(c *Chat) {
		c.Name = "A title"
		c.NameSource = "auto"
	})
	if err != nil {
		t.Fatalf("update chat: %v", err)
	}
	if got.Name != "A title" || got.NameSource != "auto" {
		t.Fatalf("updated chat = %#v, want name and source updated", got)
	}
}
