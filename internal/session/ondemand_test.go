package session

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"path/filepath"
	"strings"
	"testing"

	"github.com/DevNewbie1826/omo-webchat/internal/coldhistory"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc/omorpctest"
)

type onDemandRecorder struct {
	*capabilityRecorder
	resume *coldhistory.ResumeCursor
}

func (r *onDemandRecorder) OnDemandHistory() bool { return true }
func (r *onDemandRecorder) HistoryResume() *coldhistory.ResumeCursor {
	return r.resume
}

func attachOnDemandTail(t *testing.T, d *omorpctest.Daemon, mgr *Manager, store *memCursorStore, chatID, path, leafID string, cursor *coldhistory.ResumeCursor) (*Session, *onDemandRecorder, func()) {
	t.Helper()
	store.cursors[chatID] = Cursor{SessionFile: path}
	baseline := d.RequestCountForPath(omorpc.CmdGetEntries, path)
	release := d.BlockHandlerForPath(omorpc.CmdGetEntries, path)
	sub := &onDemandRecorder{
		capabilityRecorder: &capabilityRecorder{recorder: *newRecorder(1024), progressive: true},
		resume:             cursor,
	}
	type result struct {
		sess   *Session
		detach func()
		err    error
	}
	done := make(chan result, 1)
	go func() {
		sess, _, detach, err := mgr.Acquire(context.Background(), testChat{id: chatID, cwd: filepath.Dir(path)}, sub)
		done <- result{sess: sess, detach: detach, err: err}
	}()
	if !d.AwaitRequestCountForPath(omorpc.CmdGetEntries, path, baseline+1, testTimeout) {
		t.Fatal("incremental tail request absent")
	}
	request := d.LastRequest(omorpc.CmdGetEntries)
	id, _ := request["id"].(string)
	sid, _ := request["sessionId"].(string)
	d.WriteRaw(fmt.Appendf(nil, `{"id":%q,"type":"response","command":"get_entries","sessionId":%q,"success":true,"data":{"entries":[],"leafId":%q}}`+"\n", id, sid, leafID))
	got := <-done
	release()
	if got.err != nil {
		t.Fatal(got.err)
	}
	return got.sess, sub, got.detach
}

func TestOnDemandAttachSendsTailAndTerminalWithoutWarmPages(t *testing.T) {
	for _, tc := range []struct {
		name, notice string
		count        int
		start        int
		complete     bool
	}{
		{name: "long branch", count: 200, start: 140, notice: "Session compacted 2 times"},
		{name: "short branch", count: 40, start: 0, complete: true, notice: "Session compacted 1 time"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := newDaemon(t)
			store := newMemStore()
			mgr := testManager(t, dial(t, d), store, 64)
			path, leaf := writeProgressiveFixture(t, t.TempDir(), "branch.jsonl", tc.count, 0, 10, 70)

			sess, sub, detach := attachOnDemandTail(t, d, mgr, store, "on-demand", path, leaf, nil)
			defer detach()
			pages, notices := collectMarkedHydration(t, sess, sub.capabilityRecorder)

			if len(pages) != 2 {
				t.Fatalf("pages = %d, want bounded tail and terminal only", len(pages))
			}
			assertIDs(t, pageEntryIDs(t, pages[0]), wantIDs(tc.start, tc.count))
			if pages[0].Final || pages[0].Segment != "" || pages[0].HistoryComplete != nil {
				t.Fatalf("bounded tail page = %+v", pages[0])
			}
			terminal := pages[1]
			if !terminal.Final || terminal.Segment != "" || terminal.LeafID != leaf || len(terminal.Entries) != 0 || terminal.HistoryComplete == nil || *terminal.HistoryComplete != tc.complete {
				t.Fatalf("terminal = %+v, want historyComplete=%t", terminal, tc.complete)
			}
			if len(notices) != 1 || notices[0] != tc.notice {
				t.Fatalf("compaction notices = %v, want %q", notices, tc.notice)
			}
			if tc.count > hydrationTailBudget {
				v3Session, v3Sub, v3Detach := attachScriptedTail(t, d, mgr, store, "progressive", path, "", leaf, true)
				defer v3Detach()
				_, v3Notices := collectMarkedHydration(t, v3Session, v3Sub)
				if len(v3Notices) != 1 || notices[0] != v3Notices[0] {
					t.Fatalf("v4 notices %v differ from v3 %v", notices, v3Notices)
				}
			}
		})
	}
}

func TestOnDemandAttachBoundsFreshTailByEntryBytes(t *testing.T) {
	for _, tc := range []struct {
		name     string
		count    int
		padding  int
		wantTail int
	}{
		{name: "300 KiB entries", count: 8, padding: 300 << 10, wantTail: 3},
		{name: "entry over 1 MiB", count: 2, padding: 2 << 20, wantTail: 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			// Given a durable branch whose newest entries exceed one MiB together.
			d := newDaemon(t)
			store := newMemStore()
			mgr := testManager(t, dial(t, d), store, 64)
			path, leaf := writeProgressiveFixture(t, t.TempDir(), "wide.jsonl", tc.count, tc.padding)

			// When a v4 client opens without a resume cursor.
			sess, sub, detach := attachOnDemandTail(t, d, mgr, store, "wide", path, leaf, nil)
			defer detach()
			pages, _ := collectMarkedHydration(t, sess, sub.capabilityRecorder)

			// Then only the newest byte-bounded range precedes the terminal.
			var ids []string
			totalBytes := 0
			for _, page := range pages[:len(pages)-1] {
				ids = append(ids, pageEntryIDs(t, page)...)
				for _, raw := range page.Entries {
					totalBytes += len(raw)
				}
			}
			assertIDs(t, ids, wantIDs(tc.count-tc.wantTail, tc.count))
			if totalBytes > 1<<20 && tc.wantTail != 1 {
				t.Fatalf("tail entry JSON = %d bytes, want at most 1 MiB", totalBytes)
			}
			if tc.wantTail == 1 && totalBytes <= 1<<20 {
				t.Fatalf("oversized entry = %d bytes, want over 1 MiB", totalBytes)
			}
			terminal := pages[len(pages)-1]
			if !terminal.Final || terminal.HistoryComplete == nil || *terminal.HistoryComplete {
				t.Fatalf("partial tail terminal = %+v, want historyComplete=false", terminal)
			}
		})
	}
}

func TestOnDemandResumeUsesCursorFirstIndexForCompletion(t *testing.T) {
	for _, tc := range []struct {
		name, first string
		complete    bool
	}{
		{name: "root cursor", first: "entry-0000", complete: true},
		{name: "partial cursor", first: "entry-0030", complete: false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := newDaemon(t)
			store := newMemStore()
			mgr := testManager(t, dial(t, d), store, 64)
			path, leaf := writeProgressiveFixture(t, t.TempDir(), "resume.jsonl", 200, 0, 10, 70)
			sum := sha256.Sum256([]byte(path))
			cursor := &coldhistory.ResumeCursor{
				SessionID:    "durable-" + hex.EncodeToString(sum[:4]) + "-7d24-4b1e-resume",
				FirstEntryID: tc.first,
				LastEntryID:  "entry-0149",
			}

			sess, sub, detach := attachOnDemandTail(t, d, mgr, store, "resumed", path, leaf, cursor)
			defer detach()
			pages, notices := collectMarkedHydration(t, sess, sub.capabilityRecorder)

			if len(pages) != 2 {
				t.Fatalf("resume pages = %d, want one range and terminal", len(pages))
			}
			assertIDs(t, pageEntryIDs(t, pages[0]), wantIDs(150, 200))
			if pages[1].Resume == nil || pages[1].HistoryComplete == nil || *pages[1].HistoryComplete != tc.complete {
				t.Fatalf("resume terminal = %+v, want historyComplete=%t", pages[1], tc.complete)
			}
			if len(notices) != 1 || notices[0] != "Session compacted 2 times" {
				t.Fatalf("resume compaction notices = %v", notices)
			}
		})
	}
}

func TestEntryAppendedPublishesOnlyMessageEntriesWithUnicodePrefix(t *testing.T) {
	d := newDaemon(t)
	store := newMemStore()
	mgr := testManager(t, dial(t, d), store, 64)
	path, leaf := writeProgressiveFixture(t, t.TempDir(), "entry.jsonl", 1, 0)
	s, sub, detach := attachOnDemandTail(t, d, mgr, store, "on-demand-entry", path, leaf, nil)
	defer detach()
	collectMarkedHydration(t, s, sub.capabilityRecorder)
	text := strings.Repeat("한", 127) + "🌐" + "not included"
	for _, entry := range []map[string]any{
		{"type": "custom", "id": "other", "customType": "unknown"},
		{"type": "message", "id": "message-1", "parentId": "parent-1", "message": map[string]any{
			"role": "assistant", "content": []any{
				map[string]any{"type": "text", "text": strings.Repeat("한", 127)},
				map[string]any{"type": "toolCall", "text": "ignored"},
				map[string]any{"type": "text", "text": "🌐not included"},
			},
		}},
		{"type": "message", "id": "message-2", "parentId": nil, "message": map[string]any{"role": "user", "content": "plain"}},
	} {
		injectEvent(t, s, map[string]any{"type": "entry_appended", "entry": entry})
	}
	frames := publishCompactionMarker(t, s, &sub.capabilityRecorder.recorder)
	var appended []EntryAppendedInfo
	for _, frame := range frames {
		if frame.Kind == FrameEntryAppended {
			appended = append(appended, frame.Data.(EntryAppendedInfo))
		}
	}
	if len(appended) != 2 || appended[0].ID != "message-1" || appended[0].ParentID == nil || *appended[0].ParentID != "parent-1" || appended[0].Role != "assistant" || appended[0].TextPrefix != string([]rune(text)[:128]) {
		t.Fatalf("message entry projection = %+v", appended)
	}
	if appended[1].ID != "message-2" || appended[1].ParentID != nil || appended[1].TextPrefix != "plain" {
		t.Fatalf("plain message entry projection = %+v", appended[1])
	}
}

func TestHistoryQuarantinedReportsExternalWrite(t *testing.T) {
	s := &Session{}
	if s.HistoryQuarantined() {
		t.Fatal("fresh session reported quarantine")
	}
	s.quarantineExternalWrite(&ExternalWriteError{Reason: "external write"}, nil)
	s.resumable = true
	if !s.HistoryQuarantined() {
		t.Fatal("external write quarantine disappeared after resumable transition")
	}
}
