package session

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"testing"
)

// persistedNoticeFile mirrors the on-disk journal contract: the persisted
// per-chat sequence plus the retained entries in replay order.
type persistedNoticeFile struct {
	Seq     uint64 `json:"seq"`
	Entries []struct {
		Kind      string         `json:"kind"`
		SessionID string         `json:"session_id"`
		Data      map[string]any `json:"data"`
	} `json:"entries"`
}

func readPersistedNotices(t *testing.T, dir, chatID string) persistedNoticeFile {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(dir, chatID+".json"))
	if err != nil {
		t.Fatalf("reading persisted notice journal: %v", err)
	}
	var file persistedNoticeFile
	if err := json.Unmarshal(raw, &file); err != nil {
		t.Fatalf("persisted notice journal is not valid JSON: %v", err)
	}
	return file
}

func noticeNIDs(replay []Frame) []any {
	nids := make([]any, 0, len(replay))
	for _, f := range replay {
		payload, _ := f.Data.(map[string]any)
		nids = append(nids, payload["nid"])
	}
	return nids
}

// The journal survives a full manager restart: recorded notices are on disk
// immediately, and a fresh manager over the same directory replays them with
// the identities they were stamped with, continuing the sequence past every
// persisted nid.
func TestNoticeJournalPersistsAcrossManagerRestart(t *testing.T) {
	dir := t.TempDir()
	mgr := NewManager(Config{NoticeDir: dir})
	first := mgr.RecordNotice("chat-a", map[string]any{"kind": "high_reasoning_warning"})
	second := mgr.RecordNotice("chat-a", map[string]any{"kind": "auto_retry_start"})
	_, firstNID, _ := noticeIdentity(t, first)
	_, secondNID, _ := noticeIdentity(t, second)
	wantFirst := fmt.Sprintf("chat-a:g%d:1", mgr.nidGeneration)
	wantSecond := fmt.Sprintf("chat-a:g%d:2", mgr.nidGeneration)
	if firstNID != wantFirst || secondNID != wantSecond {
		t.Fatalf("pre-restart nids = (%q, %q), want (%q, %q)", firstNID, secondNID, wantFirst, wantSecond)
	}
	if err := mgr.CloseAll(context.Background()); err != nil {
		t.Fatalf("closing first manager: %v", err)
	}

	file := readPersistedNotices(t, dir, "chat-a")
	if file.Seq != 2 {
		t.Fatalf("persisted seq = %d, want 2", file.Seq)
	}
	if len(file.Entries) != 2 {
		t.Fatalf("persisted entries = %d, want 2", len(file.Entries))
	}
	if file.Entries[0].Data["nid"] != firstNID || file.Entries[1].Data["nid"] != secondNID {
		t.Fatalf("persisted entries lost recorded nids: %+v", file.Entries)
	}
	if file.Entries[0].Data["kind"] != "high_reasoning_warning" || file.Entries[1].Data["kind"] != "auto_retry_start" {
		t.Fatalf("persisted entries lost payload kinds: %+v", file.Entries)
	}

	restarted := NewManager(Config{NoticeDir: dir})
	t.Cleanup(func() { _ = restarted.CloseAll(context.Background()) })
	replay := restarted.noticeReplay("chat-a")
	if got := noticeNIDs(replay); len(got) != 2 || got[0] != firstNID || got[1] != secondNID {
		t.Fatalf("replayed nids after restart = %v, want [%s %s]", got, firstNID, secondNID)
	}
	third := restarted.RecordNotice("chat-a", map[string]any{"kind": "extension_notify"})
	_, thirdNID, _ := noticeIdentity(t, third)
	wantThird := fmt.Sprintf("chat-a:g%d:3", restarted.nidGeneration)
	if thirdNID != wantThird {
		t.Fatalf("post-restart nid = %q, want %q (sequence continues past both persisted nids, generation must differ)", thirdNID, wantThird)
	}
}

// Retiring a chat identity drops its persisted journal together with the
// in-memory one.
func TestRetireIdentityRemovesPersistedNoticeFile(t *testing.T) {
	dir := t.TempDir()
	mgr := NewManager(Config{NoticeDir: dir})
	t.Cleanup(func() { _ = mgr.CloseAll(context.Background()) })
	mgr.RecordNotice("chat-a", map[string]any{"kind": "compaction_error"})
	readPersistedNotices(t, dir, "chat-a")

	mgr.RetireIdentity("chat-a")

	if _, err := os.Stat(filepath.Join(dir, "chat-a.json")); !os.IsNotExist(err) {
		t.Fatalf("persisted notice file still present after RetireIdentity: stat err = %v", err)
	}
}

// A corrupt journal file never blocks startup: the manager starts empty and
// the unreadable file is moved aside with the .corrupt-<unixts> suffix for
// inspection instead of being destroyed.
func TestCorruptNoticeFileIsMovedAsideAndStartsEmpty(t *testing.T) {
	dir := t.TempDir()
	corruptPath := filepath.Join(dir, "chat-a.json")
	if err := os.WriteFile(corruptPath, []byte("{not json at all"), 0o600); err != nil {
		t.Fatalf("writing corrupt fixture: %v", err)
	}
	mgr := NewManager(Config{NoticeDir: dir})
	t.Cleanup(func() { _ = mgr.CloseAll(context.Background()) })

	if replay := mgr.noticeReplay("chat-a"); len(replay) != 0 {
		t.Fatalf("corrupt journal replayed %d notices, want 0", len(replay))
	}
	if _, err := os.Stat(corruptPath); !os.IsNotExist(err) {
		t.Fatalf("corrupt file was not moved aside: stat err = %v", err)
	}
	moved, err := filepath.Glob(filepath.Join(dir, "chat-a.json.corrupt-*"))
	if err != nil {
		t.Fatalf("globbing corrupt leftovers: %v", err)
	}
	if len(moved) != 1 {
		t.Fatalf("corrupt leftovers = %v, want exactly one chat-a.json.corrupt-<unixts> file", moved)
	}
	if matched := regexp.MustCompile(`^chat-a\.json\.corrupt-\d+$`).MatchString(filepath.Base(moved[0])); !matched {
		t.Fatalf("moved-aside name %q does not match .corrupt-<unixts>", filepath.Base(moved[0]))
	}
}

// Without NoticeDir the journal stays memory-only: recording works exactly as
// before and nothing touches the filesystem.
func TestRecordNoticeWithoutNoticeDirKeepsMemoryOnly(t *testing.T) {
	mgr := NewManager(Config{})
	t.Cleanup(func() { _ = mgr.CloseAll(context.Background()) })

	recorded := mgr.RecordNotice("chat-a", map[string]any{"kind": "queue_delivery_uncertain"})
	if _, nid, _ := noticeIdentity(t, recorded); nid != fmt.Sprintf("chat-a:g%d:1", mgr.nidGeneration) {
		t.Fatalf("memory-only nid = %q, want chat-a:g%d:1", nid, mgr.nidGeneration)
	}
	if replay := mgr.noticeReplay("chat-a"); len(replay) != 1 {
		t.Fatalf("memory-only replay holds %d notices, want 1", len(replay))
	}
}
