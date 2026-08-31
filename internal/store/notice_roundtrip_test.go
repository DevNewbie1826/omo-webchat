package store

import (
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/chat"
)

// noticesFixture plants a typed durable-notice log plus an unknown extension
// field on one chat record, and a sibling record with no notices at all.
const noticesFixture = `{
  "workspaces": [
    {
      "id": "ws-notices",
      "name": "notices",
      "path": "/tmp/notices",
      "chats": [
        {
          "id": "chat-notices",
          "name": "notice-qa",
          "wsId": "ws-notices",
          "cwd": "/tmp/notices",
          "provider": "omo",
          "createdAt": 5,
          "notices": [
            {
              "kind": "high_reasoning_warning",
              "payload": {"modelId": "gpt-5.6-sol", "provider": "openai-codex", "thinkingLevel": "xhigh"},
              "at": "2026-01-02T03:04:05.123456789Z"
            },
            {
              "kind": "retry_fallback_applied",
              "payload": {"from": "a", "to": "b", "reason": "rate_limited"},
              "at": "2026-01-02T03:04:06Z"
            }
          ],
          "x-unknown": {"keep": true}
        },
        {
          "id": "chat-plain",
          "name": "plain",
          "wsId": "ws-notices",
          "cwd": "/tmp/notices",
          "provider": "omo",
          "createdAt": 6
        }
      ]
    }
  ]
}`

func loadNoticesStore(t *testing.T) (*Store, string) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	dir, err := StateDir()
	if err != nil {
		t.Fatalf("state dir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "state.json"), []byte(noticesFixture), 0o600); err != nil {
		t.Fatalf("write state: %v", err)
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	st, err := LoadDir(dir, logger)
	if err != nil {
		t.Fatalf("load store: %v", err)
	}
	return st, dir
}

// The persisted durable-notice log must round-trip through Load, survive
// unrelated flushes alongside unknown fields, and be replaceable through
// UpdateChat with the replacement still on disk after a reload.
func TestMalformedNoticeElementsAreDroppedWithoutFailingStoreLoad(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	dir, err := StateDir()
	if err != nil {
		t.Fatalf("state dir: %v", err)
	}
	fixture := `{"workspaces":[{"id":"ws","name":"ws","path":"/tmp","chats":[{"id":"chat","name":"chat","wsId":"ws","cwd":"/tmp","provider":"omo","createdAt":1,"notices":[` +
		`{"kind":"retry_fallback_applied","payload":{"ok":true},"at":"2026-01-02T03:04:05Z"},` +
		`{"kind":"high_reasoning_warning","payload":{},"at":"not-a-time"},` +
		`{"kind":7,"payload":{},"at":"2026-01-02T03:04:06Z"},` +
		`{"kind":"retry_fallback_exhausted","payload":"bad","at":"2026-01-02T03:04:07Z"}` +
		`]}]}]}`
	if err := os.WriteFile(filepath.Join(dir, "state.json"), []byte(fixture), 0o600); err != nil {
		t.Fatalf("write state: %v", err)
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	st, err := LoadDir(dir, logger)
	if err != nil {
		t.Fatalf("one malformed notice failed the whole store load: %v", err)
	}
	loaded, err := st.GetChat("ws", "chat")
	if err != nil {
		t.Fatalf("get chat: %v", err)
	}
	if len(loaded.Notices) != 1 || loaded.Notices[0].Kind != "retry_fallback_applied" {
		t.Fatalf("loaded notices = %+v, want only the valid record", loaded.Notices)
	}
}

func TestChatNoticesRoundTrip(t *testing.T) {
	st, dir := loadNoticesStore(t)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))

	loaded, err := st.GetChat("ws-notices", "chat-notices")
	if err != nil {
		t.Fatalf("get chat: %v", err)
	}
	if len(loaded.Notices) != 2 {
		t.Fatalf("loaded notices = %+v, want exactly 2 records", loaded.Notices)
	}
	wantKinds := []string{"high_reasoning_warning", "retry_fallback_applied"}
	wantPayloads := []string{
		`{"modelId":"gpt-5.6-sol","provider":"openai-codex","thinkingLevel":"xhigh"}`,
		`{"from":"a","to":"b","reason":"rate_limited"}`,
	}
	wantTimes := []string{"2026-01-02T03:04:05.123456789Z", "2026-01-02T03:04:06Z"}
	for i, rec := range loaded.Notices {
		if rec.Kind != wantKinds[i] {
			t.Fatalf("notice %d kind = %q, want %q", i, rec.Kind, wantKinds[i])
		}
		var got, want any
		if err := json.Unmarshal(rec.Payload, &got); err != nil {
			t.Fatalf("notice %d payload is not valid JSON: %v (%s)", i, err, rec.Payload)
		}
		if err := json.Unmarshal([]byte(wantPayloads[i]), &want); err != nil {
			t.Fatalf("fixture payload is not valid JSON: %v", err)
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("notice %d payload = %s, want %s", i, rec.Payload, wantPayloads[i])
		}
		at, err := time.Parse(time.RFC3339Nano, wantTimes[i])
		if err != nil {
			t.Fatalf("fixture time is not RFC3339Nano: %v", err)
		}
		if !rec.At.Equal(at) {
			t.Fatalf("notice %d at = %v, want %v", i, rec.At, at)
		}
	}

	// Clone non-aliasing: mutating a returned record's payload must never
	// touch the stored record.
	mutated, err := st.GetChat("ws-notices", "chat-notices")
	if err != nil {
		t.Fatalf("get chat for mutation: %v", err)
	}
	mutated.Notices[0].Payload[0] = 'X'
	mutated.Notices[0].Kind = "tampered"
	fresh, err := st.GetChat("ws-notices", "chat-notices")
	if err != nil {
		t.Fatalf("get chat after mutation: %v", err)
	}
	if fresh.Notices[0].Kind != "high_reasoning_warning" || fresh.Notices[0].Payload[0] != '{' {
		t.Fatalf("stored record aliased a mutated clone: kind %q payload %s", fresh.Notices[0].Kind, fresh.Notices[0].Payload)
	}

	// Replace the log through a normal update; the write must be atomic with
	// the rest of the store (unknown field intact) and survive a fresh load.
	replacement := []chat.NoticeRecord{
		{Kind: "server_fallback_aborted", Payload: json.RawMessage(`{"from":"x","to":"y"}`), At: time.Date(2026, 3, 4, 5, 6, 7, 0, time.UTC)},
	}
	if _, err := st.UpdateChat("ws-notices", "chat-notices", func(c *Chat) {
		c.Notices = replacement
	}); err != nil {
		t.Fatalf("update chat: %v", err)
	}
	// Mutating the input slice after the update must not leak into the store.
	replacement[0].Payload[0] = 'X'

	reloaded, err := LoadDir(dir, logger)
	if err != nil {
		t.Fatalf("reload store: %v", err)
	}
	after, err := reloaded.GetChat("ws-notices", "chat-notices")
	if err != nil {
		t.Fatalf("get chat after reload: %v", err)
	}
	if len(after.Notices) != 1 {
		t.Fatalf("reloaded notices = %+v, want exactly the replacement record", after.Notices)
	}
	if after.Notices[0].Kind != "server_fallback_aborted" {
		t.Fatalf("reloaded notice kind = %q, want server_fallback_aborted", after.Notices[0].Kind)
	}
	var gotPayload, wantPayload any
	if err := json.Unmarshal(after.Notices[0].Payload, &gotPayload); err != nil {
		t.Fatalf("reloaded payload is not valid JSON: %v (%s)", err, after.Notices[0].Payload)
	}
	if err := json.Unmarshal([]byte(`{"from":"x","to":"y"}`), &wantPayload); err != nil {
		t.Fatalf("fixture payload is not valid JSON: %v", err)
	}
	if !reflect.DeepEqual(gotPayload, wantPayload) {
		t.Fatalf("reloaded notice payload = %s, want the replacement payload; a post-update mutation may have leaked", after.Notices[0].Payload)
	}
	if !after.Notices[0].At.Equal(time.Date(2026, 3, 4, 5, 6, 7, 0, time.UTC)) {
		t.Fatalf("reloaded notice at = %v, want 2026-03-04T05:06:07Z", after.Notices[0].At)
	}

	// Unknown fields survive a notices-carrying flush.
	if _, err := reloaded.GetChat("ws-notices", "chat-notices"); err != nil {
		t.Fatalf("get chat: %v", err)
	}
	raw, err := os.ReadFile(filepath.Join(dir, "state.json"))
	if err != nil {
		t.Fatalf("read state file: %v", err)
	}
	if !strings.Contains(string(raw), `"x-unknown"`) {
		t.Fatalf("unknown field x-unknown lost during a notices flush")
	}

	// omitempty: a record without notices must not emit the key.
	plain, err := reloaded.GetChat("ws-notices", "chat-plain")
	if err != nil {
		t.Fatalf("get plain chat: %v", err)
	}
	if len(plain.Notices) != 0 {
		t.Fatalf("plain chat notices = %+v, want none", plain.Notices)
	}
	encoded, err := json.Marshal(plain)
	if err != nil {
		t.Fatalf("marshal plain chat: %v", err)
	}
	if strings.Contains(string(encoded), `"notices"`) {
		t.Fatalf("plain chat encoding carries a notices key: %s", encoded)
	}
}
