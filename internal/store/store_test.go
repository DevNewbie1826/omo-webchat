package store

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// providerFixture persists one chat per provider class plus a layout that
// references the unsupported chat, mirroring the real ~/.terminal-hub backups
// where rebrand migrations destroyed omp and senpi records.
const providerFixture = `{
  "workspaces": [
    {
      "id": "ws-1",
      "name": "demo",
      "path": "/tmp/demo",
      "chats": [
        {"id":"chat-senpi","name":"legacy","piSessionId":"pi-1","wsId":"ws-1","cwd":"/tmp/one","sessionDir":"/tmp/session","provider":"senpi","model":{"name":"model-1"},"createdAt":1,"lastEntryId":"entry-1"},
        {"id":"chat-omo","name":"current","piSessionId":"pi-2","wsId":"ws-1","cwd":"/tmp/two","provider":"omo","createdAt":2},
        {"id":"chat-empty","name":"default","wsId":"ws-1","cwd":"/tmp/three","createdAt":3},
        {"id":"chat-omp","name":"dropped-runtime","piSessionId":"pi-3","wsId":"ws-1","cwd":"/tmp/four","provider":"omp","createdAt":4}
      ]
    }
  ],
  "layout": {"panes":[{"chatId":"chat-omp"}]}
}`

func writeProviderState(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	dir, err := StateDir()
	if err != nil {
		t.Fatalf("state dir: %v", err)
	}
	path := filepath.Join(dir, "state.json")
	if err := os.WriteFile(path, []byte(providerFixture), 0o600); err != nil {
		t.Fatalf("write state: %v", err)
	}
	return path
}

func loadProviderStore(t *testing.T) (*Store, string) {
	t.Helper()
	path := writeProviderState(t)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	st, err := Load(context.Background(), logger)
	if err != nil {
		t.Fatalf("load store: %v", err)
	}
	return st, path
}

// rawChats returns each persisted chat record as raw JSON in file order.
func rawChats(t *testing.T, path string) map[string]json.RawMessage {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read state: %v", err)
	}
	var probe struct {
		Workspaces []struct {
			Chats []json.RawMessage `json:"chats"`
		} `json:"workspaces"`
	}
	if err := json.Unmarshal(raw, &probe); err != nil {
		t.Fatalf("parse state: %v", err)
	}
	out := make(map[string]json.RawMessage)
	for _, ws := range probe.Workspaces {
		for _, c := range ws.Chats {
			var id struct {
				ID string `json:"id"`
			}
			if err := json.Unmarshal(c, &id); err != nil {
				t.Fatalf("parse chat id: %v", err)
			}
			out[id.ID] = c
		}
	}
	return out
}

func rawLayout(t *testing.T, path string) json.RawMessage {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read state: %v", err)
	}
	var probe struct {
		Layout json.RawMessage `json:"layout"`
	}
	if err := json.Unmarshal(raw, &probe); err != nil {
		t.Fatalf("parse state: %v", err)
	}
	return probe.Layout
}

func stateBytes(t *testing.T, path string) []byte {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read state: %v", err)
	}
	return raw
}

// TestLoadPreservesProviderRecordsVerbatim is the anti-regression contract for
// the destructive migration: Load keeps every persisted provider identity and
// every sibling field exactly as written, and never rewrites the state file.
func TestLoadPreservesProviderRecordsVerbatim(t *testing.T) {
	st, path := loadProviderStore(t)

	for id, wantProvider := range map[string]string{
		"chat-senpi": "senpi",
		"chat-omo":   "omo",
		"chat-empty": "",
		"chat-omp":   "omp",
	} {
		got, err := st.GetChat("ws-1", id)
		if err != nil {
			t.Fatalf("raw lookup %s: %v", id, err)
		}
		if got.Provider != wantProvider {
			t.Fatalf("%s provider = %q, want persisted %q", id, got.Provider, wantProvider)
		}
	}

	wantLegacy := Chat{ID: "chat-senpi", Name: "legacy", PiSessionID: "pi-1", WsID: "ws-1", Cwd: "/tmp/one", SessionDir: "/tmp/session", Provider: "senpi", Model: []byte(`{"name":"model-1"}`), CreatedAt: 1, LastEntryID: "entry-1"}
	gotLegacy, err := st.GetChat("ws-1", "chat-senpi")
	if err != nil {
		t.Fatalf("get legacy chat: %v", err)
	}
	if !reflect.DeepEqual(gotLegacy, wantLegacy) {
		t.Fatalf("legacy chat = %#v, want %#v", gotLegacy, wantLegacy)
	}

	if got, want := stateBytes(t, path), []byte(providerFixture); string(got) != string(want) {
		t.Fatalf("Load rewrote the state file:\n got: %s\nwant: %s", got, want)
	}

	// Re-loading is a no-op against the same bytes: no drift, no compounding.
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	if _, err := Load(context.Background(), logger); err != nil {
		t.Fatalf("reload store: %v", err)
	}
	if got := stateBytes(t, path); string(got) != providerFixture {
		t.Fatalf("re-loading rewrote the state file:\n%s", got)
	}
}

// TestWorkspaceListingsProjectLaunchableChats covers every provider class as
// seen by the UI: legacy launchable identities (senpi, empty) are projected to
// omo, canonical omo passes through, and unsupported records are hidden from
// listings while remaining raw-addressable in the store.
func TestWorkspaceListingsProjectLaunchableChats(t *testing.T) {
	st, path := loadProviderStore(t)

	wantChats := []Chat{
		{ID: "chat-senpi", Name: "legacy", PiSessionID: "pi-1", WsID: "ws-1", Cwd: "/tmp/one", SessionDir: "/tmp/session", Provider: "omo", Model: []byte(`{"name":"model-1"}`), CreatedAt: 1000, LastEntryID: "entry-1"},
		{ID: "chat-omo", Name: "current", PiSessionID: "pi-2", WsID: "ws-1", Cwd: "/tmp/two", Provider: "omo", CreatedAt: 2000},
		{ID: "chat-empty", Name: "default", WsID: "ws-1", Cwd: "/tmp/three", Provider: "omo", CreatedAt: 3000},
	}

	listed := st.ListWorkspaces()
	if len(listed) != 1 {
		t.Fatalf("listed %d workspaces, want 1", len(listed))
	}
	if !reflect.DeepEqual(listed[0].Chats, wantChats) {
		t.Fatalf("ListWorkspaces chats = %#v, want %#v", listed[0].Chats, wantChats)
	}

	got, err := st.GetWorkspace("ws-1")
	if err != nil {
		t.Fatalf("get workspace: %v", err)
	}
	if !reflect.DeepEqual(got.Chats, wantChats) {
		t.Fatalf("GetWorkspace chats = %#v, want %#v", got.Chats, wantChats)
	}

	// The projection is read-only: persisted state stays verbatim.
	if got := stateBytes(t, path); string(got) != providerFixture {
		t.Fatalf("listing rewrote the state file:\n%s", got)
	}
	if raw, err := st.GetChat("ws-1", "chat-omp"); err != nil || raw.Provider != "omp" {
		t.Fatalf("raw unsupported lookup = %#v, err %v; want persisted omp record", raw, err)
	}
}

// TestUnsupportedChatSurvivesUnrelatedFlushes proves the byte/data contract:
// flushing the store for unrelated reasons (layout updates, renames) keeps
// unsupported provider records and layout references intact.
func TestLegacyCreatedAtProjectsToMillisecondsWithoutRewritingState(t *testing.T) {
	st, path := loadProviderStore(t)
	before := stateBytes(t, path)

	ws, err := st.GetWorkspace("ws-1")
	if err != nil {
		t.Fatalf("get workspace: %v", err)
	}
	if len(ws.Chats) == 0 || ws.Chats[0].CreatedAt != 1000 {
		t.Fatalf("projected legacy createdAt = %+v, want 1000 milliseconds", ws.Chats)
	}
	raw, err := st.GetChat("ws-1", "chat-senpi")
	if err != nil {
		t.Fatalf("get raw legacy chat: %v", err)
	}
	if raw.CreatedAt != 1 {
		t.Fatalf("raw legacy createdAt = %d, want persisted value 1", raw.CreatedAt)
	}
	if after := stateBytes(t, path); string(after) != string(before) {
		t.Fatalf("read projection rewrote state:\n before: %s\n  after: %s", before, after)
	}
}

func TestUnsupportedChatSurvivesUnrelatedFlushes(t *testing.T) {
	st, path := loadProviderStore(t)

	if err := st.SetLayout(json.RawMessage(`{"panes":[{"chatId":"chat-omp"},{"chatId":"chat-senpi"}]}`)); err != nil {
		t.Fatalf("set layout: %v", err)
	}
	flushOne := rawChats(t, path)
	unsupported, ok := flushOne["chat-omp"]
	if !ok {
		t.Fatal("unsupported chat dropped by layout flush")
	}
	if string(unsupported) == "" {
		t.Fatal("unsupported chat record is empty")
	}

	// A second unrelated flush keeps the unsupported record byte-identical.
	if _, err := st.RenameWorkspace("ws-1", "renamed"); err != nil {
		t.Fatalf("rename workspace: %v", err)
	}
	flushTwo := rawChats(t, path)
	if got := flushTwo["chat-omp"]; string(got) != string(unsupported) {
		t.Fatalf("unsupported record changed across flushes:\n got: %s\nwant: %s", got, unsupported)
	}
	for id, want := range flushOne {
		if id == "chat-omp" {
			continue
		}
		if got := flushTwo[id]; string(got) != string(want) {
			t.Fatalf("record %s changed across flushes:\n got: %s\nwant: %s", id, got, want)
		}
	}

	// Layout data survives the rename flush and still references the
	// unsupported chat.
	var layout struct {
		Panes []struct {
			ChatID string `json:"chatId"`
		} `json:"panes"`
	}
	if err := json.Unmarshal(rawLayout(t, path), &layout); err != nil {
		t.Fatalf("parse layout: %v", err)
	}
	if len(layout.Panes) != 2 || layout.Panes[0].ChatID != "chat-omp" || layout.Panes[1].ChatID != "chat-senpi" {
		t.Fatalf("layout after rename = %#v, want both chat references intact", layout.Panes)
	}

	// A freshly loaded store still exposes the raw unsupported record.
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	reloaded, err := Load(context.Background(), logger)
	if err != nil {
		t.Fatalf("reload store: %v", err)
	}
	raw, err := reloaded.GetChat("ws-1", "chat-omp")
	if err != nil || raw.Provider != "omp" || raw.PiSessionID != "pi-3" {
		t.Fatalf("reloaded unsupported record = %#v, err %v; want verbatim omp record", raw, err)
	}
}

// TestRenameWorkspaceReturnsProjectedCopy pins the projection contract on the
// rename path: the returned copy reports launchable providers and hides
// unsupported chats, while the persisted record keeps its raw identity.
func TestRenameWorkspaceReturnsProjectedCopy(t *testing.T) {
	st, path := loadProviderStore(t)

	renamed, err := st.RenameWorkspace("ws-1", "renamed")
	if err != nil {
		t.Fatalf("rename workspace: %v", err)
	}
	if renamed.Name != "renamed" {
		t.Fatalf("renamed name = %q", renamed.Name)
	}
	for _, c := range renamed.Chats {
		if c.Provider != "omo" {
			t.Fatalf("renamed copy chat %s provider = %q, want projected omo", c.ID, c.Provider)
		}
	}
	if len(renamed.Chats) != 3 {
		t.Fatalf("renamed copy has %d chats, want the 3 launchable ones (unsupported hidden)", len(renamed.Chats))
	}
	if raw, err := st.GetChat("ws-1", "chat-senpi"); err != nil || raw.Provider != "senpi" {
		t.Fatalf("persisted legacy record = %#v, err %v; want provider senpi preserved", raw, err)
	}
	if _, err := st.GetChat("ws-1", "chat-omp"); err != nil {
		t.Fatalf("persisted unsupported record missing after rename: %v", err)
	}
	if len(rawChats(t, path)) != 4 {
		t.Fatalf("state file holds %d chat records after rename, want all 4", len(rawChats(t, path)))
	}
}
