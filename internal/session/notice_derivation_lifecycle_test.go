package session

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func reviewNoticePayloads(s *Session, kind string) []map[string]any {
	var result []map[string]any
	for _, f := range s.manager.noticeReplay(s.chatID) {
		p := f.Data.(map[string]any)
		if p["kind"] == kind {
			result = append(result, p)
		}
	}
	return result
}

func reviewHistorySession(t *testing.T, withCompaction bool) (*Session, *Manager, testChat) {
	t.Helper()
	cwd := t.TempDir()
	path := filepath.Join(cwd, "review.jsonl")
	body := fmt.Sprintf("{\"type\":\"session\",\"id\":\"review-durable\",\"version\":3,\"cwd\":%q}\n", cwd)
	body += "{\"type\":\"message\",\"id\":\"root\",\"parentId\":null,\"message\":{\"role\":\"user\",\"content\":\"hello\"}}\n"
	if withCompaction {
		body += "{\"type\":\"compaction\",\"id\":\"old-compaction\",\"parentId\":\"root\",\"summary\":\"old\",\"tokensBefore\":1234,\"firstKeptEntryId\":\"root\"}\n"
		cached, err := json.Marshal(map[string]any{"type": "message", "id": "cached-turn", "parentId": "old-compaction", "message": cacheMessage(1000, "m", 0, 45000, 0, 0, 0)["message"]})
		if err != nil {
			t.Fatal(err)
		}
		body += string(cached) + "\n"
	}
	if err := os.WriteFile(path, []byte(body), 0600); err != nil {
		t.Fatal(err)
	}
	d := newDaemon(t)
	if err := d.LoadSessionFile(path); err != nil {
		t.Fatal(err)
	}
	store := newMemStore()
	chat := testChat{id: "review-history", cwd: cwd}
	store.cursors[chat.id] = Cursor{SessionFile: path, DurableSessionID: "review-durable", InPlace: true}
	mgr := testManager(t, dial(t, d), store, 64)
	mgr.cfg.NoticeDir = t.TempDir()
	sub := &synchronousApprovalRecorder{recorder: newRecorder(64)}
	s, _, detach := acquire(t, mgr, chat, sub)
	t.Cleanup(detach)
	return s, mgr, chat
}

func TestReviewLateAttachDoesNotEraseCacheHistory(t *testing.T) {
	s, mgr, chat := reviewHistorySession(t, true)
	injectEvent(t, s, cacheMessage(1000, "m", 0, 45000, 0, 0, 0))
	s.lifecycleMu.Lock()
	before := s.transcriptNotices.previous
	s.lifecycleMu.Unlock()
	late := &synchronousApprovalRecorder{recorder: newRecorder(64)}
	same, _, detach := acquire(t, mgr, chat, late)
	t.Cleanup(detach)
	if same != s {
		t.Fatal("reattach replaced session unexpectedly")
	}
	s.lifecycleMu.Lock()
	after := s.transcriptNotices.previous
	s.lifecycleMu.Unlock()
	t.Logf("same Session late attach: previous before=%+v after=%+v", before, after)
	if before == nil || !reflect.DeepEqual(after, before) {
		t.Fatalf("replay changed live baseline: before=%+v after=%+v", before, after)
	}
	injectEvent(t, s, cacheMessage(2000, "m", 45000, 0, 0, 0.45, 0))
	if got := len(reviewNoticePayloads(s, "cache_miss")); got != 1 {
		t.Fatalf("late attach erased live cache baseline: got %d cache_miss, want 1 for 45000 tokens / $0.45", got)
	}
}

func TestReviewMessageDedupeSurvivesRouteReopen(t *testing.T) {
	s, mgr, chat := reviewHistorySession(t, false)
	first := cacheMessage(1000, "m", 0, 45000, 0, 0, 0)
	second := cacheMessage(2000, "m", 45000, 0, 0, 0.45, 0)
	injectEvent(t, s, first)
	injectEvent(t, s, second)
	before := mgr.noticeReplay(chat.id)
	if len(reviewNoticePayloads(s, "cache_miss")) != 1 {
		t.Fatal("setup did not detect miss")
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	late := &synchronousApprovalRecorder{recorder: newRecorder(64)}
	reopened, _, detach := acquire(t, mgr, chat, late)
	t.Cleanup(detach)
	if reopened == s || reopened.ID() != s.ID() {
		t.Fatalf("not a same-durable-session route reopen: old=%p/%s new=%p/%s", s, s.ID(), reopened, reopened.ID())
	}
	if got := mgr.noticeReplay(chat.id); !reflect.DeepEqual(got, before) {
		t.Fatal("reopen replay changed existing payload")
	}
	reopened.lifecycleMu.Lock()
	baseline := reopened.transcriptNotices.previous
	reopened.lifecycleMu.Unlock()
	if baseline == nil {
		t.Fatal("route reopen lost detector checkpoint")
	}
	injectEvent(t, reopened, first)
	reopened.lifecycleMu.Lock()
	unchanged := reflect.DeepEqual(reopened.transcriptNotices.previous, baseline)
	reopened.lifecycleMu.Unlock()
	if !unchanged {
		t.Fatal("old message rewound detector on reopened route")
	}
	injectEvent(t, reopened, second)
	after := mgr.noticeReplay(chat.id)
	t.Logf("same durable session %s: before=%v after=%v", s.ID(), before, after)
	if !reflect.DeepEqual(after, before) {
		t.Fatalf("repeated delivery re-emitted cache detection after route reopen: %d notices before, %d after", len(before), len(after))
	}
}

func TestReviewMessageDedupeSurvivesManagerRestart(t *testing.T) {
	s, mgr, chat := reviewHistorySession(t, false)
	first := cacheMessage(1000, "m", 0, 45000, 0, 0, 0)
	second := cacheMessage(2000, "m", 45000, 0, 0, 0.45, 0)
	injectEvent(t, s, first)
	injectEvent(t, s, second)
	before := mgr.noticeReplay(chat.id)
	if len(reviewNoticePayloads(s, "cache_miss")) != 1 {
		t.Fatal("setup did not detect miss")
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	restarted := testManager(t, mgr.cfg.Client, mgr.cfg.Store, 64)
	restarted.cfg.NoticeDir = mgr.cfg.NoticeDir
	rebuilt, _, detach := acquire(t, restarted, chat, &synchronousApprovalRecorder{recorder: newRecorder(64)})
	t.Cleanup(detach)
	if rebuilt.ID() != s.ID() {
		t.Fatal("restart changed durable identity")
	}
	rebuilt.lifecycleMu.Lock()
	baseline := rebuilt.transcriptNotices.previous
	rebuilt.lifecycleMu.Unlock()
	if baseline == nil || baseline.Timestamp != 2000 {
		t.Fatalf("restart did not restore latest checkpoint: %+v", baseline)
	}
	injectEvent(t, rebuilt, first)
	rebuilt.lifecycleMu.Lock()
	unchanged := reflect.DeepEqual(rebuilt.transcriptNotices.previous, baseline)
	rebuilt.lifecycleMu.Unlock()
	if !unchanged {
		t.Fatal("redelivery rewound restarted detector")
	}
	injectEvent(t, rebuilt, second)
	if got := restarted.noticeReplay(chat.id); !reflect.DeepEqual(got, before) {
		t.Fatalf("restart redelivery changed journal: got %v want %v", got, before)
	}
	// Dedupe must retain the sticky baseline, not just suppress all derivation.
	injectEvent(t, rebuilt, cacheMessage(3000, "m", 45000, 0, 0, 0.45, 0))
	if got := len(reviewNoticePayloads(rebuilt, "cache_miss")); got != 2 {
		t.Fatalf("fresh request after restart: got %d cache misses, want 2", got)
	}
}

func TestReviewColdHistoryRebuildsCache(t *testing.T) {
	s, _, _ := reviewHistorySession(t, true)
	injectEvent(t, s, cacheMessage(2000, "m", 45000, 0, 0, 0.45, 0))
	if got := len(reviewNoticePayloads(s, "cache_miss")); got != 1 {
		t.Fatalf("cold history did not fold post-compaction request: got %d cache misses", got)
	}
}

func TestReviewNewBranchEntryResetsCache(t *testing.T) {
	s, _ := acquireDrained(t, "review-branch-reset")
	injectEvent(t, s, cacheMessage(1000, "m", 0, 45000, 0, 0, 0))
	// Control: a newly observed branch summary must still clear the baseline.
	s.lifecycleMu.Lock()
	s.deriveHistoryPageLocked([]json.RawMessage{json.RawMessage(`{"type":"branch_summary","id":"branch"}`)})
	s.lifecycleMu.Unlock()
	injectEvent(t, s, cacheMessage(2000, "m", 45000, 0, 0, 0.45, 0))
	if got := len(reviewNoticePayloads(s, "cache_miss")); got != 0 {
		t.Fatalf("actual new branch summary failed to reset cache: %d", got)
	}
}
