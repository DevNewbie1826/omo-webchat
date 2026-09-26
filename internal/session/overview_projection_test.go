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
	if mgr.overviewOwners.HistoryLen() > maxIdentityTombstones {
		t.Fatalf("owner history exceeded its bound: %d entries", mgr.overviewOwners.HistoryLen())
	}
	if mgr.overviewPrevious.ids.HistoryLen() > maxOverviewPublications {
		t.Fatalf("publication history exceeded its bound: %d entries", mgr.overviewPrevious.ids.HistoryLen())
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
	for i := 0; i < maxIdentityTombstones-2; i++ {
		project(fmt.Sprintf("filler-%d", i))
	}
	project("recent")

	// When: new ownership exceeds the bounded history.
	project("new")
	mgr.mu.Lock()
	_, hot := mgr.overviewOwners.Get("hot")
	_, cold := mgr.overviewOwners.Get("cold")
	_, recent := mgr.overviewOwners.Get("recent")
	count := mgr.overviewOwners.Len()
	mgr.mu.Unlock()

	// Then: only the oldest unused owner was evicted; late activity stays suppressed.
	if !hot || cold || !recent || count != maxIdentityTombstones+1 {
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
	for i := 0; i < maxOverviewPublications-2; i++ {
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
		"manager":    mgr.overviewPrevious,
	} {
		_, cold := history.ids.Get("cold")
		recent, hasRecent := history.ids.Get("recent")
		hot, hasHot := history.ids.Get("hot")
		if history.ids.HistoryLen() != maxOverviewPublications || cold || !hasRecent || recent != "recent" || !hasHot || hot != "second-chat" {
			t.Errorf("%s history did not retain live/recent identities: count=%d cold=%t recent=%q hot=%q", name, history.ids.HistoryLen(), cold, recent, hot)
		}
		if len(history.rows) > history.ids.Len() {
			t.Errorf("%s reverse row history exceeded durable history: rows=%d durables=%d", name, len(history.rows), history.ids.Len())
		}
	}
}

func TestPR197ProjectionRemapsOnlyWhenPreviousRowStillBelongsToDurable(t *testing.T) {
	for _, name := range []string{"manager", "subscriber"} {
		t.Run(name, func(t *testing.T) {
			var history overviewPublications
			history.project(Summary{ChatID: "chat-a", DurableSessionID: "durable-x"})
			history.project(Summary{ChatID: "chat-a", DurableSessionID: "durable-y"})

			// X's historical row belongs to Y now, so transferring X cannot remove A.
			transferred := history.project(Summary{ChatID: "chat-b", DurableSessionID: "durable-x"})
			if transferred.ReplacesSessionID != "" {
				t.Fatalf("transfer removed another durable's row: %+v", transferred)
			}
			// A row that still belongs to its durable remains a valid remap source.
			moved := history.project(Summary{ChatID: "chat-c", DurableSessionID: "durable-y"})
			if moved.ReplacesSessionID != "chat-a" {
				t.Fatalf("lost remap for durable-y: %+v", moved)
			}
		})
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

func TestPR197ExposedRowRevisionAdvancesAcrossRESTAndDurablePublications(t *testing.T) {
	store := newResolvingCursorStore()
	store.setOwner("x", "chat", "Stable")
	mgr := NewManager(Config{Store: store})
	t.Cleanup(func() { _ = mgr.CloseAll(context.Background()) })
	publish := func(durable string) Summary {
		_, snapshot, _ := mgr.ingestEpochEvent(omorpc.EpochToken{}, &omorpc.Event{
			Type: "extension_event", SessionID: durable,
			Raw: []byte(`{"name":"omo.task.updated","data":{"tasks":[]}}`),
		})
		return snapshot
	}
	read := func(durable string) Summary {
		t.Helper()
		rows := mgr.LiveSummaries()
		if len(rows) != 1 || rows[0].ChatID != "chat" || rows[0].DurableSessionID != durable {
			t.Fatalf("REST row for %s = %+v", durable, rows)
		}
		return rows[0]
	}
	revision := func(snapshot Summary) int64 {
		t.Helper()
		value := snapshot.LiveValues().LastActivityMS
		if snapshot.ChatID != "chat" || value == nil {
			t.Fatalf("missing chat revision: %+v", snapshot)
		}
		return *value
	}

	// Given publications on X and Y under the same chat identity.
	first := revision(publish("x"))
	store.deleteOwner("x")
	store.setOwner("y", "chat", "Stable")
	last := revision(publish("y"))
	if last <= first {
		t.Fatalf("Y publication did not advance X: X=%d Y=%d", first, last)
	}

	// When a cursor-only return to X is exposed through REST.
	store.deleteOwner("y")
	store.setOwner("x", "chat", "Stable")
	exposed := revision(read("x"))
	if exposed <= last {
		t.Fatalf("REST X did not advance Y: Y=%d X=%d", last, exposed)
	}

	// Then an unchanged Y publication, another REST transition, and a
	// repeated read all preserve the latest exposed row revision.
	store.deleteOwner("x")
	store.setOwner("y", "chat", "Stable")
	returned := revision(publish("y"))
	if returned <= exposed {
		t.Fatalf("Y publication regressed REST X: X=%d Y=%d", exposed, returned)
	}
	store.deleteOwner("y")
	store.setOwner("x", "chat", "Stable")
	again := revision(read("x"))
	if again <= returned {
		t.Fatalf("REST X regressed Y publication: Y=%d X=%d", returned, again)
	}
	if repeated := revision(read("x")); repeated != again {
		t.Fatalf("unchanged REST row advanced: before=%d after=%d", again, repeated)
	}
}

func TestPR197ExposedRowRevisionKeepsResidentsWithinBound(t *testing.T) {
	store := newResolvingCursorStore()
	store.setOwner("resident", "resident-chat", "Resident")
	mgr := NewManager(Config{Store: store})
	t.Cleanup(func() { _ = mgr.CloseAll(context.Background()) })
	mgr.overviewCache["resident"] = &overviewCacheEntry{
		task: &TaskDigest{ReceivedAt: "2026-09-26T00:00:00Z"},
	}
	mgr.mu.Lock()
	resident := mgr.projectOverviewLocked(Summary{DurableSessionID: "resident"})
	mgr.mu.Unlock()
	if resident.LiveValues().LastActivityMS == nil {
		t.Fatal("resident row has no revision")
	}
	project := func(i int) {
		durable := fmt.Sprintf("unused-%d", i)
		store.setOwner(durable, "chat-"+durable, "Unused")
		revision := int64(i + 1)
		mgr.mu.Lock()
		mgr.projectOverviewLocked(Summary{
			DurableSessionID: durable,
			live:             &LiveValues{LastActivityMS: &revision},
		})
		mgr.mu.Unlock()
	}

	// Given a resident revision and more distinct unused rows than the bound.
	for i := 0; i <= maxIdentityTombstones; i++ {
		project(i)
	}
	mgr.mu.Lock()
	_, retained := mgr.overviewExposed.Get("resident-chat")
	history := mgr.overviewExposed.HistoryLen()
	mgr.mu.Unlock()
	if !retained || history > maxIdentityTombstones {
		t.Fatalf("resident exposure lost or history unbounded: resident=%t history=%d", retained, history)
	}

	// When the source leaves residency, later rows can evict its evidence.
	mgr.mu.Lock()
	delete(mgr.overviewCache, "resident")
	mgr.syncOverviewEvidenceLocked("resident")
	mgr.mu.Unlock()
	for i := maxIdentityTombstones + 1; i <= 2*maxIdentityTombstones+1; i++ {
		project(i)
	}
	mgr.mu.Lock()
	_, retained = mgr.overviewExposed.Get("resident-chat")
	history = mgr.overviewExposed.HistoryLen()
	mgr.mu.Unlock()
	if retained || history > maxIdentityTombstones {
		t.Fatalf("non-resident exposure was not evicted: resident=%t history=%d", retained, history)
	}
}

func TestPR197ExposedRowPinFollowsAnotherResidentOwnerAndKeepsRevision(t *testing.T) {
	store := newResolvingCursorStore()
	store.setOwner("moving", "first", "First")
	store.setOwner("other", "third", "Third")
	mgr := NewManager(Config{Store: store})
	t.Cleanup(func() { _ = mgr.CloseAll(context.Background()) })
	for _, durable := range []string{"moving", "other"} {
		mgr.overviewCache[durable] = &overviewCacheEntry{
			task: &TaskDigest{ReceivedAt: "2026-09-26T00:00:00Z"},
		}
	}
	project := func(durable string) int64 {
		t.Helper()
		mgr.mu.Lock()
		defer mgr.mu.Unlock()
		row := mgr.projectOverviewLocked(Summary{DurableSessionID: durable})
		if revision := row.LiveValues().LastActivityMS; revision != nil {
			return *revision
		}
		t.Fatalf("missing revision for %s: %+v", durable, row)
		return 0
	}

	// Given: first exposed a resident row and now owns another resident durable.
	initial := project("moving")
	store.setOwner("other", "first", "First")
	store.setOwner("moving", "second", "Second")
	project("moving")
	mgr.mu.Lock()
	_, pinnedElsewhere := mgr.overviewExposed.pinned["first"]
	mgr.mu.Unlock()
	if !pinnedElsewhere {
		t.Fatal("former owner lost its pin while owning another resident durable")
	}

	// When first exposes the other durable, then relinquishes that row too.
	otherRevision := project("other")
	if otherRevision <= initial {
		t.Fatalf("new durable regressed the first row: initial=%d other=%d", initial, otherRevision)
	}
	store.setOwner("other", "third", "Third")
	project("other")
	mgr.mu.Lock()
	retained, present := mgr.overviewExposed.Get("first")
	_, stillPinned := mgr.overviewExposed.pinned["first"]
	mgr.mu.Unlock()
	if !present || stillPinned || retained.revision != otherRevision {
		t.Fatalf("former owner lost its retained high-watermark: present=%t pinned=%t retained=%+v want=%d",
			present, stillPinned, retained, otherRevision)
	}

	// Then a later return to the moving durable advances that retained revision.
	store.setOwner("moving", "first", "First")
	if returned := project("moving"); returned <= otherRevision {
		t.Fatalf("returning owner regressed revision: retained=%d returned=%d", otherRevision, returned)
	}
}
