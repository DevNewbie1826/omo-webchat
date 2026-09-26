package session

import (
	"context"
	"sync"
	"testing"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

type durableOwner struct {
	chatID string
	name   string
}

type resolvingCursorStore struct {
	*memCursorStore
	mu     sync.Mutex
	owners map[string]durableOwner
	calls  int
}

func newResolvingCursorStore() *resolvingCursorStore {
	return &resolvingCursorStore{memCursorStore: newMemStore(), owners: make(map[string]durableOwner)}
}

func (s *resolvingCursorStore) ChatForDurable(durableID string) (string, string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls++
	owner, ok := s.owners[durableID]
	return owner.chatID, owner.name, ok
}

func (s *resolvingCursorStore) setOwner(durableID, chatID, name string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.owners[durableID] = durableOwner{chatID: chatID, name: name}
}

func TestUnboundOverviewUsesStoredChatWithoutAcquire(t *testing.T) {
	d := newDaemon(t)
	store := newResolvingCursorStore()
	store.setOwner("stored-durable", "stored-chat", "Stored title")
	mgr := testManager(t, dial(t, d), store, 64)
	updates := make(chan Summary, 2)
	unsubscribe := mgr.SubscribeOverview(func(snapshot Summary) { updates <- snapshot })
	defer unsubscribe()

	emitUnboundActivity(d, "stored-durable", activitySnapshotOrder[0], map[string]any{"tasks": []any{}})
	got := awaitOverview(t, updates)
	if got.ChatID != "stored-chat" || got.DurableSessionID != "stored-durable" || got.Title != "Stored title" {
		t.Fatalf("subscriber received unresolved chat: %+v", got)
	}
	live := mgr.LiveSummaries()
	if len(live) != 1 || live[0].ChatID != "stored-chat" || live[0].Title != "Stored title" {
		t.Fatalf("live rows did not resolve stored owner and name: %+v", live)
	}
}

func TestUnboundOverviewRekeysWhenStoreGainsDurableIdentity(t *testing.T) {
	d := newDaemon(t)
	store := newResolvingCursorStore()
	mgr := testManager(t, dial(t, d), store, 64)
	updates := make(chan Summary, 3)
	unsubscribe := mgr.SubscribeOverview(func(snapshot Summary) { updates <- snapshot })
	defer unsubscribe()
	remaps := make(chan Summary, 3)
	_, unsubscribeExplicit := mgr.SubscribeActivity(false, []string{"rekey-durable"}, func(snapshot Summary, _ bool) { remaps <- snapshot })
	defer unsubscribeExplicit()

	emitUnboundActivity(d, "rekey-durable", activitySnapshotOrder[0], map[string]any{"tasks": []any{}})
	if got := awaitOverview(t, updates); got.ChatID != "rekey-durable" {
		t.Fatalf("initial fallback row = %+v", got)
	}
	_ = awaitOverview(t, remaps)
	store.setOwner("rekey-durable", "rekey-chat", "Original title")
	emitUnboundActivity(d, "rekey-durable", activitySnapshotOrder[0], map[string]any{"tasks": []any{}})
	if got := awaitOverview(t, updates); got.ChatID != "rekey-chat" || got.ReplacesSessionID != "rekey-durable" || got.Title != "Original title" {
		t.Fatalf("rekeyed snapshot = %+v", got)
	}
	if got := awaitOverview(t, remaps); got.ChatID != "rekey-chat" || got.ReplacesSessionID != "rekey-durable" {
		t.Fatalf("durable subscriber missed remap: %+v", got)
	}
	live := mgr.LiveSummaries()
	if len(live) != 1 || live[0].ChatID != "rekey-chat" {
		t.Fatalf("stale durable row survived rekey: %+v", live)
	}

	store.setOwner("rekey-durable", "rekey-chat", "Renamed title")
	emitUnboundActivity(d, "rekey-durable", activitySnapshotOrder[0], map[string]any{"tasks": []any{}})
	if got := awaitOverview(t, updates); got.Title != "Renamed title" || got.ReplacesSessionID != "" {
		t.Fatalf("stored name was not refreshed: %+v", got)
	}
}

func TestUnboundOverviewKeepsUnknownDurableIdentity(t *testing.T) {
	d := newDaemon(t)
	mgr := testManager(t, dial(t, d), newResolvingCursorStore(), 64)
	updates := make(chan Summary, 1)
	unsubscribe := mgr.SubscribeOverview(func(snapshot Summary) { updates <- snapshot })
	defer unsubscribe()

	emitUnboundActivity(d, "unknown-durable", activitySnapshotOrder[0], map[string]any{"tasks": []any{}})
	if got := awaitOverview(t, updates); got.ChatID != "unknown-durable" || got.Title != "" {
		t.Fatalf("unknown durable did not keep fallback identity: %+v", got)
	}
}

func TestUnboundOverviewPrefersManagerIdentityOverStore(t *testing.T) {
	d := newDaemon(t)
	store := newResolvingCursorStore()
	store.setOwner("mapped-durable", "stale-chat", "Stale title")
	mgr := testManager(t, dial(t, d), store, 64)
	mgr.mu.Lock()
	mgr.durableToChat["mapped-durable"] = "current-chat"
	mgr.mu.Unlock()
	updates := make(chan Summary, 1)
	unsubscribe := mgr.SubscribeOverview(func(snapshot Summary) { updates <- snapshot })
	defer unsubscribe()

	emitUnboundActivity(d, "mapped-durable", activitySnapshotOrder[0], map[string]any{"tasks": []any{}})
	if got := awaitOverview(t, updates); got.ChatID != "current-chat" || got.Title == "Stale title" {
		t.Fatalf("store identity displaced manager mapping: %+v", got)
	}
}

func TestUnboundOverviewDropsRetiredDurableBeforeResolver(t *testing.T) {
	store := newResolvingCursorStore()
	store.setOwner("retired-durable", "retired-chat", "Retired")
	mgr := NewManager(Config{Store: store})
	t.Cleanup(func() { _ = mgr.CloseAll(context.Background()) })
	mgr.mu.Lock()
	mgr.retireDurableLocked("retired-durable", "retired-chat")
	mgr.mu.Unlock()

	raw := []byte(`{"name":"omo.task.updated","data":{"tasks":[]}}`)
	_, snapshot, subscribers := mgr.ingestEpochEvent(omorpc.EpochToken{}, &omorpc.Event{
		Type: "extension_event", SessionID: "retired-durable", Raw: raw,
	})
	if snapshot.ChatID != "" || len(subscribers) != 0 || len(mgr.LiveSummaries()) != 0 {
		t.Fatalf("retired durable published overview: %+v", snapshot)
	}
	store.mu.Lock()
	calls := store.calls
	store.mu.Unlock()
	if calls != 0 {
		t.Fatalf("resolver called %d times for retired durable", calls)
	}
}

func TestUnboundOverviewAvoidsLiveChatCollision(t *testing.T) {
	d := newDaemon(t)
	store := newResolvingCursorStore()
	mgr := testManager(t, dial(t, d), store, 64)
	sess, _, _ := acquire(t, mgr, testChat{id: "live-chat", cwd: t.TempDir()}, nil)
	store.setOwner("other-durable", "live-chat", "Conflicting owner")
	updates := make(chan Summary, 1)
	unsubscribe := mgr.SubscribeOverview(func(snapshot Summary) { updates <- snapshot })
	defer unsubscribe()

	emitUnboundActivity(d, "other-durable", activitySnapshotOrder[0], map[string]any{"tasks": []any{}})
	if got := awaitOverview(t, updates); got.ChatID != "other-durable" {
		t.Fatalf("unbound row collided with live session: %+v", got)
	}
	live := mgr.LiveSummaries()
	if len(live) != 2 || live[0].ChatID == live[1].ChatID {
		t.Fatalf("duplicate chat identity in live rows (%q): %+v", sess.ID(), live)
	}
}

func TestAcquireMergesResolvedUnboundOverviewWithoutReplacement(t *testing.T) {
	d := newDaemon(t)
	store := newResolvingCursorStore()
	const durableID = "durable-00000001-4f2a-9c31"
	store.setOwner(durableID, "attached-chat", "Stored name")
	if err := store.SaveCursor(context.Background(), "attached-chat", Cursor{Name: "Stored name"}); err != nil {
		t.Fatal(err)
	}
	mgr := testManager(t, dial(t, d), store, 64)
	updates := make(chan Summary, 2)
	unsubscribe := mgr.SubscribeOverview(func(snapshot Summary) { updates <- snapshot })
	defer unsubscribe()

	emitUnboundActivity(d, durableID, activitySnapshotOrder[0], map[string]any{"tasks": []any{}})
	if got := awaitOverview(t, updates); got.ChatID != "attached-chat" {
		t.Fatalf("resolved pre-acquire row = %+v", got)
	}
	sess, _, _ := acquire(t, mgr, testChat{id: "attached-chat", cwd: t.TempDir()}, nil)
	if sess.ID() != durableID {
		t.Fatalf("opened durable id = %q, want %q", sess.ID(), durableID)
	}
	if got := awaitOverview(t, updates); got.ChatID != "attached-chat" || got.ReplacesSessionID != "" {
		t.Fatalf("acquire spuriously remapped resolved chat: %+v", got)
	}
	if live := mgr.LiveSummaries(); len(live) != 1 || live[0].ChatID != "attached-chat" {
		t.Fatalf("acquire duplicated resolved row: %+v", live)
	}
}

func TestAcquireNewDurableRemovesOtherResolvedOverviewForChat(t *testing.T) {
	d := newDaemon(t)
	store := newResolvingCursorStore()
	store.setOwner("old-durable", "rebound-chat", "Stored title")
	mgr := testManager(t, dial(t, d), store, 64)
	updates := make(chan Summary, 2)
	unsubscribe := mgr.SubscribeOverview(func(snapshot Summary) { updates <- snapshot })
	defer unsubscribe()

	emitUnboundActivity(d, "old-durable", activitySnapshotOrder[0], map[string]any{"tasks": []any{}})
	if got := awaitOverview(t, updates); got.ChatID != "rebound-chat" {
		t.Fatalf("initial resolved row = %+v", got)
	}
	sess, _, _ := acquire(t, mgr, testChat{id: "rebound-chat", cwd: t.TempDir()}, nil)
	if sess.ID() == "old-durable" {
		t.Fatal("test did not bind a new durable session")
	}
	if got := awaitOverview(t, updates); got.ChatID != "rebound-chat" || got.DurableSessionID != sess.ID() || got.ReplacesSessionID != "" {
		t.Fatalf("subscriber did not receive single bound chat identity: %+v", got)
	}
	live := mgr.LiveSummaries()
	if len(live) != 1 || live[0].ChatID != "rebound-chat" || live[0].DurableSessionID != sess.ID() {
		t.Fatalf("old cached row duplicated rebound chat: %+v", live)
	}
	mgr.mu.Lock()
	_, stale := mgr.overviewCache["old-durable"]
	mgr.mu.Unlock()
	if stale {
		t.Fatal("old resolved durable remained cached after rebind")
	}
}

func TestLateOldDurableAfterRebindKeepsOnlyOneChatRow(t *testing.T) {
	d := newDaemon(t)
	store := newResolvingCursorStore()
	store.setOwner("old-durable", "rebound-chat", "Stored title")
	mgr := testManager(t, dial(t, d), store, 64)
	updates := make(chan Summary, 3)
	unsubscribe := mgr.SubscribeOverview(func(snapshot Summary) { updates <- snapshot })
	defer unsubscribe()

	emitUnboundActivity(d, "old-durable", activitySnapshotOrder[0], map[string]any{"tasks": []any{}})
	_ = awaitOverview(t, updates)
	sess, _, _ := acquire(t, mgr, testChat{id: "rebound-chat", cwd: t.TempDir()}, nil)
	_ = awaitOverview(t, updates)
	emitUnboundActivity(d, "old-durable", activitySnapshotOrder[0], map[string]any{"tasks": []any{}})
	if got := awaitOverview(t, updates); got.ChatID != "old-durable" || got.ReplacesSessionID != "" {
		t.Fatalf("late old durable remapped live chat: %+v", got)
	}
	live := mgr.LiveSummaries()
	if len(live) != 2 || live[0].ChatID != "old-durable" || live[1].ChatID != "rebound-chat" || live[1].DurableSessionID != sess.ID() {
		t.Fatalf("late old durable duplicated chat identity: %+v", live)
	}
}
