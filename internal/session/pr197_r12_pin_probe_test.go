package session

import (
	"context"
	"fmt"
	"testing"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

func checkPR197R12LRU[V any](t *testing.T, label string, history *residencyLRU[V], resident map[string]bool) {
	t.Helper()
	nonresident := 0
	history.Range(func(key string, _ V) {
		if !resident[key] {
			nonresident++
		}
	})
	stalePins := 0
	for key := range history.pinned {
		if !resident[key] {
			stalePins++
		}
	}
	t.Logf("EVIDENCE %s values=%d pins=%d history=%d actual_nonresident=%d stale_pins=%d",
		label, history.Len(), len(history.pinned), history.HistoryLen(), nonresident, stalePins)
	if history.HistoryLen() > history.capacity || len(history.index) != history.HistoryLen() ||
		nonresident > history.capacity || stalePins != 0 {
		t.Errorf("%s violates the distinct non-resident bound or retains obsolete pins", label)
	}
}

func checkPR197R12ManagerEvidence(t *testing.T, mgr *Manager) {
	t.Helper()
	mgr.mu.Lock()
	defer mgr.mu.Unlock()
	durables, retiredResidents, rows := map[string]bool{}, map[string]bool{}, map[string]bool{}
	for id := range mgr.overviewCache {
		durables[id], retiredResidents[id] = true, true
	}
	for _, s := range mgr.byChat {
		retiredResidents[s.durableID] = true
		if mgr.overviewDurableLiveLocked(s.durableID) {
			durables[s.durableID] = true
		}
	}
	mgr.overviewExposed.Range(func(chat string, _ overviewExposure) {
		rows[chat] = mgr.overviewRowLiveLocked(chat)
	})
	t.Logf("RESIDENCY cached=%d bound=%d current_rows=%d deletion_fences=%d",
		len(mgr.overviewCache), len(mgr.byChat), len(mgr.overviewCurrent), len(mgr.deletingDurable))
	if len(mgr.overviewCache) > maxOverviewCacheEntries ||
		len(mgr.overviewCurrent) > len(mgr.overviewCache)+len(mgr.byChat) ||
		len(mgr.deletingDurable) != 0 {
		t.Error("cache, current rows, or completed deletion fences exceed residency")
	}
	checkPR197R12LRU(t, "retirement", &mgr.retirement, retiredResidents)
	checkPR197R12LRU(t, "owners", &mgr.overviewOwners, durables)
	checkPR197R12LRU(t, "exposed", &mgr.overviewExposed, rows)
	checkPublications := func(label string, p *overviewPublications) {
		checkPR197R12LRU(t, label, &p.ids, durables)
		t.Logf("REVERSE %s rows=%d forward=%d", label, len(p.rows), p.ids.Len())
		if len(p.rows) > p.ids.Len() {
			t.Errorf("%s reverse rows exceed the forward bound", label)
		}
	}
	checkPublications("manager_publications", &mgr.overviewPrevious)
	for id, sub := range mgr.overviewSubscribers {
		sub.mu.Lock()
		checkPublications(fmt.Sprintf("subscriber_%d", id), &sub.published)
		sub.mu.Unlock()
	}
}

func TestPR197R12SilentOwnershipHandoffReleasesExposedPins(t *testing.T) {
	for _, exposeReplacement := range []bool{false, true} {
		t.Run(fmt.Sprintf("expose_replacement_%t", exposeReplacement), func(t *testing.T) {
			// Given real ingestion, bounded subscribers, and independent current owners.
			store := newResolvingCursorStore()
			mgr := NewManager(Config{Store: store})
			t.Cleanup(func() { mustOK(t, mgr.CloseAll(context.Background())) })
			_, stopAll := mgr.SubscribeActivity(true, nil, func(Summary, bool) {})
			defer stopAll()
			_, stopFiltered := mgr.SubscribeActivity(false, []string{"never-matches"}, func(Summary, bool) {})
			defer stopFiltered()
			ingest := func(id string) {
				mgr.ingestEpochEvent(omorpc.EpochToken{}, &omorpc.Event{
					Type: "extension_event", SessionID: id,
					Raw: []byte(`{"name":"omo.task.updated","data":{"tasks":[]}}`),
				})
			}
			const pairs = maxOverviewCacheEntries / 2
			for batch := 0; batch < 4; batch++ {
				for i := 0; i < pairs; i++ {
					x, y := fmt.Sprintf("x-%d-%d", batch, i), fmt.Sprintf("y-%d-%d", batch, i)
					store.setOwner(x, "a-"+x, "First")
					store.setOwner(y, "b-"+y, "Second")
					ingest(x)
					ingest(y)
				}
				// When A's cursor moves from X to already resident Y without a
				// publication of A:Y, X's eviction keeps A pinned on account of Y.
				for i := 0; i < pairs; i++ {
					x, y := fmt.Sprintf("x-%d-%d", batch, i), fmt.Sprintf("y-%d-%d", batch, i)
					store.deleteOwner(x)
					store.setOwner(y, "a-"+x, "First")
					if exposeReplacement {
						ingest(y)
					}
				}
				// In the failing arm, each X then Y leaves through the actual LRU.
				for i := 0; i < maxOverviewCacheEntries; i++ {
					ingest(fmt.Sprintf("filler-%d-%d", batch, i))
				}
				t.Logf("BATCH %d expose_replacement=%t", batch, exposeReplacement)
				checkPR197R12ManagerEvidence(t, mgr)
			}
			// Then even complete epoch teardown must release every resident pin.
			mgr.detachEpoch(omorpc.EpochToken{})
			checkPR197R12ManagerEvidence(t, mgr)
		})
	}
}

func TestPR197R12DeletionChurnBoundsEveryEvidenceStore(t *testing.T) {
	// Given both all-live and unmatched explicit subscriptions.
	store := newResolvingCursorStore()
	mgr := NewManager(Config{Store: store})
	t.Cleanup(func() { mustOK(t, mgr.CloseAll(context.Background())) })
	_, stopAll := mgr.SubscribeActivity(true, nil, func(Summary, bool) {})
	defer stopAll()
	_, stopFiltered := mgr.SubscribeActivity(false, []string{"never-matches"}, func(Summary, bool) {})
	defer stopFiltered()
	ingest := func(id string) Summary {
		_, snapshot, _ := mgr.ingestEpochEvent(omorpc.EpochToken{}, &omorpc.Event{
			Type: "extension_event", SessionID: id,
			Raw: []byte(`{"name":"omo.task.updated","data":{"tasks":[]}}`),
		})
		return snapshot
	}
	// When owned publications, metadata deletion, and late residency repeat.
	for i := 0; i < 4*maxIdentityTombstones+7; i++ {
		id, chat := fmt.Sprintf("deleted-%d", i), fmt.Sprintf("chat-%d", i)
		store.setOwner(id, chat, "Before deletion")
		ingest(id)
		mustOK(t, mgr.DeleteChatIdentity(chat, id, func() error {
			store.deleteOwner(id)
			return nil
		}))
		if row := ingest(id); row.ChatID != "" {
			t.Fatalf("deleted row resurrected: %+v", row)
		}
	}
	// Then all forward, reverse, reserved-pin, and fence stores are bounded.
	checkPR197R12ManagerEvidence(t, mgr)
	mgr.detachEpoch(omorpc.EpochToken{})
	checkPR197R12ManagerEvidence(t, mgr)
}

func TestPR197R12BoundRenameAdvancesInheritedRevision(t *testing.T) {
	// Given an exposed row revision ahead of a replacement session's clock.
	// A fixed valid receipt tests the ordering contract without timing luck.
	d := newDaemon(t)
	store := newResolvingCursorStore()
	mgr := testManager(t, dial(t, d), store, 64)
	chat := testChat{id: "inherited-revision-chat", cwd: t.TempDir()}
	store.setOwner("previous-durable", chat.id, "Before acquire")
	mgr.mu.Lock()
	mgr.overviewCache["previous-durable"] = &overviewCacheEntry{
		task: &TaskDigest{ReceivedAt: "2100-01-01T00:00:00Z"},
	}
	mgr.mu.Unlock()
	oldRows := mgr.LiveSummaries()
	if len(oldRows) != 1 || oldRows[0].LiveValues().LastActivityMS == nil {
		t.Fatalf("fixture lacks the previously exposed row: %+v", oldRows)
	}
	oldRevision := *oldRows[0].LiveValues().LastActivityMS
	store.deleteOwner("previous-durable")
	s, _, detach := acquire(t, mgr, chat, nil)
	defer detach()
	before := mgr.LiveSummaries()
	if len(before) != 1 || before[0].DurableSessionID != s.ID() ||
		before[0].LiveValues().LastActivityMS == nil {
		t.Fatalf("fixture lacks the replacement row: %+v", before)
	}
	beforeRevision := *before[0].LiveValues().LastActivityMS
	if beforeRevision <= oldRevision {
		t.Fatal("replacement did not inherit and advance the old revision")
	}
	updates := make(chan Summary, 4)
	_, stop := mgr.SubscribeActivity(false, []string{chat.id}, func(s Summary, _ bool) { updates <- s })
	defer stop()

	// When the real bound-session rename path publishes a changed title.
	mustOK(t, s.SetSessionName(context.Background(), "After rename"))
	renamed := awaitOverview(t, updates)
	after := mgr.LiveSummaries()
	if len(after) != 1 {
		t.Fatalf("rename changed row cardinality: %+v", after)
	}

	// Then both the WS publication and REST projection must advance the row.
	for _, row := range []Summary{renamed, after[0]} {
		revision := row.LiveValues().LastActivityMS
		if revision == nil {
			t.Fatal("rename omitted its revision")
		}
		t.Logf("BOUND_RENAME before=%d after=%d title=%q", beforeRevision, *revision, row.Title)
		if row.Title != "After rename" || *revision <= beforeRevision {
			t.Errorf("bound rename did not advance inherited freshness: before=%d after=%d title=%q",
				beforeRevision, *revision, row.Title)
		}
	}
}
