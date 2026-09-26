package session

import (
	"context"
	"fmt"
	"testing"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

func TestPR197R6FreshDeletionAfterBoundRetirements(t *testing.T) {
	// Given: retired identities remain in byChat, as supported by epoch recovery.
	d := newDaemon(t)
	mgr := testManager(t, dial(t, d), newMemStore(), 64)
	for i := 0; i < maxIdentityTombstones; i++ {
		chat := testChat{id: fmt.Sprintf("r6-retained-%03d", i), cwd: t.TempDir()}
		s, _, detach := acquire(t, mgr, chat, nil)
		detach()
		mgr.RetireIdentity(chat.id)
		mgr.mu.Lock()
		retained := mgr.byChat[chat.id] == s && mgr.durableRetiredLocked(s.ID())
		mgr.mu.Unlock()
		if !retained {
			t.Fatal("fixture did not retain a retired identity")
		}
	}

	// When: a never-published chat is freshly deleted, then sends late activity.
	const durable = "r6-fresh-after-bound"
	mgr.RetireIdentity("r6-fresh-chat", durable)
	mgr.mu.Lock()
	retired := mgr.durableRetiredLocked(durable)
	mgr.mu.Unlock()
	if !retired {
		t.Error("fresh deletion was evicted by its own insertion")
	}
	updates := make(chan Summary, 2)
	_, stop := mgr.SubscribeActivity(true, nil, func(s Summary, _ bool) { updates <- s })
	defer stop()
	emitUnboundActivity(d, durable, activitySnapshotOrder[0], map[string]any{"tasks": []any{}})
	emitUnboundActivity(d, "r6-retirement-barrier", activitySnapshotOrder[0], map[string]any{"tasks": []any{}})
	first := awaitOverview(t, updates)
	if first.ChatID != "r6-retirement-barrier" {
		if barrier := awaitOverview(t, updates); barrier.ChatID != "r6-retirement-barrier" {
			t.Fatalf("ingestion barrier missing: %+v", barrier)
		}
	}

	// Then: fresh retirement survives both publication and the REST projection.
	if first.ChatID != "r6-retirement-barrier" {
		t.Errorf("activity resurrected fresh deletion: %+v", first)
	}
	for _, row := range mgr.LiveSummaries() {
		if row.DurableSessionID == durable {
			t.Errorf("live summary resurrected fresh deletion: %+v", row)
		}
	}
}

func TestPR197R6RetirementHistoryEvictsLeastRecentlyUsedIdentity(t *testing.T) {
	// Given: 256 distinct non-resident retirement records.
	mgr := NewManager(Config{})
	t.Cleanup(func() { _ = mgr.CloseAll(context.Background()) })
	mgr.mu.Lock()
	for i := 0; i < maxIdentityTombstones; i++ {
		mgr.retireDurableLocked(fmt.Sprintf("r6-history-%03d", i), "deleted")
	}
	// When: refreshing the newest record does not add a distinct identity.
	mgr.retireDurableLocked("r6-history-255", "deleted")
	retained := mgr.durableRetiredLocked("r6-history-000")
	count := len(mgr.retiredDurable)
	mgr.mu.Unlock()

	// Then: the least-recently-used identity still fits in the 256-entry history.
	if !retained || count != maxIdentityTombstones {
		t.Errorf("refresh shrank non-resident history: oldest retained=%v count=%d", retained, count)
	}
	_, snapshot, _ := mgr.ingestEpochEvent(omorpc.EpochToken{}, &omorpc.Event{
		Type: "extension_event", SessionID: "r6-history-000",
		Raw: []byte(`{"name":"omo.task.updated","data":{"tasks":[]}}`),
	})
	if snapshot.ChatID != "" {
		t.Errorf("activity resurrected an identity inside the non-resident window: %+v", snapshot)
	}
}
