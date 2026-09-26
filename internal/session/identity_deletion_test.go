package session

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

func TestPR197DeletionFencesActivityAfterMetadataRemoval(t *testing.T) {
	for _, evicted := range []bool{false, true} {
		name := "cached"
		if evicted {
			name = "evicted"
		}
		t.Run(name, func(t *testing.T) {
			store := newResolvingCursorStore()
			store.setOwner("deleted-durable", "deleted-chat", "Deleted")
			mgr := NewManager(Config{Store: store})
			t.Cleanup(func() { _ = mgr.CloseAll(context.Background()) })
			ingest := func(id string) Summary {
				_, snapshot, _ := mgr.ingestEpochEvent(omorpc.EpochToken{}, &omorpc.Event{
					Type: "extension_event", SessionID: id,
					Raw: []byte(`{"name":"omo.task.updated","data":{"tasks":[]}}`),
				})
				return snapshot
			}
			ingest("deleted-durable")
			if evicted {
				for i := 0; i < maxOverviewCacheEntries; i++ {
					ingest(fmt.Sprintf("other-%d", i))
				}
			}
			removed := make(chan struct{})
			release := make(chan struct{})
			done := make(chan error, 1)
			go func() {
				done <- mgr.DeleteChatIdentity("deleted-chat", "deleted-durable", func() error {
					store.deleteOwner("deleted-durable")
					close(removed)
					<-release
					return nil
				})
			}()
			select {
			case <-removed:
			case <-time.After(testTimeout):
				close(release)
				t.Fatal("metadata removal did not reach gate")
			}
			during := ingest("deleted-durable")
			close(release)
			select {
			case err := <-done:
				mustOK(t, err)
			case <-time.After(testTimeout):
				t.Fatal("deletion did not finish")
			}
			if during.ChatID != "" {
				t.Errorf("activity published between metadata removal and retirement: %+v", during)
			}
			if after := ingest("deleted-durable"); after.ChatID != "" {
				t.Errorf("deleted durable resurrected after retirement: %+v", after)
			}
			initial, stop := mgr.SubscribeActivity(true, nil, func(Summary, bool) {})
			stop()
			for _, rows := range [][]Summary{initial, mgr.LiveSummaries()} {
				for _, row := range rows {
					if row.ChatID == "deleted-chat" || row.DurableSessionID == "deleted-durable" {
						t.Fatalf("deleted identity survived: %+v", row)
					}
				}
			}
		})
	}
}

func TestPR197FailedDeletionDoesNotRetireIdentity(t *testing.T) {
	store := newResolvingCursorStore()
	store.setOwner("durable", "chat", "Kept")
	mgr := NewManager(Config{Store: store})
	t.Cleanup(func() { _ = mgr.CloseAll(context.Background()) })
	failed := errors.New("metadata persistence failed")
	if err := mgr.DeleteChatIdentity("chat", "durable", func() error { return failed }); !errors.Is(err, failed) {
		t.Fatalf("deletion error = %v", err)
	}
	_, snapshot, _ := mgr.ingestEpochEvent(omorpc.EpochToken{}, &omorpc.Event{
		Type: "extension_event", SessionID: "durable",
		Raw: []byte(`{"name":"omo.task.updated","data":{"tasks":[]}}`),
	})
	if snapshot.ChatID != "chat" || snapshot.Title != "Kept" {
		t.Fatalf("failed deletion retired stored identity: %+v", snapshot)
	}
}

func TestPR197ResidentRetirementSurvivesHistoryEviction(t *testing.T) {
	mgr := NewManager(Config{})
	t.Cleanup(func() { _ = mgr.CloseAll(context.Background()) })
	ingest := func(id string) Summary {
		_, snapshot, _ := mgr.ingestEpochEvent(omorpc.EpochToken{}, &omorpc.Event{
			Type: "extension_event", SessionID: id,
			Raw: []byte(`{"name":"omo.task.updated","data":{"tasks":[]}}`),
		})
		return snapshot
	}

	// Given: a deleted durable first receives activity after retirement.
	mgr.mu.Lock()
	mgr.retireDurableLocked("deleted", "chat")
	mgr.mu.Unlock()
	if snapshot := ingest("deleted"); snapshot.ChatID != "" {
		t.Fatalf("late activity published a deleted durable: %+v", snapshot)
	}

	// When: non-resident retirements exhaust the bounded history.
	mgr.mu.Lock()
	for i := 0; i <= maxIdentityTombstones; i++ {
		id := fmt.Sprintf("other-%03d", i)
		mgr.retireDurableLocked(id, "other-chat")
	}
	resident := mgr.overviewCache["deleted"] != nil && mgr.overviewCache["deleted"].retired
	_, oldestNonResident := mgr.retiredDurable["other-000"]
	_, newestNonResident := mgr.retiredDurable[fmt.Sprintf("other-%03d", maxIdentityTombstones)]
	historySize := mgr.retirement.HistoryLen()
	mgr.mu.Unlock()

	// Then: the resident barrier survives, while oldest non-resident evidence
	// is evicted first and the retirement history remains bounded.
	if !resident || oldestNonResident || !newestNonResident || historySize > maxIdentityTombstones {
		t.Fatalf("retirement evidence after churn: resident=%t oldest=%t newest=%t size=%d",
			resident, oldestNonResident, newestNonResident, historySize)
	}
	if snapshot := ingest("deleted"); snapshot.ChatID != "" {
		t.Fatalf("resident deleted durable resurrected: %+v", snapshot)
	}
}
