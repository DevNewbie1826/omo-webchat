package sendqueue

import (
	"errors"
	"fmt"
	"path/filepath"
	"sync"
	"testing"
)

func TestStoreRestartRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "queue-v1.json")
	store, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	requestID := "request-1"
	id, revision, err := store.Append("chat-1", Item{Text: "first", Images: []map[string]string{{"data": "abc", "mimeType": "image/png"}}, RequestID: requestID, CreatedAt: 1234})
	if err != nil {
		t.Fatal(err)
	}
	if id == "" || revision != 1 {
		t.Fatalf("append = (%q, %d), want generated id and revision 1", id, revision)
	}

	restarted, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	snapshot := restarted.Snapshot("chat-1")
	if snapshot.Revision != 1 || len(snapshot.Items) != 1 {
		t.Fatalf("restart snapshot = %+v", snapshot)
	}
	item := snapshot.Items[0]
	if item.ID != id || item.Text != "first" || item.RequestID != requestID || !item.HasImage || len(item.Images) != 1 {
		t.Fatalf("restart item = %+v", item)
	}
}

func TestConcurrentAppendAndClaimHeadPreservesEveryItem(t *testing.T) {
	store, err := Load(filepath.Join(t.TempDir(), "queue-v1.json"))
	if err != nil {
		t.Fatal(err)
	}
	const count = 40
	var appendWG sync.WaitGroup
	for i := 0; i < count; i++ {
		appendWG.Add(1)
		go func(i int) {
			defer appendWG.Done()
			if _, _, err := store.Append("chat-1", Item{Text: fmt.Sprintf("item-%d", i)}); err != nil {
				t.Errorf("append: %v", err)
			}
		}(i)
	}
	appendWG.Wait()

	claimed := make(chan Item, count)
	var claimWG sync.WaitGroup
	for i := 0; i < count; i++ {
		claimWG.Add(1)
		go func() {
			defer claimWG.Done()
			item, ok, err := store.ClaimHead("chat-1")
			if err != nil {
				t.Errorf("claim head: %v", err)
			} else if ok {
				claimed <- item
			}
		}()
	}
	claimWG.Wait()
	close(claimed)

	seen := make(map[string]bool, count)
	for item := range claimed {
		if seen[item.ID] {
			t.Fatalf("item %q claimed twice", item.ID)
		}
		seen[item.ID] = true
	}
	if len(seen) != count {
		t.Fatalf("claimed %d items, want %d; remaining=%+v", len(seen), count, store.Snapshot("chat-1"))
	}
}

func TestRemoveMoveClear(t *testing.T) {
	store, err := Load(filepath.Join(t.TempDir(), "queue-v1.json"))
	if err != nil {
		t.Fatal(err)
	}
	first, _, err := store.Append("chat", Item{Text: "first"})
	if err != nil {
		t.Fatal(err)
	}
	second, _, err := store.Append("chat", Item{Text: "second"})
	if err != nil {
		t.Fatal(err)
	}
	third, _, err := store.Append("chat", Item{Text: "third"})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Move("chat", third, 0); err != nil {
		t.Fatal(err)
	}
	if got := store.Snapshot("chat").Items; len(got) != 3 || got[0].ID != third || got[1].ID != first || got[2].ID != second {
		t.Fatalf("move result = %+v", got)
	}
	if err := store.Remove("chat", first); err != nil {
		t.Fatal(err)
	}
	if err := store.Remove("chat", first); err != ErrItemNotFound {
		t.Fatalf("second remove error = %v, want ErrItemNotFound", err)
	}
	if err := store.Clear("chat"); err != nil {
		t.Fatal(err)
	}
	if got := store.Snapshot("chat"); len(got.Items) != 0 || got.Revision != 6 {
		t.Fatalf("clear snapshot = %+v, want revision 6", got)
	}
}

func TestAppendPersistenceFailureReturnsErrorAndPreservesPriorState(t *testing.T) {
	path := filepath.Join(t.TempDir(), "queue-v1.json")
	store, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.Append("chat", Item{Text: "prior"}); err != nil {
		t.Fatal(err)
	}
	writeErr := errors.New("injected write failure")
	store.persistHook = func(stage string) error {
		if stage == "write" {
			return writeErr
		}
		return nil
	}

	id, revision, err := store.Append("chat", Item{Text: "new"})
	if !errors.Is(err, writeErr) || id != "" || revision != 1 {
		t.Fatalf("append = (%q, %d, %v), want empty id, revision 1, injected error", id, revision, err)
	}
	if got := store.Snapshot("chat"); got.Revision != 1 || len(got.Items) != 1 || got.Items[0].Text != "prior" {
		t.Fatalf("snapshot after failed append = %+v", got)
	}
	store.persistHook = nil
	restarted, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := restarted.Snapshot("chat"); got.Revision != 1 || len(got.Items) != 1 || got.Items[0].Text != "prior" {
		t.Fatalf("durable snapshot after failed append = %+v", got)
	}
}

func TestClaimHeadPersistenceFailureIsNotEmptyAndPreservesItem(t *testing.T) {
	store, err := Load(filepath.Join(t.TempDir(), "queue-v1.json"))
	if err != nil {
		t.Fatal(err)
	}
	if item, ok, err := store.ClaimHead("chat"); err != nil || ok || item.ID != "" {
		t.Fatalf("empty claim head = (%+v, %v, %v), want zero item, false, nil", item, ok, err)
	}
	id, _, err := store.Append("chat", Item{Text: "queued"})
	if err != nil {
		t.Fatal(err)
	}
	renameErr := errors.New("injected rename failure")
	store.persistHook = func(stage string) error {
		if stage == "rename" {
			return renameErr
		}
		return nil
	}

	item, ok, err := store.ClaimHead("chat")
	if !errors.Is(err, renameErr) || ok || item.ID != "" {
		t.Fatalf("claim head = (%+v, %v, %v), want zero item, false, injected error", item, ok, err)
	}
	if got := store.Snapshot("chat"); got.Revision != 1 || len(got.Items) != 1 || got.Items[0].ID != id {
		t.Fatalf("snapshot after failed claim = %+v", got)
	}
}

func TestRestoreHeadAndBumpPersistenceFailuresSurface(t *testing.T) {
	store, err := Load(filepath.Join(t.TempDir(), "queue-v1.json"))
	if err != nil {
		t.Fatal(err)
	}
	id, _, err := store.Append("chat", Item{Text: "queued"})
	if err != nil {
		t.Fatal(err)
	}
	item, ok, err := store.ClaimHead("chat")
	if err != nil || !ok || item.ID != id {
		t.Fatalf("claim head = (%+v, %v, %v)", item, ok, err)
	}

	syncErr := errors.New("injected file sync failure")
	store.persistHook = func(stage string) error {
		if stage == "sync-file" {
			return syncErr
		}
		return nil
	}
	if revision, err := store.RestoreHead("chat", item); !errors.Is(err, syncErr) || revision != 2 {
		t.Fatalf("restore head = (%d, %v), want revision 2 and injected error", revision, err)
	}
	if got := store.Snapshot("chat"); got.Revision != 2 || len(got.Items) != 0 {
		t.Fatalf("snapshot after failed restore = %+v", got)
	}

	store.persistHook = func(stage string) error {
		if stage == "write" {
			return syncErr
		}
		return nil
	}
	if revision, err := store.Bump("chat"); !errors.Is(err, syncErr) || revision != 2 {
		t.Fatalf("bump = (%d, %v), want revision 2 and injected error", revision, err)
	}
	if got := store.Snapshot("chat"); got.Revision != 2 || len(got.Items) != 0 {
		t.Fatalf("snapshot after failed bump = %+v", got)
	}
}

func TestDispatchStateSurvivesRestartUntilAccepted(t *testing.T) {
	path := filepath.Join(t.TempDir(), "queue-v1.json")
	store, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.Append("chat", Item{Text: "first", RequestID: "browser-request"}); err != nil {
		t.Fatal(err)
	}
	item, ok, err := store.BeginDispatch("chat")
	if err != nil || !ok || item.DeliveryID == "" {
		t.Fatalf("begin dispatch = (%+v, %v, %v)", item, ok, err)
	}

	restarted, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	retried, ok, err := restarted.BeginDispatch("chat")
	if err != nil || !ok || retried.ID != item.ID || retried.DeliveryID != item.DeliveryID || retried.RequestID != item.RequestID {
		t.Fatalf("restart dispatch = (%+v, %v, %v), want same item and delivery ID", retried, ok, err)
	}
	if _, err := restarted.CompleteDispatch("chat", item.DeliveryID); err != nil {
		t.Fatal(err)
	}
	accepted, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := accepted.Snapshot("chat"); got.Dispatching != nil || len(got.Items) != 0 {
		t.Fatalf("accepted dispatch survived restart: %+v", got)
	}
}

func TestRestoreDispatchPreservesHeadOrdering(t *testing.T) {
	store, err := Load(filepath.Join(t.TempDir(), "queue-v1.json"))
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.Append("chat", Item{Text: "A"}); err != nil {
		t.Fatal(err)
	}
	item, _, err := store.BeginDispatch("chat")
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.Append("chat", Item{Text: "B"}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.RestoreDispatch("chat", item.DeliveryID); err != nil {
		t.Fatal(err)
	}
	got := store.Snapshot("chat")
	if got.Dispatching != nil || len(got.Items) != 2 || got.Items[0].Text != "A" || got.Items[1].Text != "B" {
		t.Fatalf("restored queue = %+v, want A then B", got)
	}
}

func TestDeleteRemovesChatFromDiskState(t *testing.T) {
	path := filepath.Join(t.TempDir(), "queue-v1.json")
	store, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.Append("deleted", Item{Text: "orphan"}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.Append("retained", Item{Text: "keep"}); err != nil {
		t.Fatal(err)
	}
	if err := store.Delete("deleted"); err != nil {
		t.Fatal(err)
	}
	restarted, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := restarted.Snapshot("deleted"); got.Revision != 0 || got.Dispatching != nil || len(got.Items) != 0 {
		t.Fatalf("deleted chat remains on disk: %+v", got)
	}
	if got := restarted.Snapshot("retained"); len(got.Items) != 1 || got.Items[0].Text != "keep" {
		t.Fatalf("unrelated queue changed: %+v", got)
	}
}

func TestPersistSyncsParentDirectory(t *testing.T) {
	store, err := Load(filepath.Join(t.TempDir(), "queue-v1.json"))
	if err != nil {
		t.Fatal(err)
	}
	var stages []string
	store.persistHook = func(stage string) error {
		stages = append(stages, stage)
		return nil
	}
	if _, _, err := store.Append("chat", Item{Text: "queued"}); err != nil {
		t.Fatal(err)
	}
	if len(stages) == 0 || stages[len(stages)-1] != "sync-dir" {
		t.Fatalf("persistence stages = %v, want final parent directory sync", stages)
	}
}
