package session

import (
	"context"
	"encoding/json"
	"os"
	"testing"
)

// A checkpoint later in retained file order still wins when its source is
// off-branch and the selected ancestry contains an older boundary.
func TestNoticeNewerOffBranchCheckpointSuppressesOldBoundary(t *testing.T) {
	for _, kind := range []string{"compaction", "branch_summary"} {
		t.Run(kind, func(t *testing.T) {
			s, mgr, chat := reviewHistorySession(t, true)
			request := cacheMessage(1500, "m", 0, 30000, 0, 0, 0)
			injectEvent(t, s, request)
			if err := mgr.CloseAll(context.Background()); err != nil {
				t.Fatal(err)
			}
			path := s.SessionFile()
			f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0600)
			if err != nil {
				t.Fatal(err)
			}
			encoder := json.NewEncoder(f)
			for _, entry := range []map[string]any{
				{"type": kind, "id": "older-boundary", "parentId": "root", "summary": "branch", "tokensBefore": 45000, "firstKeptEntryId": "root"},
				{"type": "message", "id": "newer-request", "parentId": "cached-turn", "message": request["message"]},
				{"type": "message", "id": "selected-leaf", "parentId": "older-boundary", "message": map[string]any{"role": "user", "content": "continue"}},
			} {
				if err := encoder.Encode(entry); err != nil {
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
			found := false
			for _, frame := range drainSync(pane.recorder) {
				if frame.Kind == FrameError {
					t.Fatalf("hydration error: %+v", frame.Data)
				}
				if page, ok := frame.Data.(EntriesFrame); ok {
					for _, raw := range page.Entries {
						var entry map[string]any
						if err := json.Unmarshal(raw, &entry); err != nil {
							t.Fatal(err)
						}
						if entry["id"] == "newer-request" {
							t.Fatal("checkpoint unexpectedly on active ancestry")
						}
						found = found || entry["id"] == "older-boundary"
					}
				}
			}
			if !found || rebuilt.ID() != s.ID() {
				t.Fatal("expected same conversation with older boundary delivered")
			}
			rebuilt.lifecycleMu.Lock()
			baseline := rebuilt.transcriptNotices.previous
			rebuilt.lifecycleMu.Unlock()
			if baseline == nil || baseline.Timestamp != 1500 || baseline.PromptTokens != 30000 || !baseline.ReportedCache {
				t.Fatalf("older boundary replaced newer off-branch checkpoint: %+v", baseline)
			}
			injectEvent(t, rebuilt, cacheMessage(2000, "m", 30000, 0, 0, 0.3, 0))
			if got := len(reviewNoticePayloads(rebuilt, "cache_miss")); got != 1 {
				t.Fatalf("newer checkpoint lost: got %d cache misses", got)
			}
		})
	}
}
