package session

import (
	"context"
	"fmt"
	"testing"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

func TestPR197RetirementMovesBetweenCacheAndHistory(t *testing.T) {
	// Given: a deleted durable with non-resident retirement evidence.
	mgr := NewManager(Config{})
	t.Cleanup(func() { _ = mgr.CloseAll(context.Background()) })
	mgr.mu.Lock()
	mgr.retireDurableLocked("deleted", "chat")
	mgr.mu.Unlock()
	ingest := func(id string) Summary {
		_, snapshot, _ := mgr.ingestEpochEvent(omorpc.EpochToken{}, &omorpc.Event{
			Type: "extension_event", SessionID: id,
			Raw: []byte(`{"name":"omo.task.updated","data":{"tasks":[]}}`),
		})
		return snapshot
	}

	// When: late activity makes the deleted durable resident.
	if got := ingest("deleted"); got.ChatID != "" {
		t.Fatalf("retired durable appeared on residency: %+v", got)
	}
	mgr.mu.Lock()
	resident := mgr.overviewCache["deleted"] != nil && mgr.overviewCache["deleted"].retired
	_, historical := mgr.retiredDurable["deleted"]
	historyCount := mgr.retirement.HistoryLen()
	mgr.mu.Unlock()
	if !resident || !historical || historyCount != 0 {
		t.Fatalf("retirement did not move into cache: resident=%t history=%t count=%d", resident, historical, historyCount)
	}

	// When: LRU eviction removes its cache entry.
	for i := 0; i < maxOverviewCacheEntries; i++ {
		ingest(fmt.Sprintf("other-%03d", i))
	}
	mgr.mu.Lock()
	_, cached := mgr.overviewCache["deleted"]
	_, historical = mgr.retiredDurable["deleted"]
	historyCount = mgr.retirement.HistoryLen()
	mgr.mu.Unlock()
	if cached || !historical || historyCount != 1 {
		t.Fatalf("retirement did not move back to history: cached=%t history=%t count=%d", cached, historical, historyCount)
	}
	if got := ingest("deleted"); got.ChatID != "" {
		t.Fatalf("evicted retirement failed on return: %+v", got)
	}
}

func TestPR197FreshDeletionNeverEvictsItselfAtResidentCapacity(t *testing.T) {
	// Given: every cache slot belongs to a retired durable.
	mgr := NewManager(Config{})
	t.Cleanup(func() { _ = mgr.CloseAll(context.Background()) })
	ingest := func(id string) Summary {
		_, snapshot, _ := mgr.ingestEpochEvent(omorpc.EpochToken{}, &omorpc.Event{
			Type: "extension_event", SessionID: id,
			Raw: []byte(`{"name":"omo.task.updated","data":{"tasks":[]}}`),
		})
		return snapshot
	}
	for i := 0; i < maxOverviewCacheEntries; i++ {
		id := fmt.Sprintf("resident-%03d", i)
		mgr.mu.Lock()
		mgr.retireDurableLocked(id, "chat-"+id)
		mgr.mu.Unlock()
		ingest(id)
	}

	// When: a never-published chat is deleted at full resident capacity.
	mgr.mu.Lock()
	mgr.retireDurableLocked("fresh", "fresh-chat")
	_, historical := mgr.retiredDurable["fresh"]
	historyCount := mgr.retirement.HistoryLen()
	mgr.mu.Unlock()
	if !historical || historyCount != 1 {
		t.Fatalf("fresh insertion evicted itself: history=%t count=%d", historical, historyCount)
	}

	// Then: its first late event remains suppressed after cache eviction.
	if got := ingest("fresh"); got.ChatID != "" {
		t.Fatalf("fresh deleted durable reappeared: %+v", got)
	}
	mgr.mu.Lock()
	fresh := mgr.overviewCache["fresh"] != nil && mgr.overviewCache["fresh"].retired
	_, evicted := mgr.retiredDurable["resident-000"]
	historyCount = mgr.retirement.HistoryLen()
	mgr.mu.Unlock()
	if !fresh || !evicted || historyCount != 1 {
		t.Fatalf("cache eviction lost evidence: fresh=%t evicted=%t count=%d", fresh, evicted, historyCount)
	}
}
