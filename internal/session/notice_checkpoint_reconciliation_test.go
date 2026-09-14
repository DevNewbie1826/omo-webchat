package session

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"reflect"
	"testing"
)

// A route can be closed while its durable conversation continues elsewhere.
// Restart with the actual updated file and a daemon that has loaded that file.
func TestR2AdvancedHistoryBoundaryResetsRestoredCheckpoint(t *testing.T) {
	for _, scenario := range []struct {
		kind              string
		followedByRequest bool
	}{
		{kind: "compaction"},
		{kind: "branch_summary"},
		{kind: "compaction", followedByRequest: true},
		{kind: "branch_summary", followedByRequest: true},
	} {
		kind := scenario.kind
		t.Run(fmt.Sprintf("%s/request=%t", kind, scenario.followedByRequest), func(t *testing.T) {
			s, mgr, chat := reviewHistorySession(t, true)
			if err := mgr.CloseAll(context.Background()); err != nil {
				t.Fatal(err)
			}
			path := s.SessionFile()
			f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0600)
			if err != nil {
				t.Fatal(err)
			}
			entry := map[string]any{"type": kind, "id": "offline-boundary", "parentId": "cached-turn", "summary": "new content", "tokensBefore": 45000, "firstKeptEntryId": "root"}
			raw, err := json.Marshal(entry)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := f.Write(append(raw, '\n')); err != nil {
				t.Fatal(err)
			}
			if scenario.followedByRequest {
				request, err := json.Marshal(map[string]any{"type": "message", "id": "offline-request", "parentId": "offline-boundary", "message": cacheMessage(1500, "m", 0, 30000, 0, 0, 0)["message"]})
				if err != nil {
					t.Fatal(err)
				}
				if _, err := f.Write(append(request, '\n')); err != nil {
					t.Fatal(err)
				}
			}
			if err := f.Close(); err != nil {
				t.Fatal(err)
			}
			d := newDaemon(t)
			if err := d.LoadSessionFile(path); err != nil {
				t.Fatal(err)
			}
			restarted := testManager(t, dial(t, d), mgr.cfg.Store, 64)
			restarted.cfg.NoticeDir = mgr.cfg.NoticeDir
			pane := &synchronousApprovalRecorder{recorder: newRecorder(64)}
			rebuilt, _, detach := acquire(t, restarted, chat, pane)
			t.Cleanup(detach)
			if rebuilt.ID() != s.ID() {
				t.Fatal("durable identity changed")
			}
			// Confirm real history hydration delivered the new boundary.
			found := false
			for _, frame := range drainSync(pane.recorder) {
				if page, ok := frame.Data.(EntriesFrame); ok {
					for _, raw := range page.Entries {
						var e map[string]any
						if err := json.Unmarshal(raw, &e); err != nil {
							t.Fatal(err)
						}
						found = found || e["id"] == "offline-boundary"
					}
				}
			}
			if !found {
				t.Fatal("updated boundary not hydrated")
			}
			rebuilt.lifecycleMu.Lock()
			baseline := rebuilt.transcriptNotices.previous
			rebuilt.lifecycleMu.Unlock()
			if scenario.followedByRequest {
				if baseline == nil || baseline.Timestamp != 1500 || baseline.PromptTokens != 30000 || !baseline.ReportedCache {
					t.Fatalf("post-boundary request not reconstructed: %+v", baseline)
				}
				injectEvent(t, rebuilt, cacheMessage(2000, "m", 30000, 0, 0, 0.3, 0))
				if got := len(reviewNoticePayloads(rebuilt, "cache_miss")); got != 1 {
					t.Fatalf("post-boundary request lost cache baseline: got %d misses", got)
				}
				return
			}
			if baseline != nil {
				t.Fatalf("new boundary did not reset restored checkpoint: %+v", baseline)
			}
			injectEvent(t, rebuilt, cacheMessage(2000, "m", 45000, 0, 0, 0.45, 0))
			if got := reviewNoticePayloads(rebuilt, "cache_miss"); len(got) != 0 {
				t.Fatalf("new %s did not reset restored checkpoint: false cache misses=%v", kind, got)
			}
		})
	}
}

// Control: keeping a real nil reset through replay is important too.
func TestR2NilCheckpointSurvivesRestartReplay(t *testing.T) {
	s, mgr, chat := reviewHistorySession(t, true)
	injectEvent(t, s, map[string]any{"type": "entry_appended", "entry": map[string]any{"type": "branch_summary", "id": "live-boundary"}})
	if err := mgr.CloseAll(context.Background()); err != nil {
		t.Fatal(err)
	}
	restarted := testManager(t, mgr.cfg.Client, mgr.cfg.Store, 64)
	restarted.cfg.NoticeDir = mgr.cfg.NoticeDir
	rebuilt, _, detach := acquire(t, restarted, chat, &synchronousApprovalRecorder{recorder: newRecorder(64)})
	t.Cleanup(detach)
	rebuilt.lifecycleMu.Lock()
	baseline := rebuilt.transcriptNotices.previous
	rebuilt.lifecycleMu.Unlock()
	if baseline != nil {
		t.Fatalf("old replay resurrected reset checkpoint: %+v", baseline)
	}
	injectEvent(t, rebuilt, cacheMessage(2000, "m", 45000, 0, 0, 0.45, 0))
	if got := len(reviewNoticePayloads(rebuilt, "cache_miss")); got != 0 {
		t.Fatalf("got %d false misses", got)
	}
}

func TestR2EvictedMessageIdentitySurvivesRestart(t *testing.T) {
	s, mgr, chat := reviewHistorySession(t, false)
	first := cacheMessage(1000, "m", 0, 45000, 0, 0, 0)
	second := cacheMessage(2000, "m", 45000, 0, 0, 0.45, 0)
	injectEvent(t, s, first)
	injectEvent(t, s, second)
	for i := 0; i < NoticeJournalCapacity; i++ {
		mgr.RecordNotice(chat.id, map[string]any{"kind": "engine_warning", "text": fmt.Sprint(i)})
	}
	if got := len(reviewNoticePayloads(s, "cache_miss")); got != 0 {
		t.Fatal("setup did not evict cache notice")
	}
	before := mgr.noticeReplay(chat.id)
	if err := mgr.CloseAll(context.Background()); err != nil {
		t.Fatal(err)
	}
	restarted := testManager(t, mgr.cfg.Client, mgr.cfg.Store, 64)
	restarted.cfg.NoticeDir = mgr.cfg.NoticeDir
	rebuilt, _, detach := acquire(t, restarted, chat, &synchronousApprovalRecorder{recorder: newRecorder(128)})
	t.Cleanup(detach)
	injectEvent(t, rebuilt, first)
	injectEvent(t, rebuilt, second)
	if after := restarted.noticeReplay(chat.id); !reflect.DeepEqual(after, before) {
		t.Fatal("ring eviction made source identity eligible again")
	}
	rebuilt.lifecycleMu.Lock()
	baseline := rebuilt.transcriptNotices.previous
	rebuilt.lifecycleMu.Unlock()
	if baseline == nil || baseline.Timestamp != 2000 {
		t.Fatalf("redelivery rewound baseline: %+v", baseline)
	}
}
