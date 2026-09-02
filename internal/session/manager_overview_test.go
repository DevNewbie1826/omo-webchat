package session

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

func emitUnboundActivity(d interface{ Emit(map[string]any) }, durableID, name string, data map[string]any) {
	d.Emit(map[string]any{"type": "extension_event", "sessionId": durableID, "name": name, "data": data})
}

func awaitOverview(t *testing.T, snapshots <-chan Summary) Summary {
	t.Helper()
	select {
	case snapshot := <-snapshots:
		return snapshot
	case <-time.After(testTimeout):
		t.Fatal("overview snapshot was not delivered")
		return Summary{}
	}
}

func TestManagerCachesUnboundActivityForLiveOverview(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	mgr := testManager(t, client, newMemStore(), 64)
	notified := make(chan Summary, 1)
	unsubscribe := mgr.SubscribeOverview(func(snapshot Summary) { notified <- snapshot })
	defer unsubscribe()

	emitUnboundActivity(d, "child-durable", activitySnapshotOrder[0], map[string]any{
		"tasks": []any{map[string]any{"task_id": "t1", "status": "running"}},
	})
	snapshot := awaitOverview(t, notified)
	if snapshot.ChatID != "child-durable" || snapshot.DurableSessionID != "child-durable" {
		t.Fatalf("snapshot identity = (%q, %q)", snapshot.ChatID, snapshot.DurableSessionID)
	}
	if snapshot.TaskDigest == nil || len(snapshot.TaskDigest.Tasks) != 1 {
		t.Fatalf("task digest = %+v", snapshot.TaskDigest)
	}

	live := mgr.LiveSummaries()
	if len(live) != 1 || live[0].ChatID != "child-durable" || len(live[0].ActivityPair.Task) == 0 {
		t.Fatalf("live summaries = %+v", live)
	}
	initial, unsubscribeExplicit := mgr.SubscribeActivity(false, []string{"child-durable"}, func(Summary) {})
	defer unsubscribeExplicit()
	if len(initial) != 1 || initial[0].ChatID != "child-durable" {
		t.Fatalf("explicit subscription initial snapshot = %+v", initial)
	}
}

func TestManagerAcquireMergesAndEvictsMatchingOverview(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	mgr := testManager(t, client, newMemStore(), 64)
	arrived := make(chan Summary, 1)
	unsubscribe := mgr.SubscribeOverview(func(snapshot Summary) { arrived <- snapshot })
	defer unsubscribe()

	const durableID = "durable-00000001-4f2a-9c31"
	emitUnboundActivity(d, durableID, activitySnapshotOrder[0], map[string]any{
		"tasks": []any{map[string]any{"task_id": "before-attach", "status": "running"}},
	})
	_ = awaitOverview(t, arrived)

	sess, _, _ := acquire(t, mgr, testChat{id: "attached-chat", cwd: t.TempDir()}, nil)
	if sess.ID() != durableID {
		t.Fatalf("opened durable id = %q, want %q", sess.ID(), durableID)
	}
	summary, ok := sess.summary()
	if !ok || summary.TaskDigest == nil || len(summary.TaskDigest.Tasks) != 1 || summary.TaskDigest.Tasks[0].TaskID != "before-attach" {
		t.Fatalf("merged summary = (%+v, %v)", summary, ok)
	}
	live := mgr.LiveSummaries()
	if len(live) != 1 || live[0].ChatID != "attached-chat" || live[0].DurableSessionID != durableID {
		t.Fatalf("cache was not cleanly replaced by attached session: %+v", live)
	}
}

func TestManagerEpochInvalidationDropsOverviewCache(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	mgr := testManager(t, client, newMemStore(), 64)
	arrived := make(chan Summary, 1)
	unsubscribe := mgr.SubscribeOverview(func(snapshot Summary) { arrived <- snapshot })
	defer unsubscribe()

	token, _ := client.CurrentEpoch()
	emitUnboundActivity(d, "epoch-child", activitySnapshotOrder[1], map[string]any{"runs": []any{}})
	_ = awaitOverview(t, arrived)
	mgr.invalidateEpoch(token)
	if live := mgr.LiveSummaries(); len(live) != 0 {
		t.Fatalf("dead epoch retained overview cache: %+v", live)
	}
}

func TestSlowOverviewSubscriberDoesNotStallEventLoop(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	mgr := testManager(t, client, newMemStore(), 64)

	slowStarted := make(chan struct{})
	releaseSlow := make(chan struct{})
	slowDone := make(chan struct{})
	var startedOnce, doneOnce sync.Once
	unsubscribeSlow := mgr.SubscribeOverview(func(Summary) {
		startedOnce.Do(func() { close(slowStarted) })
		<-releaseSlow
		doneOnce.Do(func() { close(slowDone) })
	})
	fast := make(chan Summary, 2)
	unsubscribeFast := mgr.SubscribeOverview(func(snapshot Summary) { fast <- snapshot })
	defer func() {
		close(releaseSlow)
		<-slowDone
		unsubscribeSlow()
		unsubscribeFast()
	}()

	emitUnboundActivity(d, "slow-child", activitySnapshotOrder[0], map[string]any{"tasks": []any{}})
	select {
	case <-slowStarted:
	case <-time.After(testTimeout):
		t.Fatal("slow subscriber did not start")
	}
	_ = awaitOverview(t, fast)

	emitUnboundActivity(d, "slow-child", activitySnapshotOrder[1], map[string]any{"runs": []any{}})
	second := awaitOverview(t, fast)
	if len(second.ActivityPair.Dag) == 0 {
		t.Fatalf("second snapshot did not pass blocked subscriber: %+v", second)
	}
}

func TestOverviewCacheHasLRUBound(t *testing.T) {
	mgr := NewManager(Config{})
	t.Cleanup(func() { _ = mgr.CloseAll(context.Background()) })
	for i := 0; i < maxOverviewCacheEntries+1; i++ {
		id := fmt.Sprintf("child-%03d", i)
		raw, err := json.Marshal(map[string]any{"type": "extension_event", "sessionId": id, "name": activitySnapshotOrder[0], "data": map[string]any{"tasks": []any{}}})
		if err != nil {
			t.Fatal(err)
		}
		mgr.mu.Lock()
		mgr.ingestUnboundOverviewLocked(omorpc.EpochToken{}, &omorpc.Event{Type: "extension_event", SessionID: id, Raw: raw})
		mgr.mu.Unlock()
	}
	mgr.mu.Lock()
	defer mgr.mu.Unlock()
	if len(mgr.overviewCache) != maxOverviewCacheEntries {
		t.Fatalf("overview cache size = %d, want %d", len(mgr.overviewCache), maxOverviewCacheEntries)
	}
	if _, retained := mgr.overviewCache["child-000"]; retained {
		t.Fatal("least-recently-used overview was retained")
	}
	if len(mgr.overviewCurrent) != maxOverviewCacheEntries {
		t.Fatalf("overview subscription index size = %d, want %d", len(mgr.overviewCurrent), maxOverviewCacheEntries)
	}
}
