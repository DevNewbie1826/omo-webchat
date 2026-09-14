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

// Retiring a chat identity must stay final across both publishers that can
// straddle the retirement boundary: a save already in flight when retirement
// runs (retirement must drain it before unlinking, and it must never rename
// its file back), and a publisher admitted after retirement (its lookup must
// land on the tombstoned journal and be refused outright - a fresh journal
// for the same pathname would re-issue a delivered nid and resurrect the
// file). Retirement completion is observed on a channel before the second
// publisher is admitted, so the schedule is deterministic; launching the
// goroutine alone would not establish that retirement's admission transition
// ran first.
func TestNoticeJournalRetirementFencesInflightSaveAndLatePublisher(t *testing.T) {
	dir := t.TempDir()
	mgr := NewManager(Config{NoticeDir: dir})
	t.Cleanup(func() { _ = mgr.CloseAll(context.Background()) })
	first := mgr.RecordNotice("chat-a", map[string]any{"kind": "extension_notify"})
	_, firstNID, _ := noticeIdentity(t, first)

	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	gate := &journalSaveGate{entered: make(chan struct{}), release: make(chan struct{}), ctx: ctx}
	saved := make(chan struct{})
	var inflight Frame
	go func() {
		defer close(saved)
		inflight = mgr.RecordNotice("chat-a", map[string]any{"kind": "queue_delivery_uncertain", "payload": gate})
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
	_, inflightNID, _ := noticeIdentity(t, inflight)

	late := mgr.RecordNotice("chat-a", map[string]any{"kind": "auto_retry_start"})
	latePayload, ok := late.Data.(map[string]any)
	if !ok {
		t.Fatalf("late publisher data = %T, want map[string]any", late.Data)
	}
	if lateNID, _ := latePayload["nid"].(string); lateNID != "" {
		t.Fatalf("retired identity re-issued nid %q to a late publisher (already delivered: %q, %q)", lateNID, firstNID, inflightNID)
	}
	if _, err := os.Stat(filepath.Join(dir, "chat-a.json")); !os.IsNotExist(err) {
		t.Fatalf("late publisher resurrected retired file: stat err = %v", err)
	}
	if replay := mgr.noticeReplay("chat-a"); len(replay) != 0 {
		t.Fatalf("retired journal retained %d late notices, want 0", len(replay))
	}
	if firstNID == "" || inflightNID == "" || firstNID == inflightNID {
		t.Fatalf("retirement boundary issued colliding nids: %q vs %q", firstNID, inflightNID)
	}
}

// A valid-JSON file whose retained entries violate the identity invariants -
// a repeated nid string, or sequence tails that do not strictly increase -
// must be quarantined exactly like any other corruption: the client dedupes
// retained notices by nid string, so an admitted duplicate would silently
// drop one retained record instead of taking the clean-start path.
func TestNoticeJournalQuarantinesCorruptRetainedIdentities(t *testing.T) {
	tests := map[string]struct {
		raw string
		bad string
	}{
		"duplicate retained nid": {
			raw: `{"seq":2,"entries":[` +
				`{"kind":"notice","session_id":"chat-a","data":{"kind":"extension_notify","nid":"chat-a:g123:1","at":"2026-09-14T00:00:00Z"}},` +
				`{"kind":"notice","session_id":"chat-a","data":{"kind":"auto_retry_start","nid":"chat-a:g123:1","at":"2026-09-14T00:00:01Z"}}]}`,
			bad: "chat-a:g123:1",
		},
		"reversed retained sequence": {
			raw: `{"seq":2,"entries":[` +
				`{"kind":"notice","session_id":"chat-a","data":{"kind":"extension_notify","nid":"chat-a:g123:2","at":"2026-09-14T00:00:00Z"}},` +
				`{"kind":"notice","session_id":"chat-a","data":{"kind":"auto_retry_start","nid":"chat-a:g123:1","at":"2026-09-14T00:00:01Z"}}]}`,
			bad: "chat-a:g123:1",
		},
	}
	for name, tt := range tests {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			path := filepath.Join(dir, "chat-a.json")
			if err := os.WriteFile(path, []byte(tt.raw), 0o600); err != nil {
				t.Fatalf("writing corrupt fixture: %v", err)
			}
			mgr := NewManager(Config{NoticeDir: dir})
			t.Cleanup(func() { _ = mgr.CloseAll(context.Background()) })

			if replay := mgr.noticeReplay("chat-a"); len(replay) != 0 {
				t.Fatalf("inconsistent journal admitted: replay=%v quarantined=[]", noticeNIDs(replay))
			}
			fresh := mgr.RecordNotice("chat-a", map[string]any{"kind": "auto_retry_start"})
			_, nid, _ := noticeIdentity(t, fresh)
			if nid == tt.bad {
				t.Fatalf("new notice re-issued quarantined nid %q", nid)
			}
			moved, err := filepath.Glob(path + ".corrupt-*")
			if err != nil {
				t.Fatalf("globbing corrupt leftovers: %v", err)
			}
			if len(moved) != 1 {
				t.Fatalf("corrupt leftovers = %v, want exactly one chat-a.json.corrupt-<unixts> file", moved)
			}
		})
	}
}

// A nid delivered to callers must never be re-issued after a restart, even
// when its save failed: the persisted file still holds the older sequence, so
// the restarted manager must stamp the fresh notice with an identity that
// differs from every previously delivered one while continuing the persisted
// sequence. The fault is injected by occupying the notices directory's
// pathname with a regular file, so the save's directory creation fails on
// every supported platform - directory permission bits do not stop writes on
// Windows.
func TestNoticeJournalSaveFailureThenRestartDoesNotReuseDeliveredNID(t *testing.T) {
	dir := t.TempDir()
	mgr := NewManager(Config{NoticeDir: dir})
	mgr.RecordNotice("chat-a", map[string]any{"kind": "extension_notify"})

	aside := dir + ".save-fault"
	if err := os.Rename(dir, aside); err != nil {
		t.Fatalf("moving notices directory aside: %v", err)
	}
	if err := os.WriteFile(dir, nil, 0o600); err != nil {
		_ = os.Rename(aside, dir)
		t.Fatalf("occupying notices pathname with a regular file: %v", err)
	}
	failed := mgr.RecordNotice("chat-a", map[string]any{"kind": "auto_retry_start"})
	if err := os.Remove(dir); err != nil {
		t.Fatalf("removing the blocking file: %v", err)
	}
	if err := os.Rename(aside, dir); err != nil {
		t.Fatalf("restoring notices directory: %v", err)
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
