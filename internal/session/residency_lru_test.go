package session

import "testing"

func TestResidencyLRURefreshKeepsDistinctRecentKeys(t *testing.T) {
	// Given two distinct non-resident entries at capacity.
	lru := newResidencyLRU[int](2)
	lru.Put("old", 1)
	lru.Put("recent", 2)

	// When the older entry is refreshed twice, then a third key arrives.
	lru.Put("old", 3)
	lru.Put("old", 4)
	lru.Put("new", 5)

	// Then the refreshed value survives and only the least recent key leaves.
	if got, ok := lru.Get("old"); !ok || got != 4 {
		t.Fatalf("refreshed value = %d, present = %t", got, ok)
	}
	if _, ok := lru.Get("recent"); ok || lru.Len() != 2 || lru.HistoryLen() != 2 {
		t.Fatalf("duplicate refresh consumed a slot: entries=%d history=%d recent=%t", lru.Len(), lru.HistoryLen(), ok)
	}
}

func TestResidencyLRUPinsOutsideCapacityAndUnpinsAsNewest(t *testing.T) {
	// Given a full history and a newly pinned resident.
	lru := newResidencyLRU[string](1)
	lru.Put("old", "old")
	lru.Pin("resident")
	lru.Put("resident", "resident")
	lru.Put("new", "new")

	// When the resident leaves residency after the history filled.
	lru.Unpin("resident")

	// Then it becomes newest, evicts the old unpinned entry, and stays distinct.
	if _, ok := lru.Get("old"); ok {
		t.Fatal("old unpinned identity survived capacity")
	}
	if _, ok := lru.Get("new"); ok {
		t.Fatal("unpin did not make the resident newest")
	}
	if got, ok := lru.Get("resident"); !ok || got != "resident" || lru.HistoryLen() != 1 {
		t.Fatalf("unpin lost resident: %q present=%t history=%d", got, ok, lru.HistoryLen())
	}
}

func TestResidencyLRUAllPinnedDoesNotEvictFreshInsertion(t *testing.T) {
	// Given more pinned identities than the history capacity.
	lru := newResidencyLRU[int](1)
	for i, key := range []string{"first", "second", "third"} {
		lru.Pin(key)
		lru.Put(key, i)
	}

	// When a new unpinned identity is inserted.
	lru.Put("fresh", 4)

	// Then it does not evict itself or any resident.
	if got, ok := lru.Get("fresh"); !ok || got != 4 || lru.Len() != 4 || lru.HistoryLen() != 1 {
		t.Fatalf("fresh lost at pinned capacity: got=%d present=%t entries=%d history=%d", got, ok, lru.Len(), lru.HistoryLen())
	}
	lru.Unpin("first")
	if _, ok := lru.Get("fresh"); ok {
		t.Fatal("newest unpinned identity did not replace the older one")
	}
}

func TestResidencyLRUPinTransitionsAndDeletion(t *testing.T) {
	// Given an entry already in history and a reserved pin with no value.
	lru := newResidencyLRU[int](1)
	lru.Put("moving", 1)
	lru.Pin("moving")
	lru.Pin("empty")
	if _, ok := lru.Get("empty"); ok || lru.HistoryLen() != 0 {
		t.Fatal("pin placeholder became evidence or consumed history")
	}

	// When a pinned entry is updated, the empty pin released, and the entry unpinned.
	lru.Put("moving", 2)
	lru.Unpin("empty")
	lru.Unpin("moving")
	lru.Put("other", 3)

	// Then only the least recent identity leaves; deleting clears both indexes.
	if _, ok := lru.Get("moving"); ok || lru.Len() != 1 || lru.HistoryLen() != 1 {
		t.Fatalf("pin transitions corrupted history: entries=%d history=%d", lru.Len(), lru.HistoryLen())
	}
	lru.Delete("other")
	if lru.Len() != 0 || lru.HistoryLen() != 0 {
		t.Fatalf("delete left evidence: entries=%d history=%d", lru.Len(), lru.HistoryLen())
	}
}
