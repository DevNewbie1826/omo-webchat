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
	initial, unsubscribeExplicit := mgr.SubscribeActivity(false, []string{"child-durable"}, func(Summary, bool) {})
	defer unsubscribeExplicit()
	if len(initial) != 1 || initial[0].ChatID != "child-durable" {
		t.Fatalf("explicit subscription initial snapshot = %+v", initial)
	}
}

func TestManagerAcquireRemapsOverviewAndRoutesRetiredHandleByDurableID(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	mgr := testManager(t, client, newMemStore(), 64)
	arrived := make(chan Summary, 4)
	unsubscribe := mgr.SubscribeOverview(func(snapshot Summary) { arrived <- snapshot })
	defer unsubscribe()

	const (
		durableID = "durable-00000001-4f2a-9c31"
		chatID    = "attached-chat"
	)
	emitUnboundActivity(d, durableID, activitySnapshotOrder[0], map[string]any{
		"tasks": []any{map[string]any{"task_id": "before-attach", "status": "running"}},
	})
	if provisional := awaitOverview(t, arrived); provisional.ChatID != durableID {
		t.Fatalf("provisional chat id = %q, want durable fallback", provisional.ChatID)
	}

	explicit := make(chan Summary, 2)
	_, unsubscribeExplicit := mgr.SubscribeActivity(false, []string{chatID}, func(snapshot Summary, _ bool) { explicit <- snapshot })
	defer unsubscribeExplicit()
	provisionalExplicit := make(chan Summary, 2)
	_, unsubscribeProvisional := mgr.SubscribeActivity(false, []string{durableID}, func(snapshot Summary, _ bool) { provisionalExplicit <- snapshot })
	defer unsubscribeProvisional()
	sess, _, _ := acquire(t, mgr, testChat{id: chatID, cwd: t.TempDir()}, nil)
	if sess.ID() != durableID {
		t.Fatalf("opened durable id = %q, want %q", sess.ID(), durableID)
	}
	remapped := awaitOverview(t, arrived)
	if remapped.ChatID != chatID || remapped.DurableSessionID != durableID || remapped.ReplacesSessionID != durableID {
		t.Fatalf("remapped identity = (%q, %q, replaces %q)", remapped.ChatID, remapped.DurableSessionID, remapped.ReplacesSessionID)
	}
	if got := awaitOverview(t, explicit); got.ChatID != chatID {
		t.Fatalf("chat subscriber missed remap: %+v", got)
	}
	if got := awaitOverview(t, provisionalExplicit); got.ChatID != chatID || got.ReplacesSessionID != durableID {
		t.Fatalf("provisional subscriber missed remap: %+v", got)
	}

	// The provider can deliver a child snapshot on a routing handle retired by
	// attach. parent_session_id resolves it through the same-epoch durable index.
	d.Emit(map[string]any{
		"type": "extension_event", "sessionId": "retired-route", "name": activitySnapshotOrder[0],
		"data": map[string]any{"parent_session_id": durableID, "tasks": []any{map[string]any{"task_id": "after-attach", "status": "running"}}},
	})
	late := awaitOverview(t, explicit)
	if late.TaskDigest == nil || len(late.TaskDigest.Tasks) != 1 || late.TaskDigest.Tasks[0].TaskID != "after-attach" {
		t.Fatalf("late retired-route snapshot was not dispatched to bound session: %+v", late)
	}
	live := mgr.LiveSummaries()
	if len(live) != 1 || live[0].ChatID != chatID || live[0].DurableSessionID != durableID {
		t.Fatalf("transition produced duplicate or unresolvable rows: %+v", live)
	}
}

func TestManagerClosedIdentityTombstonesAreBoundedAndLightweight(t *testing.T) {
	mgr := NewManager(Config{})
	t.Cleanup(func() { _ = mgr.CloseAll(context.Background()) })
	token := omorpc.EpochToken{}

	mgr.mu.Lock()
	for i := 0; i < maxIdentityTombstones+32; i++ {
		id := fmt.Sprintf("durable-%03d", i)
		s := newSession(mgr, fmt.Sprintf("chat-%03d", i), "/tmp", omorpc.OpenSessionData{
			SessionID: "route-" + id, State: omorpc.SessionState{SessionID: id, SessionFile: "/tmp/" + id},
		}, false, token)
		mgr.byChat[s.chatID], mgr.byRoute[s.routingID] = s, s
		mgr.bindIdentityLocked(s)
		mgr.retireSessionIdentityLocked(s, false)
	}
	entries := mgr.byDurableEpoch[token]
	indexLen, fifoLen := len(entries), len(mgr.durableTombstones)
	var retainedSession string
	for durable, binding := range entries {
		if binding.session != nil {
			retainedSession = durable
			break
		}
	}
	mgr.mu.Unlock()
	if indexLen != maxIdentityTombstones || fifoLen != maxIdentityTombstones {
		t.Fatalf("same-epoch tombstones = (%d index, %d fifo), want %d", indexLen, fifoLen, maxIdentityTombstones)
	}
	if retainedSession != "" {
		t.Fatalf("tombstone %q retained full session", retainedSession)
	}
}

func TestManagerPermanentDeletionDropsLaterEpochDurableEvent(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	mgr := testManager(t, client, newMemStore(), 64)
	oldToken, oldEvents := client.CurrentEpoch()
	const chatID, durableID = "deleted-chat", "deleted-durable"
	s := newSession(mgr, chatID, "/tmp", omorpc.OpenSessionData{
		SessionID: "deleted-route", State: omorpc.SessionState{SessionID: durableID, SessionFile: "/tmp/deleted"},
	}, false, oldToken)
	mgr.mu.Lock()
	mgr.byChat[chatID], mgr.byRoute[s.routingID] = s, s
	mgr.bindIdentityLocked(s)
	mgr.mu.Unlock()
	invalidated := newRecorder(1)
	detach, err := s.attachChecked(invalidated)
	if err != nil {
		t.Fatalf("attach invalidation observer: %v", err)
	}
	defer detach()

	mgr.RetireIdentity(chatID)
	mgr.mu.Lock()
	_, mapped := mgr.durableToChat[durableID]
	mgr.mu.Unlock()
	if mapped {
		t.Fatal("permanently deleted durable identity remained mapped")
	}
	if live := mgr.LiveSummaries(); len(live) != 0 {
		t.Fatalf("permanently deleted identity remained live: %+v", live)
	}

	d.DropConnections()
	select {
	case <-oldEvents:
	case <-time.After(testTimeout):
		t.Fatal("old epoch did not close")
	}
	invalidated.awaitError(t, "provider_disconnected")
	mgr.mu.Lock()
	_, stillRetired := mgr.retiredDurable[durableID]
	mgr.mu.Unlock()
	if !stillRetired {
		t.Fatal("epoch invalidation revived permanently deleted durable identity")
	}
	if _, err := client.Call(context.Background(), omorpc.ListSessions{}); err != nil {
		t.Fatalf("reconnect: %v", err)
	}
	newToken, _ := client.CurrentEpoch()
	raw := json.RawMessage(`{"type":"extension_event","sessionId":"deleted-durable","name":"omo.task.updated","data":{"tasks":[]}}`)
	_, snapshot, subscribers := mgr.ingestEpochEvent(newToken, &omorpc.Event{Type: "extension_event", SessionID: durableID, Raw: raw})
	deliverOverview(subscribers, snapshot)
	if live := mgr.LiveSummaries(); len(live) != 0 {
		t.Fatalf("later-epoch deleted identity recreated overview: %+v", live)
	}
}

func TestManagerEpochBarrierRetiresOnSuccessorIngestion(t *testing.T) {
	mgr := NewManager(Config{})
	t.Cleanup(func() { _ = mgr.CloseAll(context.Background()) })
	old := omorpc.EpochToken{}
	mgr.detachEpoch(old)
	mgr.mu.Lock()
	if len(mgr.invalidatedEpochs) != 1 {
		t.Fatalf("invalidation barriers before successor = %d, want 1", len(mgr.invalidatedEpochs))
	}
	mgr.mu.Unlock()

	// Tokens are opaque outside omorpc, so a live daemon supplies a distinct
	// successor token without depending on token representation.
	d := newDaemon(t)
	client := dial(t, d)
	newToken, _ := client.CurrentEpoch()
	if newToken == old {
		t.Fatal("daemon returned zero epoch token")
	}
	mgr.observeEpoch(newToken)
	mgr.mu.Lock()
	defer mgr.mu.Unlock()
	if len(mgr.invalidatedEpochs) != 0 {
		t.Fatalf("invalidation barriers after successor = %d, want 0", len(mgr.invalidatedEpochs))
	}
}

func TestManagerDelayedCheckedEventCannotCrossEpochInvalidation(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	mgr := testManager(t, client, newMemStore(), 64)
	token, _ := client.CurrentEpoch()
	raw := json.RawMessage(`{"type":"extension_event","sessionId":"late-child","name":"omo.task.updated","data":{"tasks":[]}}`)
	ev := &omorpc.Event{Type: "extension_event", SessionID: "late-child", Raw: raw}

	checked := make(chan struct{})
	release := make(chan struct{})
	done := make(chan struct{})
	go func() {
		if client.EpochCurrent(token) {
			close(checked)
			<-release
			_, snapshot, subscribers := mgr.ingestEpochEvent(token, ev)
			deliverOverview(subscribers, snapshot)
		}
		close(done)
	}()
	select {
	case <-checked:
	case <-time.After(testTimeout):
		t.Fatal("event did not pass the current-epoch check")
	}
	mgr.invalidateEpoch(token)
	close(release)
	select {
	case <-done:
	case <-time.After(testTimeout):
		t.Fatal("delayed ingestion did not finish")
	}
	if live := mgr.LiveSummaries(); len(live) != 0 {
		t.Fatalf("delayed event recreated invalidated epoch: %+v", live)
	}
}

func TestManagerBoundOverviewPublicationCannotCrossRouteRemoval(t *testing.T) {
	mgr := NewManager(Config{})
	t.Cleanup(func() {
		mgr.mu.Lock()
		mgr.byChat = make(map[string]*Session)
		mgr.byRoute = make(map[string]*Session)
		mgr.mu.Unlock()
		_ = mgr.CloseAll(context.Background())
	})
	token := omorpc.EpochToken{}
	s := newSession(mgr, "stable-chat", "/tmp", omorpc.OpenSessionData{
		SessionID: "route", State: omorpc.SessionState{SessionID: "durable", SessionFile: "/tmp/session.jsonl"},
	}, false, token)
	mgr.mu.Lock()
	mgr.byChat[s.chatID] = s
	mgr.byRoute[s.routingID] = s
	_, _ = mgr.mergeOverviewIntoSessionLocked(s)
	mgr.overviewCurrent[s.chatID] = s.summaryLocked()
	mgr.mu.Unlock()

	mutated := make(chan struct{})
	release := make(chan struct{})
	published := make(chan struct{})
	go func() {
		s.lifecycleMu.Lock()
		s.taskDigest = &TaskDigest{}
		close(mutated)
		<-release
		mgr.notifySessionOverviewLocked(s)
		s.lifecycleMu.Unlock()
		close(published)
	}()
	select {
	case <-mutated:
	case <-time.After(testTimeout):
		t.Fatal("bound publication did not reach gate")
	}
	all := mgr.detachEpoch(token)
	close(release)
	select {
	case <-published:
	case <-time.After(testTimeout):
		t.Fatal("bound publication did not finish")
	}
	for _, detached := range all {
		detached.invalidate("provider_disconnected", "provider connection lost")
	}
	mgr.mu.Lock()
	_, recreated := mgr.overviewCurrent[s.chatID]
	mgr.mu.Unlock()
	if recreated {
		t.Fatal("bound publication recreated overview after route removal")
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

func publishOverviewForTest(mgr *Manager, snapshot Summary) {
	mgr.mu.Lock()
	subscribers := mgr.updateOverviewLocked(snapshot)
	mgr.mu.Unlock()
	deliverOverview(subscribers, snapshot)
}

func TestExplicitActivitySubscriptionFiltersBeforeManagerQueue(t *testing.T) {
	mgr := NewManager(Config{})
	t.Cleanup(func() { _ = mgr.CloseAll(context.Background()) })
	publishOverviewForTest(mgr, Summary{ChatID: "selected"})
	publishOverviewForTest(mgr, Summary{ChatID: "other"})

	delivered := make(chan Summary, 1)
	initial, unsubscribe := mgr.SubscribeActivity(false, []string{"selected"}, func(snapshot Summary, _ bool) {
		delivered <- snapshot
	})
	defer unsubscribe()
	if len(initial) != 1 || initial[0].ChatID != "selected" {
		t.Fatalf("filtered initial snapshot = %+v", initial)
	}
	for i := 0; i < overviewSubscriberQueue+1; i++ {
		publishOverviewForTest(mgr, Summary{ChatID: "other", Title: fmt.Sprint(i)})
	}
	publishOverviewForTest(mgr, Summary{ChatID: "selected", Title: "latest"})
	if got := awaitOverview(t, delivered); got.ChatID != "selected" || got.Title != "latest" {
		t.Fatalf("explicit delivery = %+v", got)
	}
}

func TestActivityManagerQueuePropagatesOverflow(t *testing.T) {
	mgr := NewManager(Config{})
	t.Cleanup(func() { _ = mgr.CloseAll(context.Background()) })
	started := make(chan struct{})
	release := make(chan struct{})
	overflowed := make(chan struct{}, 1)
	var once sync.Once
	_, unsubscribe := mgr.SubscribeActivity(true, nil, func(_ Summary, overflow bool) {
		once.Do(func() {
			close(started)
			<-release
		})
		if overflow {
			select {
			case overflowed <- struct{}{}:
			default:
			}
		}
	})
	defer unsubscribe()
	publishOverviewForTest(mgr, Summary{ChatID: "child", Title: "blocked"})
	select {
	case <-started:
	case <-time.After(testTimeout):
		t.Fatal("activity subscriber did not block")
	}
	for i := 0; i <= overviewSubscriberQueue; i++ {
		publishOverviewForTest(mgr, Summary{ChatID: "child", Title: fmt.Sprint(i)})
	}
	close(release)
	select {
	case <-overflowed:
	case <-time.After(testTimeout):
		t.Fatal("manager queue loss was not reported")
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
