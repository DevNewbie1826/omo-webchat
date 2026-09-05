package main

import (
	"testing"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc/omorpctest"
)

// Frontend parseEntries (frontend/src/features/split/chatEntries.ts) only
// renders type=message entries that carry nested message.role / message.content.
// Flat role/content on the entry itself is skipped, so the pane stays empty.
func requireRenderableHistoryEntry(t *testing.T, raw any, id string, parent any, role, content string) {
	t.Helper()
	entry, ok := raw.(map[string]any)
	if !ok {
		t.Fatalf("entry %s is %T, want object", id, raw)
	}
	if entry["type"] != "message" {
		t.Fatalf("entry %s type=%v want message", id, entry["type"])
	}
	if entry["id"] != id {
		t.Fatalf("entry id=%v want %s", entry["id"], id)
	}
	if entry["parentId"] != parent {
		t.Fatalf("entry %s parentId=%v want %v", id, entry["parentId"], parent)
	}
	if _, flat := entry["role"]; flat {
		t.Fatalf("entry %s has flat role/content; frontend parseEntries reads entry.message", id)
	}
	message, ok := entry["message"].(map[string]any)
	if !ok {
		t.Fatalf("entry %s message=%#v, want nested object with role/content", id, entry["message"])
	}
	if message["role"] != role {
		t.Fatalf("entry %s message.role=%v want %s", id, message["role"], role)
	}
	if message["content"] != content {
		t.Fatalf("entry %s message.content=%v want %s", id, message["content"], content)
	}
}

func (f *fixture) getEntries(rpc string) (entries []any, leafID string) {
	f.t.Helper()
	var data map[string]any
	f.callData(f.lead, omorpc.GetEntries{SessionID: rpc}, &data)
	raw, _ := data["entries"].([]any)
	leaf, _ := data["leafId"].(string)
	return raw, leaf
}

func (f *fixture) snapshot(path string) omorpctest.SessionSnapshot {
	f.t.Helper()
	for _, snap := range f.daemon.SessionSnapshots() {
		if snap.Path == path {
			return snap
		}
	}
	f.t.Fatalf("no snapshot for %s", path)
	return omorpctest.SessionSnapshot{}
}

func TestHistorySeedGetEntriesEmitsNestedMessageContent(t *testing.T) {
	// Given: a live chat whose durable identity and CWD are already minted.
	f := startFixture(t)
	before := f.snapshot(f.pathA)
	if before.Path != f.pathA || before.DurableID == "" || before.CWD == "" {
		t.Fatalf("setup snapshot path=%q durable=%q cwd=%q", before.Path, before.DurableID, before.CWD)
	}

	// When: HTTP /history seeds two durable entries and the client reads them via get_entries.
	f.seedHistory(f.pathA, 2)
	entries, leafID := f.getEntries(f.rpcA)
	if len(entries) != 2 {
		t.Fatalf("get_entries count=%d want 2", len(entries))
	}
	if leafID != "entry-2" {
		t.Fatalf("leafId=%q want entry-2", leafID)
	}

	// Then: each entry is the canonical nested message shape the frontend can render.
	requireRenderableHistoryEntry(t, entries[0], "entry-1", nil, "user", "fixture-entry-1")
	requireRenderableHistoryEntry(t, entries[1], "entry-2", "entry-1", "assistant", "fixture-entry-2")

	after := f.snapshot(f.pathA)
	if after.Path != before.Path || after.DurableID != before.DurableID || after.CWD != before.CWD {
		t.Fatalf("history seed mutated identity path=%q durable=%q cwd=%q", after.Path, after.DurableID, after.CWD)
	}
	if after.LeafID != "entry-2" || after.EntryCount != 2 {
		t.Fatalf("snapshot leaf=%q count=%d", after.LeafID, after.EntryCount)
	}
}

func TestPromptAppendsNestedMessageContent(t *testing.T) {
	// Given: one seeded user turn already on the durable transcript.
	f := startFixture(t)
	f.seedHistory(f.pathA, 1)
	before := f.snapshot(f.pathA)

	// When: an accepted prompt appends through the same mock persistence path.
	f.call(f.lead, omorpc.Prompt{SessionID: f.rpcA, Message: "prompt-appended"})
	entries, leafID := f.getEntries(f.rpcA)
	if len(entries) != 2 {
		t.Fatalf("get_entries count=%d want 2", len(entries))
	}
	if leafID != "entry-2" {
		t.Fatalf("leafId=%q want entry-2", leafID)
	}

	// Then: the prompt-appended user message is also nested, with parent linked to the seed.
	requireRenderableHistoryEntry(t, entries[0], "entry-1", nil, "user", "fixture-entry-1")
	requireRenderableHistoryEntry(t, entries[1], "entry-2", "entry-1", "user", "prompt-appended")

	after := f.snapshot(f.pathA)
	if after.Path != before.Path || after.DurableID != before.DurableID || after.CWD != before.CWD {
		t.Fatalf("prompt mutated identity path=%q durable=%q cwd=%q", after.Path, after.DurableID, after.CWD)
	}
	if after.LeafID != "entry-2" || after.EntryCount != 2 {
		t.Fatalf("snapshot leaf=%q count=%d", after.LeafID, after.EntryCount)
	}
}
