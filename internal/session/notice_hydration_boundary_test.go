package session

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestNoticeHydrationCountsCompactionsBeforeValidatedMutation(t *testing.T) {
	cwd := t.TempDir()
	path := filepath.Join(cwd, "history.jsonl")
	body := []byte("{\"type\":\"session\",\"id\":\"durable\",\"version\":3}\n" +
		"{\"type\":\"message\",\"id\":\"root\",\"parentId\":null,\"message\":{\"role\":\"user\",\"content\":\"hello\"}}\n" +
		"{\"type\":\"compaction\",\"id\":\"old-branch\",\"parentId\":\"root\",\"summary\":\"old\",\"tokensBefore\":100,\"firstKeptEntryId\":\"root\"}\n" +
		"{\"type\":\"compaction\",\"id\":\"leaf\",\"parentId\":\"root\",\"summary\":\"current\",\"tokensBefore\":100,\"firstKeptEntryId\":\"root\"}\n")
	if err := os.WriteFile(path, body, 0600); err != nil {
		t.Fatal(err)
	}
	d := newDaemon(t)
	if err := d.LoadSessionFile(path); err != nil {
		t.Fatal(err)
	}
	store := newMemStore()
	store.cursors["boundary"] = Cursor{SessionFile: path, DurableSessionID: "durable", InPlace: true}
	mgr := testManager(t, dial(t, d), store, 64)
	mgr.cfg.NoticeDir = t.TempDir()
	pane := newRecorder(64)
	_, _, detach, err := mgr.ResumeInitializedCheckedAndRun(context.Background(), testChat{id: "boundary", cwd: cwd}, pane, nil, func() error { return nil }, func(s *Session) error {
		// The validated callback may start mutating work. Make a later disk
		// reopen fail deterministically while the history reader stays open.
		return os.Rename(path, path+".validated")
	})
	if detach != nil {
		defer detach()
	}
	if err != nil {
		t.Fatal(err)
	}
	frames := mgr.noticeReplay("boundary")
	if len(frames) != 1 {
		t.Fatalf("validated compaction history = %+v, want one notice", frames)
	}
}
