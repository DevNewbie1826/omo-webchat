package session

import (
	"testing"
)

// A title-only change (identical task payload, renamed stored chat) must
// advance the live revision: the title is part of the revision projection.
func TestUnboundOverviewTitleChangeAdvancesFreshnessRevision(t *testing.T) {
	d := newDaemon(t)
	store := newResolvingCursorStore()
	store.setOwner("title-durable", "title-chat", "Original title")
	mgr := testManager(t, dial(t, d), store, 64)
	updates := make(chan Summary, 4)
	unsubscribe := mgr.SubscribeOverview(func(snapshot Summary) { updates <- snapshot })
	defer unsubscribe()

	payload := map[string]any{"tasks": []any{map[string]any{"task_id": "t-title", "status": "running"}}}
	emitUnboundActivity(d, "title-durable", activitySnapshotOrder[0], payload)
	first := awaitOverview(t, updates)
	if first.Title != "Original title" {
		t.Fatalf("initial cached row = %+v", first)
	}
	before := first.LiveValues().LastActivityMS
	if before == nil {
		t.Fatal("cached row carries no freshness revision")
	}

	// The repeated payload isolates the title: without it a data change would
	// advance the revision on its own and mask a missing title projection.
	store.setOwner("title-durable", "title-chat", "Renamed title")
	emitUnboundActivity(d, "title-durable", activitySnapshotOrder[0], payload)
	second := awaitOverview(t, updates)
	if second.Title != "Renamed title" {
		t.Fatalf("renamed cached row = %+v", second)
	}
	after := second.LiveValues().LastActivityMS
	if after == nil || *after <= *before {
		t.Fatalf("title-only change did not advance freshness revision: before=%v after=%v", *before, after)
	}
}

// ApplyChatTitle republishes a cached unbound row under the renamed title so
// a brand-new subscription's initial snapshot and REST agree, with the rename
// itself advancing the revision.
func TestApplyChatTitleRefreshesCachedUnboundRow(t *testing.T) {
	d := newDaemon(t)
	store := newResolvingCursorStore()
	store.setOwner("rename-durable", "rename-chat", "Original title")
	mgr := testManager(t, dial(t, d), store, 64)
	updates := make(chan Summary, 2)
	unsubscribe := mgr.SubscribeOverview(func(snapshot Summary) { updates <- snapshot })
	defer unsubscribe()
	emitUnboundActivity(d, "rename-durable", activitySnapshotOrder[0],
		map[string]any{"tasks": []any{map[string]any{"task_id": "t-rename", "status": "running"}}})
	first := awaitOverview(t, updates)
	if first.Title != "Original title" {
		t.Fatalf("initial cached row = %+v", first)
	}
	before := first.LiveValues().LastActivityMS
	if before == nil {
		t.Fatal("cached row carries no freshness revision")
	}

	store.setOwner("rename-durable", "rename-chat", "Renamed title")
	mgr.ApplyChatTitle("rename-chat", "Renamed title")

	renamed := awaitOverview(t, updates)
	if renamed.Title != "Renamed title" {
		t.Fatalf("rename was not republished: %+v", renamed)
	}
	revision := renamed.LiveValues().LastActivityMS
	if revision == nil || *revision <= *before {
		t.Fatalf("rename did not advance freshness revision: before=%v after=%v", *before, revision)
	}
	initial, stop := mgr.SubscribeActivity(true, nil, func(Summary, bool) {})
	stop()
	if len(initial) != 1 || initial[0].Title != "Renamed title" {
		t.Fatalf("new subscription initial rows = %+v", initial)
	}
	if live := mgr.LiveSummaries(); len(live) != 1 || live[0].Title != "Renamed title" {
		t.Fatalf("REST summaries after rename = %+v", live)
	}
}
