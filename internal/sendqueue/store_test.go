package sendqueue

import (
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
	id, revision := store.Append("chat-1", Item{Text: "first", Images: []map[string]string{{"data": "abc", "mimeType": "image/png"}}, RequestID: requestID, CreatedAt: 1234})
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
			store.Append("chat-1", Item{Text: fmt.Sprintf("item-%d", i)})
		}(i)
	}
	appendWG.Wait()

	claimed := make(chan Item, count)
	var claimWG sync.WaitGroup
	for i := 0; i < count; i++ {
		claimWG.Add(1)
		go func() {
			defer claimWG.Done()
			if item, ok := store.ClaimHead("chat-1"); ok {
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
	first, _ := store.Append("chat", Item{Text: "first"})
	second, _ := store.Append("chat", Item{Text: "second"})
	third, _ := store.Append("chat", Item{Text: "third"})
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
	store.Clear("chat")
	if got := store.Snapshot("chat"); len(got.Items) != 0 || got.Revision != 6 {
		t.Fatalf("clear snapshot = %+v, want revision 6", got)
	}
}
