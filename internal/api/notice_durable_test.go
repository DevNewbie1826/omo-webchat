package api

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/store"
)

// noticeEnvelope is the parsed shape of a "notice" client frame.
type noticeEnvelope struct {
	Type      string          `json:"type"`
	SessionID string          `json:"sessionId"`
	Kind      string          `json:"kind"`
	Payload   json.RawMessage `json:"payload"`
	At        string          `json:"at"`
}

func collectNoticeEnvelopes(frames [][]byte) []noticeEnvelope {
	var out []noticeEnvelope
	for _, f := range frames {
		var env noticeEnvelope
		if json.Unmarshal(f, &env) == nil && env.Type == "notice" {
			out = append(out, env)
		}
	}
	return out
}

// noticePiPath returns the notice_pi.mjs fake provider used by the durable
// notice tests.
func noticePiPath(t *testing.T) string {
	t.Helper()
	wd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(wd, "testdata", "notice_pi.mjs")
	if _, err := os.Stat(p); err != nil {
		t.Skipf("notice_pi not found: %v", err)
	}
	return p
}

// seedNoticeState plants a workspace and a chat record (without notices) in a
// fresh store, as a previous server run would have left it.
func seedNoticeState(t *testing.T, notices json.RawMessage) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	dir, err := store.StateDir()
	if err != nil {
		t.Fatalf("state dir: %v", err)
	}
	chatRecord := map[string]any{
		"id":        "chat-notice",
		"name":      "notice-qa",
		"wsId":      "ws-notice",
		"cwd":       home,
		"provider":  "omo",
		"createdAt": 1234,
	}
	if notices != nil {
		chatRecord["notices"] = notices
	}
	fixture := map[string]any{
		"workspaces": []any{
			map[string]any{
				"id":    "ws-notice",
				"name":  "notice",
				"path":  home,
				"chats": []any{chatRecord},
			},
		},
	}
	raw, err := json.Marshal(fixture)
	if err != nil {
		t.Fatalf("marshal fixture: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "state.json"), raw, 0o600); err != nil {
		t.Fatalf("write state fixture: %v", err)
	}
	return home
}

// readPersistedNotices returns the notices array of chat-notice from the
// state file on disk, or nil when the record carries none.
func readPersistedNotices(t *testing.T, path string) []noticeRecordView {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read state file: %v", err)
	}
	var parsed struct {
		Workspaces []struct {
			ID    string `json:"id"`
			Chats []struct {
				ID      string             `json:"id"`
				Notices []noticeRecordView `json:"notices"`
			} `json:"chats"`
		} `json:"workspaces"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		t.Fatalf("parse state file: %v", err)
	}
	for _, ws := range parsed.Workspaces {
		if ws.ID != "ws-notice" {
			continue
		}
		for _, chat := range ws.Chats {
			if chat.ID == "chat-notice" {
				return chat.Notices
			}
		}
	}
	return nil
}

type noticeRecordView struct {
	Kind    string          `json:"kind"`
	Payload json.RawMessage `json:"payload"`
	At      string          `json:"at"`
}

// waitForPersistedNotices polls the state file until the chat record shows
// the write-through result and the server has gone quiet: notices matching
// want, and the identity capture (piSessionId) already on disk — the store's
// last possible write — so t.TempDir cleanup can never race a flush.
func waitForPersistedNotices(t *testing.T, path string, want func([]noticeRecordView) bool, desc string) []noticeRecordView {
	t.Helper()
	deadline := time.After(5 * time.Second)
	for {
		notices := readPersistedNotices(t, path)
		var hasIdentity bool
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read state file: %v", err)
		}
		var parsed struct {
			Workspaces []struct {
				Chats []struct {
					ID          string `json:"id"`
					PiSessionID string `json:"piSessionId"`
				} `json:"chats"`
			} `json:"workspaces"`
		}
		if json.Unmarshal(raw, &parsed) == nil {
			for _, ws := range parsed.Workspaces {
				for _, c := range ws.Chats {
					if c.ID == "chat-notice" && c.PiSessionID != "" {
						hasIdentity = true
					}
				}
			}
		}
		if hasIdentity && want(notices) {
			return notices
		}
		select {
		case <-deadline:
			t.Fatalf("persisted notices never satisfied %s; state: %+v", desc, notices)
		case <-time.After(5 * time.Millisecond):
		}
	}
}

// End to end: a durable advisory notice is the write-through boundary. The
// persisted record must gain exactly the durable notice — kind, bare payload,
// parseable receipt time — while the transient notice broadcast in the same
// breath never touches the store.
func TestDurableNoticePersistsToChatRecord(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skipf("node not in PATH: %v", err)
	}
	home := seedNoticeState(t, nil)
	t.Setenv("CHAT_PI_BINARY", "node")
	t.Setenv("CHAT_PI_ARGS", noticePiPath(t))
	t.Setenv("NOTICE_PI_MARKER", "write-through")

	server := snapshotServer(t, home)
	collector, client := connectCollector(t, server)
	writeFrame(t, client, map[string]any{"type": "chat.create", "wsId": "ws-notice", "chatId": "chat-notice"})
	collector.waitFor(t, "ready", 3*time.Second)

	// Live surface: both notices arrive, each with a parseable receipt time.
	deadline := time.After(5 * time.Second)
	var notices []noticeEnvelope
	for {
		notices = collectNoticeEnvelopes(collector.snapshot())
		if len(notices) >= 2 {
			break
		}
		select {
		case <-collector.notify:
		case <-deadline:
			t.Fatalf("live notices = %d, want the transient and the durable notice; have: %s", len(notices), collector.types())
		}
	}
	kinds := map[string]bool{}
	for _, n := range notices {
		if _, err := time.Parse(time.RFC3339Nano, n.At); err != nil || n.At == "" {
			t.Fatalf("notice %q carries unparseable at %q: %v", n.Kind, n.At, err)
		}
		kinds[n.Kind] = true
	}
	if !kinds["auto_retry_start"] || !kinds["high_reasoning_warning"] {
		t.Fatalf("live notice kinds = %v, want auto_retry_start and high_reasoning_warning", kinds)
	}

	// Persistence surface: only the durable record may reach the state file.
	statePath := filepath.Join(home, ".local", "state", "omo-webchat", "state.json")
	persisted := waitForPersistedNotices(t, statePath, func(records []noticeRecordView) bool {
		return len(records) > 0
	}, "the durable write-through")
	if len(persisted) != 1 {
		t.Fatalf("persisted notices = %+v, want exactly the durable record", persisted)
	}
	if persisted[0].Kind != "high_reasoning_warning" {
		t.Fatalf("persisted notice kind = %q, want high_reasoning_warning", persisted[0].Kind)
	}
	var payload map[string]any
	if err := json.Unmarshal(persisted[0].Payload, &payload); err != nil {
		t.Fatalf("persisted payload is not valid JSON: %v (%s)", err, persisted[0].Payload)
	}
	if payload["marker"] != "write-through" {
		t.Fatalf("persisted payload = %s, want the bare advisory object", persisted[0].Payload)
	}
	if _, err := time.Parse(time.RFC3339Nano, persisted[0].At); err != nil || persisted[0].At == "" {
		t.Fatalf("persisted at %q is not a parseable receipt time: %v", persisted[0].At, err)
	}
}

// A chat record whose persisted notices carry malformed entries must not
// break session restore: malformed records are dropped, the valid remainder
// seeds the replay log, and the server keeps serving.
func TestMalformedSeededNoticesTolerated(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skipf("node not in PATH: %v", err)
	}
	seeded := json.RawMessage(`[
		{"kind": "", "payload": {"malformed": "empty kind"}, "at": "2026-01-02T03:04:05Z"},
		{"kind": "retry_fallback_applied", "payload": {"seed": true}, "at": "2026-01-02T03:04:06Z"},
		{"kind": "high_reasoning_warning", "payload": {"malformed": "zero time"}, "at": "0001-01-01T00:00:00Z"}
	]`)
	home := seedNoticeState(t, seeded)
	t.Setenv("CHAT_PI_BINARY", "node")
	t.Setenv("CHAT_PI_ARGS", noticePiPath(t))
	t.Setenv("NOTICE_PI_MARKER", "after-malformed-seed")

	server := snapshotServer(t, home)
	collector, client := connectCollector(t, server)
	writeFrame(t, client, map[string]any{"type": "chat.create", "wsId": "ws-notice", "chatId": "chat-notice"})
	collector.waitFor(t, "ready", 3*time.Second)

	// The valid seeded record must replay (payload {"seed":true}); the
	// malformed empty-kind record must be dropped, never replayed.
	deadline := time.After(5 * time.Second)
	var seededSeen bool
	for {
		for _, n := range collectNoticeEnvelopes(collector.snapshot()) {
			var payload map[string]any
			if err := json.Unmarshal(n.Payload, &payload); err != nil {
				t.Fatalf("notice %q payload is not valid JSON: %v (%s)", n.Kind, err, n.Payload)
			}
			if payload["seed"] == true {
				if n.Kind != "retry_fallback_applied" {
					t.Fatalf("seeded notice kind = %q, want retry_fallback_applied", n.Kind)
				}
				seededSeen = true
			}
			if n.Kind == "" {
				t.Fatalf("malformed empty-kind seed record was replayed: %s", n.Payload)
			}
		}
		if seededSeen {
			break
		}
		select {
		case <-collector.notify:
		case <-deadline:
			t.Fatalf("valid seeded notice never replayed; frames: %s", collector.types())
		}
	}

	// The live durable notice still flows and persists after the malformed
	// seed: the write-through replaces the whole record log, so the state file
	// must end up with exactly the valid seed plus the live notice — the
	// malformed entries are gone for good and the server is unharmed.
	statePath := filepath.Join(home, ".local", "state", "omo-webchat", "state.json")
	persisted := waitForPersistedNotices(t, statePath, func(records []noticeRecordView) bool {
		for _, rec := range records {
			var payload map[string]any
			if json.Unmarshal(rec.Payload, &payload) == nil && payload["marker"] == "after-malformed-seed" {
				return true
			}
		}
		return false
	}, "the live durable write-through after a malformed seed")
	if len(persisted) != 2 {
		t.Fatalf("persisted notices = %+v, want exactly the valid seed plus the live durable notice", persisted)
	}
	for _, rec := range persisted {
		var payload map[string]any
		if err := json.Unmarshal(rec.Payload, &payload); err != nil {
			t.Fatalf("persisted payload is not valid JSON: %v (%s)", err, rec.Payload)
		}
		if _, malformed := payload["malformed"]; malformed {
			t.Fatalf("malformed seed entry survived the write-through: %+v", rec)
		}
	}
}
