package session

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

func writeHistorySession(t *testing.T, entries, padding int) (path, leafID string) {
	t.Helper()
	path = filepath.Join(t.TempDir(), "large-session.jsonl")
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	writer := bufio.NewWriterSize(file, 256<<10)
	encoder := json.NewEncoder(writer)
	if err := encoder.Encode(map[string]any{
		"type": "session", "version": 3, "id": "history-session",
		"timestamp": "2026-09-02T00:00:00.000Z", "cwd": filepath.Dir(path),
	}); err != nil {
		t.Fatal(err)
	}
	parent := any(nil)
	body := strings.Repeat("x", padding)
	for i := 0; i < entries; i++ {
		id := fmt.Sprintf("entry-%04d", i)
		entry := map[string]any{
			"type": "message", "id": id, "parentId": parent,
			"timestamp": "2026-09-02T00:00:00.001Z",
			"message": map[string]any{
				"role":    "user",
				"content": []any{map[string]any{"type": "text", "text": body}},
			},
		}
		if err := encoder.Encode(entry); err != nil {
			t.Fatal(err)
		}
		parent, leafID = id, id
	}
	if err := writer.Flush(); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	return path, leafID
}

func awaitHistoryLeaf(t *testing.T, sub *recorder, leafID string, timeout time.Duration) int {
	t.Helper()
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	total := 0
	for {
		select {
		case frame := <-sub.ch:
			if frame.Kind == FrameError {
				if info, ok := frame.Data.(ErrorInfo); ok && info.Code == "provider_disconnected" {
					t.Fatalf("history load invalidated the provider epoch: %+v", info)
				}
			}
			if frame.Kind != FrameEntries {
				continue
			}
			entries, ok := frame.Data.(EntriesFrame)
			if !ok {
				t.Fatalf("entries frame has unexpected data: %#v", frame.Data)
			}
			total += len(entries.Entries)
			if entries.Final && entries.LeafID == leafID {
				return total
			}
		case <-timer.C:
			t.Fatalf("timed out waiting for disk history leaf %q", leafID)
			return 0
		}
	}
}

// Live protocol probing showed that resume is fast while a full transcript
// request for a large session can outlive an interactive caller deadline.
func TestHistoryHybridLargeResumeHydratesWithoutKillingEpoch(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	store := newMemStore()
	mgr := testManager(t, client, store, 128)

	siblingSub := newRecorder(16)
	sibling, _, siblingDetach := acquire(t, mgr, testChat{id: "sibling", cwd: t.TempDir()}, siblingSub)
	defer siblingDetach()
	siblingSub.next(t) // ready

	const entryCount = 1100
	path, leafID := writeHistorySession(t, entryCount, 3<<10)
	if info, err := os.Stat(path); err != nil || info.Size() < 3<<20 {
		t.Fatalf("large history fixture size = %v, %v", info, err)
	}
	if err := store.SaveCursor(context.Background(), "large", Cursor{SessionFile: path}); err != nil {
		t.Fatal(err)
	}

	releaseHistory := d.BlockHandlerForPath(omorpc.CmdGetEntries, path)
	defer releaseHistory()
	largeSub := newRecorder(64)
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	large, _, largeDetach, err := mgr.Acquire(ctx, testChat{id: "large", cwd: filepath.Dir(path)}, largeSub)
	cancel()
	if err != nil {
		t.Fatalf("large resume failed: %v", err)
	}
	defer largeDetach()

	for name, sess := range map[string]*Session{"large": large, "sibling": sibling} {
		if sess.Resumable() {
			t.Fatalf("%s session became resumable after the local history deadline", name)
		}
		queryCtx, queryCancel := context.WithTimeout(context.Background(), time.Second)
		_, queryErr := sess.QueryState(queryCtx)
		queryCancel()
		if queryErr != nil {
			t.Fatalf("%s session is no longer routable: %v", name, queryErr)
		}
	}
	if got := d.CloseCount(); got != 0 {
		t.Fatalf("history failure closed %d provider sessions", got)
	}
	if got := awaitHistoryLeaf(t, largeSub, leafID, testTimeout); got != entryCount {
		t.Fatalf("hydrated entries = %d, want %d", got, entryCount)
	}
	_, historyErr := largeSub.awaitError(t, "provider_timeout")
	if info := historyErr.Data.(ErrorInfo); !strings.Contains(info.Message, "history load failed") {
		t.Fatalf("history deadline error = %+v", info)
	}
}

func TestHistoryHybridColdHydrationNeverRequestsFullDump(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	store := newMemStore()
	mgr := testManager(t, client, store, 64)

	path, leafID := writeHistorySession(t, 3, 0)
	if err := store.SaveCursor(context.Background(), "cold", Cursor{SessionFile: path}); err != nil {
		t.Fatal(err)
	}
	sub := newRecorder(16)
	_, _, detach := acquire(t, mgr, testChat{id: "cold", cwd: filepath.Dir(path)}, sub)
	defer detach()

	for _, request := range d.Requests() {
		if request["type"] != omorpc.CmdGetEntries {
			continue
		}
		since, present := request["since"]
		if !present || since == nil || since == "" {
			t.Fatalf("cold hydration issued full-dump get_entries: %+v", request)
		}
	}
	if got := awaitHistoryLeaf(t, sub, leafID, time.Second); got != 3 {
		t.Fatalf("hydrated entries = %d, want 3", got)
	}
}
