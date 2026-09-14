package session

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// journalSaveGate pauses a real save inside JSON encoding while journal.mu is
// held: the gate value rides in the persisted payload, so the encoder calls
// MarshalJSON mid-save. It emits ordinary JSON and replaces no persistence
// operation.
type journalSaveGate struct {
	entered chan struct{}
	release chan struct{}
	ctx     context.Context
}

func (g *journalSaveGate) MarshalJSON() ([]byte, error) {
	close(g.entered)
	select {
	case <-g.release:
		return []byte(`"pending"`), nil
	case <-g.ctx.Done():
		return nil, g.ctx.Err()
	}
}

// Retiring a chat identity must stay final even while a save is in flight:
// retirement must drain the journal's writer before unlinking, and the
// in-flight save must never rename its file back afterwards.
func TestNoticeJournalRetirementCannotBeUndoneByInflightSave(t *testing.T) {
	dir := t.TempDir()
	mgr := NewManager(Config{NoticeDir: dir})
	t.Cleanup(func() { _ = mgr.CloseAll(context.Background()) })
	mgr.RecordNotice("chat-a", map[string]any{"kind": "extension_notify"})

	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	gate := &journalSaveGate{entered: make(chan struct{}), release: make(chan struct{}), ctx: ctx}
	saved := make(chan struct{})
	go func() {
		defer close(saved)
		mgr.PublishNotice("chat-a", map[string]any{"kind": "queue_delivery_uncertain", "payload": gate})
	}()
	select {
	case <-gate.entered:
	case <-ctx.Done():
		t.Fatal("writer did not enter persistence")
	}

	retired := make(chan struct{})
	go func() {
		defer close(retired)
		mgr.RetireIdentity("chat-a")
	}()
	close(gate.release)
	select {
	case <-retired:
	case <-ctx.Done():
		t.Fatal("retirement did not drain the in-flight save")
	}
	select {
	case <-saved:
	case <-ctx.Done():
		t.Fatal("in-flight save did not finish")
	}
	if _, err := os.Stat(filepath.Join(dir, "chat-a.json")); !os.IsNotExist(err) {
		t.Fatalf("in-flight save resurrected retired file: stat err = %v", err)
	}
}

// A nid delivered to callers must never be re-issued after a restart, even
// when its save failed: the persisted file still holds the older sequence, so
// the restarted manager must stamp the fresh notice with an identity that
// differs from every previously delivered one while continuing the persisted
// sequence.
func TestNoticeJournalSaveFailureThenRestartDoesNotReuseDeliveredNID(t *testing.T) {
	dir := t.TempDir()
	mgr := NewManager(Config{NoticeDir: dir})
	mgr.RecordNotice("chat-a", map[string]any{"kind": "extension_notify"})

	if err := os.Chmod(dir, 0o500); err != nil {
		t.Fatalf("freezing notice directory: %v", err)
	}
	failed := mgr.RecordNotice("chat-a", map[string]any{"kind": "auto_retry_start"})
	if err := os.Chmod(dir, 0o700); err != nil {
		t.Fatalf("restoring notice directory: %v", err)
	}
	_, deliveredNID, _ := noticeIdentity(t, failed)

	file := readPersistedNotices(t, dir, "chat-a")
	if file.Seq != 1 {
		t.Fatalf("failure injection ineffective: persisted seq = %d, want 1", file.Seq)
	}
	if err := mgr.CloseAll(context.Background()); err != nil {
		t.Fatalf("closing failed-save manager: %v", err)
	}

	restarted := NewManager(Config{NoticeDir: dir})
	t.Cleanup(func() { _ = restarted.CloseAll(context.Background()) })
	after := restarted.RecordNotice("chat-a", map[string]any{"kind": "auto_retry_end"})
	_, freshNID, _ := noticeIdentity(t, after)
	if freshNID == deliveredNID {
		t.Fatalf("save failure followed by restart reused delivered nid %q", deliveredNID)
	}
	if !strings.HasPrefix(freshNID, "chat-a:") || !strings.HasSuffix(freshNID, ":2") {
		t.Fatalf("fresh nid %q must keep the chat prefix and continue the persisted sequence at tail 2", freshNID)
	}
}

// A valid-JSON file that violates journal invariants must be quarantined
// exactly like a syntax error: admitting a seq below a persisted nid tail
// would both replay that notice and re-issue its nid to the next one.
func TestNoticeJournalQuarantinesValidJSONWithCorruptInvariants(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "chat-a.json")
	raw := []byte(`{"seq":0,"entries":[{"kind":"notice","session_id":"chat-a","data":{"kind":"extension_notify","nid":"chat-a:1","at":"2026-09-14T00:00:00Z"}}]}`)
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatalf("writing corrupt fixture: %v", err)
	}
	mgr := NewManager(Config{NoticeDir: dir})
	t.Cleanup(func() { _ = mgr.CloseAll(context.Background()) })

	if replay := mgr.noticeReplay("chat-a"); len(replay) != 0 {
		t.Fatalf("inconsistent journal admitted %d notices, want 0", len(replay))
	}
	fresh := mgr.RecordNotice("chat-a", map[string]any{"kind": "auto_retry_start"})
	_, nid, _ := noticeIdentity(t, fresh)
	if nid == "chat-a:1" {
		t.Fatalf("new notice re-issued quarantined nid %q", nid)
	}
	moved, err := filepath.Glob(path + ".corrupt-*")
	if err != nil {
		t.Fatalf("globbing corrupt leftovers: %v", err)
	}
	if len(moved) != 1 {
		t.Fatalf("corrupt leftovers = %v, want exactly one chat-a.json.corrupt-<unixts> file", moved)
	}
}

// Replay must deliver persisted nids verbatim - generation-qualified and
// legacy-shaped entries alike - and stamp fresh notices that continue the
// persisted sequence.
func TestNoticeJournalReplayPreservesPersistedNidsVerbatim(t *testing.T) {
	tests := map[string]struct {
		raw  string
		nids []string
	}{
		"generation-qualified": {
			raw: `{"seq":2,"entries":[` +
				`{"kind":"notice","session_id":"chat-a","data":{"kind":"extension_notify","nid":"chat-a:g999:1","at":"2026-09-14T00:00:00Z"}},` +
				`{"kind":"notice","session_id":"chat-a","data":{"kind":"auto_retry_start","nid":"chat-a:g999:2","at":"2026-09-14T00:00:01Z"}}]}`,
			nids: []string{"chat-a:g999:1", "chat-a:g999:2"},
		},
		"legacy": {
			raw:  `{"seq":1,"entries":[{"kind":"notice","session_id":"chat-a","data":{"kind":"extension_notify","nid":"chat-a:1","at":"2026-09-14T00:00:00Z"}}]}`,
			nids: []string{"chat-a:1"},
		},
	}
	for name, tt := range tests {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			if err := os.WriteFile(filepath.Join(dir, "chat-a.json"), []byte(tt.raw), 0o600); err != nil {
				t.Fatalf("writing fixture: %v", err)
			}
			mgr := NewManager(Config{NoticeDir: dir})
			t.Cleanup(func() { _ = mgr.CloseAll(context.Background()) })

			got := noticeNIDs(mgr.noticeReplay("chat-a"))
			if len(got) != len(tt.nids) {
				t.Fatalf("replayed %d notices, want %d", len(got), len(tt.nids))
			}
			for i, want := range tt.nids {
				if got[i] != want {
					t.Fatalf("replay[%d] nid = %v, want %q (persisted identities must survive verbatim)", i, got[i], want)
				}
			}
			fresh := mgr.RecordNotice("chat-a", map[string]any{"kind": "extension_notify"})
			_, nid, _ := noticeIdentity(t, fresh)
			if !strings.HasPrefix(nid, "chat-a:") || !strings.HasSuffix(nid, fmt.Sprintf(":%d", len(tt.nids)+1)) {
				t.Fatalf("fresh nid %q must continue the persisted sequence at tail %d", nid, len(tt.nids)+1)
			}
		})
	}
}
