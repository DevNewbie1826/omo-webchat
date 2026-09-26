package session

import (
	"context"
	"fmt"
	"math/rand"
	"slices"
	"testing"
)

func TestPR197R8ResidencyLRUAgainstSequenceModel(t *testing.T) {
	// Given positive capacities and deterministic, independent reference state.
	for _, capacity := range []int{1, 2, 7, 256} {
		t.Run(fmt.Sprintf("capacity_%d", capacity), func(t *testing.T) {
			for seed := int64(0); seed < 8; seed++ {
				lru := newResidencyLRU[int](capacity)
				values := make(map[string]int)
				pins := make(map[string]bool)
				order := []string{}
				rng := rand.New(rand.NewSource(seed))
				keys := make([]string, capacity+7)
				for i := range keys {
					keys[i] = fmt.Sprintf("key-%03d", i)
				}
				for step := 0; step < 2000; step++ {
					key, operation := keys[rng.Intn(len(keys))], rng.Intn(5)
					position := slices.Index(order, key)
					// When arbitrary pin, unpin, refresh, delete, and read operations interleave.
					switch operation {
					case 0:
						lru.Put(key, step)
						values[key] = step
						if !pins[key] {
							if position >= 0 {
								order = slices.Delete(order, position, position+1)
							}
							order = append(order, key)
						}
					case 1:
						lru.Pin(key)
						pins[key] = true
						if position >= 0 {
							order = slices.Delete(order, position, position+1)
						}
					case 2:
						lru.Unpin(key)
						if pins[key] {
							delete(pins, key)
							if _, exists := values[key]; exists {
								order = append(order, key)
							}
						}
					case 3:
						lru.Delete(key)
						delete(values, key)
						delete(pins, key)
						if position >= 0 {
							order = slices.Delete(order, position, position+1)
						}
					case 4:
						lru.Get(key)
					}
					for len(order) > capacity {
						delete(values, order[0])
						order = order[1:]
					}
					// Then every observable value and the distinct-key budget match.
					if lru.Len() != len(values) || lru.HistoryLen() != len(order) {
						t.Fatalf("seed=%d step=%d op=%d key=%q: values=%d/%d history=%d/%d",
							seed, step, operation, key, lru.Len(), len(values), lru.HistoryLen(), len(order))
					}
					for _, check := range keys {
						got, present := lru.Get(check)
						want, expected := values[check]
						if got != want || present != expected {
							t.Fatalf("seed=%d step=%d key=%q: got=(%d,%t) want=(%d,%t)",
								seed, step, check, got, present, want, expected)
						}
					}
					rangeCount := 0
					lru.Range(func(k string, v int) {
						rangeCount++
						if want, present := values[k]; !present || want != v {
							t.Fatalf("Range contains unexpected %q=%d", k, v)
						}
					})
					if rangeCount != len(values) {
						t.Fatalf("Range count=%d want=%d", rangeCount, len(values))
					}
				}
			}
		})
	}
}

func TestPR197R8RetirementPinEndsWhenBoundHolderIsReplaced(t *testing.T) {
	for _, checked := range []bool{false, true} {
		t.Run(fmt.Sprintf("checked_%t", checked), func(t *testing.T) {
			// Given an acquired identity retained in byChat after retirement.
			d := newDaemon(t)
			store := newMemStore()
			mgr := testManager(t, dial(t, d), store, 64)
			chat := testChat{id: "r8-replaced-holder", cwd: t.TempDir()}
			old, _, detach := acquire(t, mgr, chat, nil)
			detach()
			mgr.RetireIdentity(chat.id)
			old.invalidate("provider_disconnected", "review replacement")
			mustOK(t, store.SaveCursor(context.Background(), chat.id, Cursor{}))

			// When a validated acquire replaces that holder with a different durable.
			var replacement *Session
			var release func()
			var err error
			if checked {
				replacement, _, release, err = mgr.AcquireInitializedChecked(
					context.Background(), chat, nil, nil, func() error { return nil })
			} else {
				replacement, _, release, err = mgr.Acquire(context.Background(), chat, nil)
			}
			mustOK(t, err)
			defer release()
			if old.ID() == replacement.ID() {
				t.Fatal("fixture did not replace the durable")
			}
			mgr.mu.Lock()
			_, pinned := mgr.retirement.pinned[old.ID()]
			cached := mgr.overviewCache[old.ID()] != nil
			bound := false
			for _, holder := range mgr.byChat {
				bound = bound || holder.durableID == old.ID()
			}
			history := mgr.retirement.HistoryLen()
			mgr.mu.Unlock()

			// Then the old tombstone leaves pinning and becomes the newest history entry.
			if pinned || cached || bound || history != 1 {
				t.Fatalf("obsolete durable remains pinned: pinned=%t cached=%t bound=%t history=%d",
					pinned, cached, bound, history)
			}
		})
	}
}

func TestPR197R8RetirementPinsStayBoundedAcrossReplacementChurn(t *testing.T) {
	// Given one real acquired chat and no overview cache entries.
	d := newDaemon(t)
	store := newMemStore()
	mgr := testManager(t, dial(t, d), store, 64)
	chat := testChat{id: "r8-single-chat-churn", cwd: t.TempDir()}
	current, _, detach := acquire(t, mgr, chat, nil)
	detach()

	// When retirement followed by replacement repeats beyond the history capacity.
	for i := 0; i < maxIdentityTombstones+16; i++ {
		mgr.RetireIdentity(chat.id)
		current.invalidate("provider_disconnected", "review replacement")
		mustOK(t, store.SaveCursor(context.Background(), chat.id, Cursor{}))
		var err error
		current, _, detach, err = mgr.Acquire(context.Background(), chat, nil)
		mustOK(t, err)
		detach()
	}
	mgr.mu.Lock()
	pinned := len(mgr.retirement.pinned)
	history, total := mgr.retirement.HistoryLen(), mgr.retirement.Len()
	bound, cached := len(mgr.byChat), len(mgr.overviewCache)
	mgr.mu.Unlock()

	// Then only the live holder may be pinned; all older evidence uses the budget.
	if pinned > bound+cached || total > maxIdentityTombstones+bound+cached {
		t.Fatalf("unbounded retirement evidence: pinned=%d history=%d total=%d byChat=%d cache=%d",
			pinned, history, total, bound, cached)
	}
}
