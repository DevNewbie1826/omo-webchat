package store

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// extraFieldsFixture seeds forward/provider-specific fields of every JSON
// shape (nested objects, arrays, scalars, null) at state, workspace, and chat
// level, including on an unsupported provider record. None of these keys are
// part of the typed schema; every one must survive Load, unrelated flushes,
// and reload semantically intact.
const extraFieldsFixture = `{
  "schemaVersion": 3,
  "workspaces": [
    {
      "id": "ws-x",
      "name": "extras",
      "path": "/tmp/x",
      "wsMeta": {"tabs": [1, {"active": true}], "note": null, "depth": {"deeper": ["s", false, 2.5]}},
      "wsOrder": 7,
      "chats": [
        {
          "id": "chat-extra",
          "name": "carrier",
          "wsId": "ws-x",
          "cwd": "/tmp/x",
          "provider": "omo",
          "model": {"name": "m-1"},
          "createdAt": 7,
          "x-caps": {"tools": ["shell", "fs"], "limits": {"ctx": 128, "temp": 0.5}},
          "x-tags": ["a", "b", 3, null],
          "x-count": 42,
          "x-ratio": 3.5,
          "x-enabled": true,
          "x-empty": "",
          "x-null": null
        },
        {
          "id": "chat-plain",
          "name": "plain",
          "wsId": "ws-x",
          "cwd": "/tmp/x",
          "createdAt": 8
        },
        {
          "id": "chat-foreign",
          "name": "foreign",
          "wsId": "ws-x",
          "cwd": "/tmp/x",
          "provider": "omp",
          "createdAt": 9,
          "x-foreign-config": {"endpoint": "unix:///run/omp.sock", "flags": ["--deep", "--fast"], "retries": 3}
        }
      ]
    }
  ],
  "layout": {"panes": [{"chatId": "chat-extra"}]}
}`

func loadExtraStore(t *testing.T) (*Store, string) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	dir, err := StateDir()
	if err != nil {
		t.Fatalf("state dir: %v", err)
	}
	path := filepath.Join(dir, "state.json")
	if err := os.WriteFile(path, []byte(extraFieldsFixture), 0o600); err != nil {
		t.Fatalf("write state: %v", err)
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	st, err := Load(context.Background(), logger)
	if err != nil {
		t.Fatalf("load store: %v", err)
	}
	return st, path
}

// roundtripKnownKeys mirrors the typed schema at each level so tests can
// subtract the known fields and compare only what the schema does not own.
var (
	roundtripChatKeys = map[string]bool{
		"id": true, "name": true, "pisessionid": true, "wsid": true, "cwd": true,
		"sessiondir": true, "provider": true, "model": true, "createdat": true,
		"lastusedat": true, "lastentryid": true,
	}
	roundtripWorkspaceKeys = map[string]bool{
		"id": true, "name": true, "path": true, "chats": true, "terminals": true,
	}
	roundtripStateKeys = map[string]bool{"workspaces": true, "layout": true}
)

// unknownValues returns the semantic value of every non-known key in a raw
// JSON record, so comparisons are order- and whitespace-insensitive.
func unknownValues(t *testing.T, raw json.RawMessage, known map[string]bool) map[string]any {
	t.Helper()
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		t.Fatalf("parse record: %v", err)
	}
	out := make(map[string]any, len(fields))
	for k, v := range fields {
		if known[strings.ToLower(k)] {
			continue
		}
		var val any
		if err := json.Unmarshal(v, &val); err != nil {
			t.Fatalf("parse field %s: %v", k, err)
		}
		out[k] = val
	}
	return out
}

// seedUnknowns parses the original raw JSON fixture and returns the unknown
// field sets that every later read of the state file must still carry.
type seededUnknowns struct {
	state     map[string]any
	workspace map[string]any
	chatsByID map[string]map[string]any
}

func seedUnknowns(t *testing.T, raw []byte) seededUnknowns {
	t.Helper()
	var doc map[string]json.RawMessage
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("parse fixture: %v", err)
	}
	var wsRaw []json.RawMessage
	if err := json.Unmarshal(doc["workspaces"], &wsRaw); err != nil {
		t.Fatalf("parse fixture workspaces: %v", err)
	}
	var wsFields struct {
		Chats []json.RawMessage `json:"chats"`
	}
	if err := json.Unmarshal(wsRaw[0], &wsFields); err != nil {
		t.Fatalf("parse fixture workspace: %v", err)
	}
	seed := seededUnknowns{
		state:     unknownValues(t, raw, roundtripStateKeys),
		workspace: unknownValues(t, wsRaw[0], roundtripWorkspaceKeys),
		chatsByID: make(map[string]map[string]any),
	}
	for _, c := range wsFields.Chats {
		var probe struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal(c, &probe); err != nil {
			t.Fatalf("parse fixture chat: %v", err)
		}
		seed.chatsByID[probe.ID] = unknownValues(t, c, roundtripChatKeys)
	}
	return seed
}

func rawState(t *testing.T, path string) map[string]json.RawMessage {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read state: %v", err)
	}
	var doc map[string]json.RawMessage
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("parse state: %v", err)
	}
	return doc
}

func rawWorkspaceByID(t *testing.T, path, id string) json.RawMessage {
	t.Helper()
	doc := rawState(t, path)
	var wss []json.RawMessage
	if err := json.Unmarshal(doc["workspaces"], &wss); err != nil {
		t.Fatalf("parse workspaces: %v", err)
	}
	for _, ws := range wss {
		var probe struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal(ws, &probe); err != nil {
			t.Fatalf("parse workspace: %v", err)
		}
		if probe.ID == id {
			return ws
		}
	}
	t.Fatalf("workspace %s not found in state file", id)
	return nil
}

// assertUnknownsIntact verifies the freshly flushed state file still carries
// every seeded unknown field, semantically, at every level.
func assertUnknownsIntact(t *testing.T, path string, seed seededUnknowns) {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read state: %v", err)
	}
	if got := unknownValues(t, raw, roundtripStateKeys); !reflect.DeepEqual(got, seed.state) {
		t.Fatalf("state-level unknown fields = %#v, want %#v", got, seed.state)
	}
	wsRecord := rawWorkspaceByID(t, path, "ws-x")
	if got := unknownValues(t, wsRecord, roundtripWorkspaceKeys); !reflect.DeepEqual(got, seed.workspace) {
		t.Fatalf("workspace-level unknown fields = %#v, want %#v", got, seed.workspace)
	}
	persisted := rawChats(t, path)
	for id, want := range seed.chatsByID {
		rec, ok := persisted[id]
		if !ok {
			t.Fatalf("chat %s dropped from state file", id)
		}
		if got := unknownValues(t, rec, roundtripChatKeys); !reflect.DeepEqual(got, want) {
			t.Fatalf("chat %s unknown fields = %#v, want %#v", id, got, want)
		}
	}
}

// reloadExtraStore flushes nothing; it loads a second store from the same
// HOME the previous loadExtraStore call set, sharing the state file.
func reloadExtraStore(t *testing.T) *Store {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	st, err := Load(context.Background(), logger)
	if err != nil {
		t.Fatalf("reload store: %v", err)
	}
	return st
}

// TestUnknownFieldsSurviveUnrelatedFlushes is the forward-compatibility
// contract: unknown nested/scalar/array fields at state, workspace, and chat
// level - including on an unsupported provider record - survive layout
// writes, workspace renames, sibling chat writes, flushes, and reloads
// semantically, while known typed fields stay authoritative and unsupported
// records stay hidden from projections but raw-addressable.
func TestUnknownFieldsSurviveUnrelatedFlushes(t *testing.T) {
	st, path := loadExtraStore(t)
	seed := seedUnknowns(t, []byte(extraFieldsFixture))

	// Unrelated flush 1: a layout write.
	if err := st.SetLayout(json.RawMessage(`{"panes":[{"chatId":"chat-extra"},{"chatId":"chat-foreign"}]}`)); err != nil {
		t.Fatalf("set layout: %v", err)
	}
	assertUnknownsIntact(t, path, seed)

	// Unrelated flush 2: a workspace rename.
	if _, err := st.RenameWorkspace("ws-x", "renamed-extras"); err != nil {
		t.Fatalf("rename workspace: %v", err)
	}
	assertUnknownsIntact(t, path, seed)

	// Unrelated flush 3: a sibling chat write.
	if _, err := st.UpdateChat("ws-x", "chat-plain", func(c *Chat) { c.Name = "plain-renamed" }); err != nil {
		t.Fatalf("update sibling chat: %v", err)
	}
	assertUnknownsIntact(t, path, seed)

	// Known typed fields stay authoritative across writes and reloads: a
	// rename of the carrier chat lands while its unknowns ride along.
	if _, err := st.UpdateChat("ws-x", "chat-extra", func(c *Chat) { c.Name = "renamed-carrier" }); err != nil {
		t.Fatalf("rename carrier chat: %v", err)
	}
	reloaded := reloadExtraStore(t)
	got, err := reloaded.GetChat("ws-x", "chat-extra")
	if err != nil {
		t.Fatalf("reload carrier chat: %v", err)
	}
	if got.Name != "renamed-carrier" {
		t.Fatalf("reloaded carrier name = %q, want known-field update", got.Name)
	}
	assertUnknownsIntact(t, path, seed)

	// Sibling known-field update survived too.
	plain, err := reloaded.GetChat("ws-x", "chat-plain")
	if err != nil || plain.Name != "plain-renamed" {
		t.Fatalf("reloaded sibling = %#v, err %v; want renamed plain chat", plain, err)
	}

	// Unsupported provider records stay hidden from projections but remain
	// raw-addressable with their unknowns intact.
	for _, ws := range reloaded.ListWorkspaces() {
		for _, c := range ws.Chats {
			if c.ID == "chat-foreign" {
				t.Fatal("unsupported chat leaked into workspace listing")
			}
		}
	}
	foreign, err := reloaded.GetChat("ws-x", "chat-foreign")
	if err != nil || foreign.Provider != "omp" {
		t.Fatalf("raw unsupported lookup = %#v, err %v; want verbatim omp record", foreign, err)
	}

	// The layout flush kept its references, including to the hidden record.
	var layout struct {
		Panes []struct {
			ChatID string `json:"chatId"`
		} `json:"panes"`
	}
	if err := json.Unmarshal(rawLayout(t, path), &layout); err != nil {
		t.Fatalf("parse layout: %v", err)
	}
	if len(layout.Panes) != 2 || layout.Panes[0].ChatID != "chat-extra" || layout.Panes[1].ChatID != "chat-foreign" {
		t.Fatalf("layout after flushes = %#v, want both references intact", layout.Panes)
	}
}

// TestChatWritesKeepOmitEmptyContract pins the typed-field half of the
// contract: optional known fields are written when set, omitted when empty,
// and clearing them never disturbs the carried unknowns.
func TestChatWritesKeepOmitEmptyContract(t *testing.T) {
	st, path := loadExtraStore(t)
	seed := seedUnknowns(t, []byte(extraFieldsFixture))
	optional := []string{"piSessionId", "sessionDir", "provider", "model", "lastEntryId"}

	// A chat that never carried optional fields keeps them absent.
	if _, err := st.UpdateChat("ws-x", "chat-plain", func(c *Chat) { c.Name = "plain-2" }); err != nil {
		t.Fatalf("update plain chat: %v", err)
	}
	rec := rawChats(t, path)["chat-plain"]
	for _, key := range optional {
		if _, ok := mustFields(t, rec)[key]; ok {
			t.Fatalf("plain chat emitted empty optional key %q: %s", key, rec)
		}
	}

	// Setting optional fields persists them with their values.
	if _, err := st.UpdateChat("ws-x", "chat-plain", func(c *Chat) {
		c.PiSessionID = "pi-9"
		c.SessionDir = "/tmp/s9"
		c.Provider = "omo"
		c.LastEntryID = "e-9"
		c.Model = json.RawMessage(`{"name":"m-9"}`)
	}); err != nil {
		t.Fatalf("set optional fields: %v", err)
	}
	rec = rawChats(t, path)["chat-plain"]
	fields := mustFields(t, rec)
	for _, key := range optional {
		if _, ok := fields[key]; !ok {
			t.Fatalf("set optional key %q missing from record: %s", key, rec)
		}
	}
	var model struct {
		Name string `json:"name"`
	}
	if err := json.Unmarshal(fields["model"], &model); err != nil || model.Name != "m-9" {
		t.Fatalf("model = %s, err %v; want semantic name m-9", fields["model"], err)
	}
	if got := string(fields["piSessionId"]); got != `"pi-9"` {
		t.Fatalf("piSessionId = %s", got)
	}

	// Clearing them omits the keys again, unknowns untouched.
	if _, err := st.UpdateChat("ws-x", "chat-plain", func(c *Chat) {
		c.PiSessionID = ""
		c.SessionDir = ""
		c.Provider = ""
		c.LastEntryID = ""
		c.Model = nil
	}); err != nil {
		t.Fatalf("clear optional fields: %v", err)
	}
	rec = rawChats(t, path)["chat-plain"]
	for _, key := range optional {
		if _, ok := mustFields(t, rec)[key]; ok {
			t.Fatalf("cleared optional key %q still emitted: %s", key, rec)
		}
	}
	assertUnknownsIntact(t, path, seed)

	// Values survive a reload through the typed getters.
	reloaded := reloadExtraStore(t)
	got, err := reloaded.GetChat("ws-x", "chat-plain")
	if err != nil {
		t.Fatalf("reload plain chat: %v", err)
	}
	if got.Name != "plain-2" || got.PiSessionID != "" || got.Model != nil {
		t.Fatalf("reloaded plain chat = %#v, want cleared optionals and renamed known field", got)
	}
	carrier, err := reloaded.GetChat("ws-x", "chat-extra")
	if err != nil {
		t.Fatalf("reload carrier: %v", err)
	}
	var carrierModel struct {
		Name string `json:"name"`
	}
	if err := json.Unmarshal(carrier.Model, &carrierModel); err != nil || carrierModel.Name != "m-1" || carrier.Provider != "omo" {
		t.Fatalf("reloaded carrier model = %s, provider = %q, err %v", carrier.Model, carrier.Provider, err)
	}
}

// TestKnownFieldsOverrideCapturedExtras proves typed fields are authoritative
// even if an in-package caller accidentally injects a colliding extra key.
// Empty typed values also retain their omitempty behavior instead of reviving
// a stale colliding extra.
func TestKnownFieldsOverrideCapturedExtras(t *testing.T) {
	c := Chat{
		ID:        "chat-authority",
		Name:      "typed-name",
		WsID:      "ws-x",
		Cwd:       "/tmp/x",
		CreatedAt: 10,
		extra: map[string]json.RawMessage{
			"name":     json.RawMessage(`"stale-name"`),
			"Provider": json.RawMessage(`"omp"`),
			"x-keep":   json.RawMessage(`{"nested":[1,true,null]}`),
		},
	}
	raw, err := json.Marshal(c)
	if err != nil {
		t.Fatalf("marshal chat: %v", err)
	}
	fields := mustFields(t, raw)
	if got := string(fields["name"]); got != `"typed-name"` {
		t.Fatalf("name = %s, want authoritative typed value", got)
	}
	if _, ok := fields["provider"]; ok {
		t.Fatalf("empty typed provider defeated omitempty: %s", raw)
	}
	if _, ok := fields["Provider"]; ok {
		t.Fatalf("colliding extra revived omitted provider: %s", raw)
	}
	if _, ok := fields["x-keep"]; !ok {
		t.Fatalf("non-colliding extra missing: %s", raw)
	}
}

// TestReturnedCopiesDoNotAliasRawPayloads covers raw GetChat copies,
// projected workspace copies, update returns, and AddChat input ownership.
// Mutating any caller-side map or byte slice must not mutate stored state.
func TestReturnedCopiesDoNotAliasRawPayloads(t *testing.T) {
	st, _ := loadExtraStore(t)

	got, err := st.GetChat("ws-x", "chat-extra")
	if err != nil {
		t.Fatalf("get chat: %v", err)
	}
	got.extra["x-count"][0] = '9'
	got.extra["x-injected"] = json.RawMessage(`true`)
	got.Model[0] = '['
	assertStoredChatPayloads(t, st, "chat-extra")

	listed := st.ListWorkspaces()
	if len(listed) != 1 {
		t.Fatalf("listed %d workspaces, want 1", len(listed))
	}
	for i := range listed[0].Chats {
		if listed[0].Chats[i].ID != "chat-extra" {
			continue
		}
		listed[0].Chats[i].extra["x-count"][0] = '8'
		listed[0].Chats[i].Model[0] = '['
	}
	assertStoredChatPayloads(t, st, "chat-extra")

	updated, err := st.UpdateChat("ws-x", "chat-extra", func(c *Chat) { c.Name = "updated" })
	if err != nil {
		t.Fatalf("update chat: %v", err)
	}
	updated.extra["x-count"][0] = '7'
	updated.Model[0] = '['
	assertStoredChatPayloads(t, st, "chat-extra")

	input := Chat{
		ID:        "chat-input",
		Name:      "input",
		WsID:      "ws-x",
		Cwd:       "/tmp/x",
		Model:     json.RawMessage(`{"name":"input-model"}`),
		CreatedAt: 11,
		extra:     map[string]json.RawMessage{"x-owned": json.RawMessage(`"original"`)},
	}
	if err := st.AddChat("ws-x", input); err != nil {
		t.Fatalf("add chat: %v", err)
	}
	input.extra["x-owned"][1] = 'X'
	input.Model[1] = 'X'
	stored, err := st.GetChat("ws-x", "chat-input")
	if err != nil {
		t.Fatalf("get added chat: %v", err)
	}
	if got := string(stored.extra["x-owned"]); got != `"original"` {
		t.Fatalf("stored input extra = %s, want independent original", got)
	}
	if got := string(stored.Model); got != `{"name":"input-model"}` {
		t.Fatalf("stored input model = %s, want independent original", got)
	}
}

func assertStoredChatPayloads(t *testing.T, st *Store, id string) {
	t.Helper()
	stored, err := st.GetChat("ws-x", id)
	if err != nil {
		t.Fatalf("get stored chat: %v", err)
	}
	if got := string(stored.extra["x-count"]); got != "42" {
		t.Fatalf("stored x-count = %s, want independent 42", got)
	}
	if _, ok := stored.extra["x-injected"]; ok {
		t.Fatal("caller-side extra map mutation reached stored chat")
	}
	if got := string(stored.Model); got != `{"name": "m-1"}` {
		t.Fatalf("stored model = %s, want independent original", got)
	}
}

// TestLegacyTerminalsMigrationPreservesUnknowns keeps the existing migration
// contract while exercising the same round-trip path: terminals becomes chats,
// the legacy key is not duplicated, and unknown state/workspace/chat data rides
// through the migration flush.
func TestLegacyTerminalsMigrationPreservesUnknowns(t *testing.T) {
	const fixture = `{
	  "stateFuture": {"v": 1},
	  "workspaces": [{
	    "id": "ws-legacy",
	    "name": "legacy",
	    "path": "/tmp/legacy",
	    "workspaceFuture": [1, {"deep": true}],
	    "terminals": [{
	      "id": "chat-legacy",
	      "name": "legacy-chat",
	      "wsId": "ws-legacy",
	      "cwd": "/tmp/legacy",
	      "provider": "omp",
	      "createdAt": 12,
	      "providerFuture": {"mode": "deep", "args": [1, null, false]}
	    }]
	  }]
	}`
	home := t.TempDir()
	t.Setenv("HOME", home)
	dir, err := StateDir()
	if err != nil {
		t.Fatalf("state dir: %v", err)
	}
	path := filepath.Join(dir, "state.json")
	if err := os.WriteFile(path, []byte(fixture), 0o600); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
	st := reloadExtraStore(t)
	if raw, err := st.GetChat("ws-legacy", "chat-legacy"); err != nil || raw.Provider != "omp" {
		t.Fatalf("legacy raw chat = %#v, err %v", raw, err)
	}
	if err := st.SetLayout(json.RawMessage(`{"migrated":true}`)); err != nil {
		t.Fatalf("flush migration: %v", err)
	}

	stateFields := rawState(t, path)
	if _, ok := stateFields["stateFuture"]; !ok {
		t.Fatalf("state unknown dropped: %s", stateBytes(t, path))
	}
	wsRaw := rawWorkspaceByID(t, path, "ws-legacy")
	wsFields := mustFields(t, wsRaw)
	if _, ok := wsFields["terminals"]; ok {
		t.Fatalf("legacy terminals key duplicated after migration: %s", wsRaw)
	}
	if _, ok := wsFields["workspaceFuture"]; !ok {
		t.Fatalf("workspace unknown dropped: %s", wsRaw)
	}
	var chats []json.RawMessage
	if err := json.Unmarshal(wsFields["chats"], &chats); err != nil || len(chats) != 1 {
		t.Fatalf("migrated chats = %s, err %v", wsFields["chats"], err)
	}
	if _, ok := mustFields(t, chats[0])["providerFuture"]; !ok {
		t.Fatalf("legacy chat unknown dropped: %s", chats[0])
	}

	reloaded := reloadExtraStore(t)
	if raw, err := reloaded.GetChat("ws-legacy", "chat-legacy"); err != nil || raw.Provider != "omp" {
		t.Fatalf("reloaded migrated chat = %#v, err %v", raw, err)
	}
	if listed := reloaded.ListWorkspaces(); len(listed) != 1 || len(listed[0].Chats) != 0 {
		t.Fatalf("unsupported migrated chat leaked into listing: %#v", listed)
	}
}

func mustFields(t *testing.T, raw json.RawMessage) map[string]json.RawMessage {
	t.Helper()
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		t.Fatalf("parse record: %v", err)
	}
	return fields
}
