package session

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"reflect"
	"testing"
)

// Unlike the original linear suffix, a genuinely new branch can leave the
// checkpoint source on abandoned ancestry. The file is only changed while
// stopped; acquisition must validate and deliver the new active branch.
func TestR3OfflineBranchWithoutActiveCheckpointAnchor(t *testing.T) {
	for _, kind := range []string{"compaction", "branch_summary"} {
		for _, followedByRequest := range []bool{false, true} {
			for _, freshJournal := range []bool{false, true} {
				t.Run(fmt.Sprintf("%s/request=%t/freshJournal=%t", kind, followedByRequest, freshJournal), func(t *testing.T) {
					s, mgr, chat := reviewHistorySession(t, true)
					if err := mgr.CloseAll(context.Background()); err != nil {
						t.Fatal(err)
					}
					path := s.SessionFile()
					f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0600)
					if err != nil {
						t.Fatal(err)
					}
					encoder := json.NewEncoder(f)
					// Same file order as round 2, but branch from root instead of
					// cached-turn. Neither the old compaction nor cached-turn is
					// an ancestor of the new leaf; both remain in the JSONL file.
					if err := encoder.Encode(map[string]any{"type": kind, "id": "offline-boundary", "parentId": "root", "summary": "new branch", "tokensBefore": 45000, "firstKeptEntryId": "root"}); err != nil {
						t.Fatal(err)
					}
					if followedByRequest {
						if err := encoder.Encode(map[string]any{"type": "message", "id": "offline-request", "parentId": "offline-boundary", "message": cacheMessage(1500, "m", 0, 30000, 0, 0, 0)["message"]}); err != nil {
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
					if freshJournal {
						restarted.cfg.NoticeDir = t.TempDir()
					}
					pane := &synchronousApprovalRecorder{recorder: newRecorder(64)}
					rebuilt, _, detach := acquire(t, restarted, chat, pane)
					t.Cleanup(detach)
					if rebuilt.ID() != s.ID() {
						t.Fatal("durable identity changed")
					}
					found, oldSource := false, false
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
								found = found || entry["id"] == "offline-boundary"
								oldSource = oldSource || entry["id"] == "cached-turn"
							}
						}
					}
					if !found || oldSource {
						t.Fatalf("expected new active branch only; new boundary=%t old checkpoint source=%t", found, oldSource)
					}
					rebuilt.lifecycleMu.Lock()
					baseline := rebuilt.transcriptNotices.previous
					rebuilt.lifecycleMu.Unlock()
					// Read a separate journal instance so this checks the persisted
					// checkpoint, not just the manager's in-memory state.
					diskManager := testManager(t, restarted.cfg.Client, restarted.cfg.Store, 64)
					diskManager.cfg.NoticeDir = restarted.cfg.NoticeDir
					journal := diskManager.noticeJournal(chat.id)
					journal.mu.Lock()
					persisted := journal.transcripts[rebuilt.ID()]
					journal.mu.Unlock()
					if !reflect.DeepEqual(persisted.Previous, baseline) || persisted.Source == s.transcriptNotices.source {
						t.Fatalf("stale checkpoint persisted: %+v; baseline=%+v", persisted, baseline)
					}
					if followedByRequest {
						if baseline == nil || baseline.Timestamp != 1500 || baseline.PromptTokens != 30000 || !baseline.ReportedCache {
							t.Fatalf("new branch request lost: baseline=%+v; want timestamp=1500 prompt=30000 reportedCache=true", baseline)
						}
						return
					}
					if baseline != nil {
						t.Fatalf("new branch retained abandoned baseline: %+v", baseline)
					}
					injectEvent(t, rebuilt, cacheMessage(2000, "m", 45000, 0, 0, 0.45, 0))
					if got := reviewNoticePayloads(rebuilt, "cache_miss"); len(got) != 0 {
						t.Fatalf("new %s on different ancestry failed to reset: false notices=%v", kind, got)
					}
				})
			}
		}
	}
}
