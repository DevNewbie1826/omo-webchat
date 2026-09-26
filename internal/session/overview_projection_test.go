package session

import (
	"context"
	"fmt"
	"testing"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

func TestPR197ProjectionReadsCurrentOwnerWithoutAnotherEvent(t *testing.T) {
	store := newResolvingCursorStore()
	mgr := NewManager(Config{Store: store})
	t.Cleanup(func() { _ = mgr.CloseAll(context.Background()) })
	event := &omorpc.Event{Type: "extension_event", SessionID: "durable",
		Raw: []byte(`{"name":"omo.task.updated","data":{"tasks":[]}}`)}
	updates := make(chan Summary, 1)
	_, stop := mgr.SubscribeActivity(false, []string{"durable"}, func(s Summary, _ bool) { updates <- s })
	defer stop()
	_, first, _ := mgr.ingestEpochEvent(omorpc.EpochToken{}, event)
	if first.ChatID != "durable" {
		t.Fatalf("initial unclaimed row = %+v", first)
	}
	if got := awaitOverview(t, updates); got.ChatID != "durable" {
		t.Fatalf("subscriber did not observe provisional identity: %+v", got)
	}

	// Read-time projection must not consume the remap owed to existing WS
	// subscribers. Neither a claim nor a rename requires another engine event.
	for _, name := range []string{"Claimed", "Renamed"} {
		store.setOwner("durable", "chat", name)
		initial, stop := mgr.SubscribeActivity(false, []string{"chat"}, func(Summary, bool) {})
		stop()
		for _, rows := range [][]Summary{initial, mgr.LiveSummaries()} {
			if len(rows) != 1 || rows[0].ChatID != "chat" || rows[0].Title != name || rows[0].DurableSessionID != "durable" {
				t.Fatalf("read did not project current ownership: %+v", rows)
			}
		}
	}
	mgr.ApplyChatTitle("chat", "Renamed")
	if got := awaitOverview(t, updates); got.ChatID != "chat" || got.ReplacesSessionID != "durable" || got.DurableSessionID != "durable" {
		t.Fatalf("read consumed the publication remap: %+v", got)
	}

	// Losing ownership suppresses the row immediately, not after a new event.
	store.deleteOwner("durable")
	initial, unsubscribe := mgr.SubscribeActivity(true, nil, func(Summary, bool) {})
	unsubscribe()
	if len(initial) != 0 || len(mgr.LiveSummaries()) != 0 {
		t.Fatalf("unowned former chat survived read: %+v", initial)
	}
}

func TestPR197ProjectionOwnerEvidenceSurvivesUnownedCacheChurn(t *testing.T) {
	store := newResolvingCursorStore()
	store.setOwner("owned", "chat", "Owned")
	mgr := NewManager(Config{Store: store})
	t.Cleanup(func() { _ = mgr.CloseAll(context.Background()) })
	ingest := func(durable string) Summary {
		_, snapshot, _ := mgr.ingestEpochEvent(omorpc.EpochToken{}, &omorpc.Event{
			Type: "extension_event", SessionID: durable,
			Raw: []byte(`{"name":"omo.task.updated","data":{"tasks":[]}}`),
		})
		return snapshot
	}
	ingest("owned")
	for i := 0; i <= maxOverviewCacheEntries; i++ {
		ingest(fmt.Sprintf("unowned-%d", i))
	}
	store.deleteOwner("owned")
	if got := ingest("owned"); got.ChatID != "" {
		t.Fatalf("eviction erased former ownership: %+v", got)
	}

	// Ownership evidence is independently bounded, not an unbounded alias map.
	for i := 0; i <= maxIdentityTombstones; i++ {
		durable, chat := fmt.Sprintf("owned-%d", i), fmt.Sprintf("chat-%d", i)
		store.setOwner(durable, chat, chat)
		ingest(durable)
	}
	mgr.mu.Lock()
	defer mgr.mu.Unlock()
	if len(mgr.overviewOwners) != maxIdentityTombstones || len(mgr.overviewOwnerFIFO) != maxIdentityTombstones {
		t.Fatalf("owner history exceeded its bound: %d records, %d FIFO", len(mgr.overviewOwners), len(mgr.overviewOwnerFIFO))
	}
	if len(mgr.overviewPreviousIDs) != maxOverviewPublications || len(mgr.overviewPreviousFIFO) != maxOverviewPublications {
		t.Fatalf("publication history exceeded its bound: %d records, %d FIFO", len(mgr.overviewPreviousIDs), len(mgr.overviewPreviousFIFO))
	}
}

func TestPR197ProjectionKeepsResidentOwnerAndEvictsOldestUnusedOwner(t *testing.T) {
	store := newResolvingCursorStore()
	mgr := NewManager(Config{Store: store})
	t.Cleanup(func() { _ = mgr.CloseAll(context.Background()) })
	mgr.overviewCache["hot"] = &overviewCacheEntry{}
	project := func(durable string) Summary {
		store.setOwner(durable, "chat-"+durable, durable)
		mgr.mu.Lock()
		defer mgr.mu.Unlock()
		return mgr.projectOverviewLocked(Summary{DurableSessionID: durable})
	}

	// Given: a resident owner and two older non-resident owners.
	project("hot")
	project("cold")
	project("recent")
	for i := 0; i < maxIdentityTombstones-3; i++ {
		project(fmt.Sprintf("filler-%d", i))
	}
	project("recent")

	// When: new ownership exceeds the bounded history.
	project("new")
	mgr.mu.Lock()
	_, hot := mgr.overviewOwners["hot"]
	_, cold := mgr.overviewOwners["cold"]
	_, recent := mgr.overviewOwners["recent"]
	count := len(mgr.overviewOwners)
	mgr.mu.Unlock()

	// Then: only the oldest unused owner was evicted; late activity stays suppressed.
	if !hot || cold || !recent || count != maxIdentityTombstones {
		t.Fatalf("owner eviction: hot=%v cold=%v recent=%v count=%d", hot, cold, recent, count)
	}
	store.deleteOwner("hot")
	mgr.mu.Lock()
	late := mgr.projectOverviewLocked(Summary{DurableSessionID: "hot"})
	mgr.mu.Unlock()
	if late.ChatID != "" {
		t.Fatalf("resident former owner reappeared: %+v", late)
	}
}

func TestPR197ProjectionKeepsResidentRemapInManagerAndSubscriber(t *testing.T) {
	store := newResolvingCursorStore()
	store.setOwner("hot", "first-chat", "First")
	mgr := NewManager(Config{Store: store})
	t.Cleanup(func() { _ = mgr.CloseAll(context.Background()) })
	mgr.overviewCache["hot"] = &overviewCacheEntry{}
	sub := &overviewSubscriber{allLive: true, queue: make(chan overviewUpdate, maxOverviewPublications+3), stop: make(chan struct{})}
	mgr.overviewSubscribers[1] = sub
	publish := func(durable string) Summary {
		snapshot := Summary{ChatID: durable, DurableSessionID: durable}
		mgr.mu.Lock()
		subscribers := mgr.updateOverviewLocked(&snapshot)
		deliverOverview(subscribers, snapshot)
		mgr.mu.Unlock()
		return snapshot
	}

	// Given: the resident remap source is old while another source is refreshed.
	publish("hot")
	publish("cold")
	publish("recent")
	for i := 0; i < maxOverviewPublications-3; i++ {
		publish(fmt.Sprintf("filler-%d", i))
	}
	publish("recent")

	// When: history exceeds its bound and the hot durable changes owner.
	publish("new")
	store.setOwner("hot", "second-chat", "Second")
	remap := publish("hot")
	var subscriberRemap Summary
	for len(sub.queue) > 0 {
		subscriberRemap = (<-sub.queue).summary
	}

	// Then: both histories evict the oldest unused record, not the resident source.
	if remap.ReplacesSessionID != "first-chat" || subscriberRemap.ReplacesSessionID != "first-chat" {
		t.Fatalf("resident remap lost: manager=%+v subscriber=%+v", remap, subscriberRemap)
	}
	for name, history := range map[string]overviewPublications{
		"subscriber": sub.published,
		"manager":    {ids: mgr.overviewPreviousIDs, fifo: mgr.overviewPreviousFIFO},
	} {
		if len(history.ids) != maxOverviewPublications || len(history.fifo) != maxOverviewPublications ||
			history.ids["cold"] != "" || history.ids["recent"] != "recent" || history.ids["hot"] != "second-chat" {
			t.Errorf("%s history did not retain live/recent identities within bound: %+v", name, history)
		}
	}
}

func TestPR197ProjectionRemapsEvictedProvisionalRow(t *testing.T) {
	store := newResolvingCursorStore()
	mgr := NewManager(Config{Store: store})
	t.Cleanup(func() { _ = mgr.CloseAll(context.Background()) })
	ingest := func(durable string) Summary {
		_, snapshot, _ := mgr.ingestEpochEvent(omorpc.EpochToken{}, &omorpc.Event{
			Type: "extension_event", SessionID: durable,
			Raw: []byte(`{"name":"omo.task.updated","data":{"tasks":[]}}`),
		})
		return snapshot
	}
	if got := ingest("provisional"); got.ChatID != "provisional" {
		t.Fatalf("initial row = %+v", got)
	}
	for i := 0; i < maxOverviewCacheEntries; i++ {
		ingest(fmt.Sprintf("filler-%d", i))
	}

	store.setOwner("provisional", "chat", "Claimed")
	if got := ingest("provisional"); got.ChatID != "chat" || got.DurableSessionID != "provisional" || got.ReplacesSessionID != "provisional" {
		t.Fatalf("eviction erased the published remap source: %+v", got)
	}
}

func TestPR197ProjectionRemapsSubscriberInitialIdentity(t *testing.T) {
	store := newResolvingCursorStore()
	mgr := NewManager(Config{Store: store})
	t.Cleanup(func() { _ = mgr.CloseAll(context.Background()) })
	event := &omorpc.Event{Type: "extension_event", SessionID: "durable",
		Raw: []byte(`{"name":"omo.task.updated","data":{"tasks":[]}}`)}
	mgr.ingestEpochEvent(omorpc.EpochToken{}, event)
	store.setOwner("durable", "first-chat", "First")
	updates := make(chan Summary, 1)
	initial, stop := mgr.SubscribeActivity(false, []string{"first-chat"}, func(s Summary, _ bool) { updates <- s })
	defer stop()
	if len(initial) != 1 || initial[0].ChatID != "first-chat" {
		t.Fatalf("initial projection = %+v", initial)
	}

	store.setOwner("durable", "second-chat", "Second")
	mgr.ingestEpochEvent(omorpc.EpochToken{}, event)
	if got := awaitOverview(t, updates); got.ChatID != "second-chat" || got.ReplacesSessionID != "first-chat" || got.DurableSessionID != "durable" {
		t.Fatalf("subscriber did not replace its initial identity: %+v", got)
	}
}

func TestPR197ProjectionRetainsReassignedDurableWhenFormerOwnerDeleted(t *testing.T) {
	store := newResolvingCursorStore()
	store.setOwner("durable", "former-chat", "Former")
	mgr := NewManager(Config{Store: store})
	t.Cleanup(func() { _ = mgr.CloseAll(context.Background()) })
	mgr.ingestEpochEvent(omorpc.EpochToken{}, &omorpc.Event{
		Type: "extension_event", SessionID: "durable",
		Raw: []byte(`{"name":"omo.task.updated","data":{"tasks":[]}}`),
	})
	store.setOwner("durable", "current-chat", "Current")

	err := mgr.DeleteChatIdentity("former-chat", "", func() error {
		if rows := mgr.LiveSummaries(); len(rows) != 1 || rows[0].ChatID != "current-chat" {
			t.Errorf("former owner's deletion fenced the current owner: %+v", rows)
		}
		return nil
	})
	mustOK(t, err)
	initial, stop := mgr.SubscribeActivity(true, nil, func(Summary, bool) {})
	stop()
	for _, rows := range [][]Summary{mgr.LiveSummaries(), initial} {
		if len(rows) != 1 || rows[0].ChatID != "current-chat" || rows[0].TaskDigest == nil {
			t.Fatalf("former owner's retirement erased current activity: %+v", rows)
		}
	}
}

func TestPR197ProjectionDeletingDuplicateCursorKeepsBoundOwner(t *testing.T) {
	d := newDaemon(t)
	store := newResolvingCursorStore()
	mgr := testManager(t, dial(t, d), store, 64)
	sess, _, detach := acquire(t, mgr, testChat{id: "owner", cwd: t.TempDir()}, nil)
	defer detach()
	store.setOwner(sess.ID(), "owner", "Owner")
	updates := make(chan Summary, 1)
	stop := mgr.SubscribeOverview(func(s Summary) { updates <- s })
	defer stop()
	emitUnboundActivity(d, sess.ID(), activitySnapshotOrder[0], map[string]any{
		"tasks": []any{map[string]any{"task_id": "kept", "status": "running"}},
	})
	if got := awaitOverview(t, updates); got.ChatID != "owner" || got.TaskDigest == nil {
		t.Fatalf("bound activity = %+v", got)
	}

	mustOK(t, mgr.DeleteChatIdentity("duplicate", sess.ID(), func() error { return nil }))
	initial, unsubscribe := mgr.SubscribeActivity(true, nil, func(Summary, bool) {})
	unsubscribe()
	for _, rows := range [][]Summary{initial, mgr.LiveSummaries()} {
		if len(rows) != 1 || rows[0].ChatID != "owner" || rows[0].TaskDigest == nil || rows[0].TaskDigest.Tasks[0].TaskID != "kept" {
			t.Fatalf("duplicate cursor deletion erased bound owner: %+v", rows)
		}
	}
	mgr.mu.Lock()
	defer mgr.mu.Unlock()
	if mgr.byRoute[sess.routingID] != sess || mgr.durableToChat[sess.ID()] != "owner" {
		t.Fatal("duplicate cursor deletion removed the bound route")
	}
}
