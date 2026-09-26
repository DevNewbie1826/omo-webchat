package session

import (
	"context"
	"fmt"
	"math/rand"
	"reflect"
	"testing"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

func TestPR197ExposedPinsFollowRandomizedOwnershipAndResidency(t *testing.T) {
	for _, seed := range []int64{19712, 29} {
		t.Run(fmt.Sprintf("seed_%d", seed), func(t *testing.T) {
			testExposedPinsFollowRandomizedOwnershipAndResidency(t, seed)
		})
	}
}

func testExposedPinsFollowRandomizedOwnershipAndResidency(t *testing.T, seed int64) {
	// Given a fixed sequence with more durables than the overview cache can hold.
	const durables = maxOverviewCacheEntries + 64
	store := newResolvingCursorStore()
	mgr := NewManager(Config{Store: store})
	t.Cleanup(func() {
		mgr.mu.Lock()
		clear(mgr.byChat)
		clear(mgr.byRoute)
		mgr.mu.Unlock()
		mustOK(t, mgr.CloseAll(context.Background()))
	})
	for i := 0; i < durables; i++ {
		store.setOwner(fmt.Sprintf("durable-%d", i), fmt.Sprintf("chat-%d", i%12), "Title")
	}
	random := rand.New(rand.NewSource(seed))
	bound := make(map[string]*Session)
	cachedRenames, boundRenames := 0, 0
	observed := make(map[string]int64)
	exposedOwners := make(map[string]string)
	type seenOverview struct {
		durable, title string
		active         bool
		values         LiveValues
	}
	visible := make(map[string]seenOverview)
	event := func(durable string) Summary {
		_, row, _ := mgr.ingestEpochEvent(omorpc.EpochToken{}, &omorpc.Event{
			Type: "extension_event", SessionID: durable,
			Raw: []byte(`{"name":"omo.task.updated","data":{"tasks":[]}}`),
		})
		return row
	}
	checkRevision := func(step int, row Summary) {
		if row.ChatID == "" || row.LiveValues().LastActivityMS == nil {
			return
		}
		if previous := row.ReplacesSessionID; previous != "" &&
			exposedOwners[previous] != "" && exposedOwners[previous] != row.DurableSessionID {
			t.Fatalf("step %d: %s:%s replaces exposed %s:%s",
				step, row.ChatID, row.DurableSessionID, previous, exposedOwners[previous])
		}
		revision := *row.LiveValues().LastActivityMS
		values := row.LiveValues()
		values.LastActivityMS = nil
		prior, known := visible[row.ChatID]
		changed := !known || prior.durable != row.DurableSessionID || prior.title != row.Title ||
			prior.active != row.Active || !reflect.DeepEqual(prior.values, values)
		if previous, ok := observed[row.ChatID]; ok {
			if changed && revision <= previous {
				t.Fatalf("step %d: changed chat %q revision did not advance from %d to %d: prior=%+v current=%+v values=%+v",
					step, row.ChatID, previous, revision, prior, row, values)
			}
			if revision < previous {
				t.Fatalf("step %d: chat %q revision fell from %d to %d", step, row.ChatID, previous, revision)
			}
		}
		observed[row.ChatID] = revision
		exposedOwners[row.ChatID] = row.DurableSessionID
		visible[row.ChatID] = seenOverview{row.DurableSessionID, row.Title, row.Active, values}
	}

	// When cache ingestion/eviction, binding, ownership, reads, and
	// publications interleave, check the independent store/route model.
	for step := 0; step < 760; step++ {
		durable := fmt.Sprintf("durable-%d", random.Intn(durables))
		if step < durables {
			durable = fmt.Sprintf("durable-%d", step)
		}
		switch {
		case step < durables || step%9 == 0:
			checkRevision(step, event(durable))
		case step%9 == 1:
			store.setOwner(durable, fmt.Sprintf("chat-%d", random.Intn(12)), "Changed")
		case step%9 == 2:
			store.deleteOwner(durable)
		case step%9 == 3:
			if bound[durable] == nil {
				chat := fmt.Sprintf("chat-%d", random.Intn(12))
				s := newSession(mgr, chat, "/tmp", omorpc.OpenSessionData{
					SessionID: fmt.Sprintf("route-%d", step),
					State:     omorpc.SessionState{SessionID: durable},
				}, false, omorpc.EpochToken{})
				s.lifecycleMu.Lock()
				mgr.mu.Lock()
				if previous := mgr.byChat[chat]; previous != nil {
					mgr.retireSessionIdentityLocked(previous, false)
					delete(bound, previous.durableID)
				}
				mgr.byChat[chat], mgr.byRoute[s.routingID] = s, s
				mgr.mergeOverviewIntoSessionLocked(s)
				mgr.mu.Unlock()
				s.lifecycleMu.Unlock()
				bound[durable] = s
			}
		case step%9 == 4:
			if s := bound[durable]; s != nil {
				mgr.mu.Lock()
				mgr.retireSessionIdentityLocked(s, false)
				mgr.mu.Unlock()
				delete(bound, durable)
			}
		case step%9 == 5:
			for _, row := range mgr.LiveSummaries() {
				checkRevision(step, row)
			}
		case step%9 == 6:
			// Exercise a resident cached rename regardless of random ownership.
			for i := 0; i < durables; i++ {
				candidate := fmt.Sprintf("durable-%d", (step+i)%durables)
				mgr.mu.Lock()
				cached := mgr.overviewCache[candidate] != nil
				mgr.mu.Unlock()
				if _, _, ok := store.ChatForDurable(candidate); cached && ok && bound[candidate] == nil {
					durable = candidate
					break
				}
			}
			if chat, _, ok := store.ChatForDurable(durable); ok && bound[durable] == nil {
				mgr.mu.Lock()
				cached := mgr.overviewCache[durable] != nil
				mgr.mu.Unlock()
				if cached {
					cachedRenames++
				}
				name := fmt.Sprintf("Cached-%d", step)
				store.setOwner(durable, chat, name)
				mgr.ApplyChatTitle(chat, name)
				for _, row := range mgr.LiveSummaries() {
					checkRevision(step, row)
				}
			}
		case step%9 == 7:
			// Pick an existing bound row so this variant cannot disappear by chance.
			for i := 0; i < durables; i++ {
				candidate := fmt.Sprintf("durable-%d", (step+i)%durables)
				if bound[candidate] != nil {
					durable = candidate
					break
				}
			}
			if s := bound[durable]; s != nil {
				boundRenames++
				s.lifecycleMu.Lock()
				s.title = fmt.Sprintf("Bound-%d", step)
				mgr.notifySessionOverviewLocked(s)
				s.lifecycleMu.Unlock()
				for _, row := range mgr.LiveSummaries() {
					checkRevision(step, row)
				}
			}
		default:
			// A future receipt must lift the global revision clock before
			// another row's title or activity changes.
			if step%17 == 0 {
				mgr.mu.Lock()
				if entry := mgr.overviewCache[durable]; entry != nil && entry.task != nil {
					entry.task.ReceivedAt = "2100-01-01T00:00:00Z"
					entry.liveRevision = liveRevision{}
					future := mgr.projectOverviewLocked(Summary{DurableSessionID: durable})
					mgr.mu.Unlock()
					checkRevision(step, future)
				} else {
					mgr.mu.Unlock()
				}
			}
			checkRevision(step, event(durable))
		}
		if step == durables-1 {
			// This row is still cached after the initial eviction wave.
			mgr.mu.Lock()
			if mgr.overviewCache["durable-0"] != nil {
				mgr.mu.Unlock()
				t.Fatal("initial activity cache did not evict its oldest entry")
			}
			entry := mgr.overviewCache[durable]
			entry.task.ReceivedAt = "2100-01-01T00:00:00Z"
			entry.liveRevision = liveRevision{}
			future := mgr.projectOverviewLocked(Summary{DurableSessionID: durable})
			mgr.mu.Unlock()
			checkRevision(step, future)
			if value := future.LiveValues().LastActivityMS; value == nil || *value < 4102444800000 {
				t.Fatalf("future underlying receipt was not exposed: %+v", future)
			}
		}

		mgr.mu.Lock()
		resident := make(map[string]bool)
		for id := range mgr.overviewCache {
			if s := bound[id]; s != nil {
				resident[s.chatID] = true
			} else if owner, _, ok := store.ChatForDurable(id); ok {
				resident[owner] = true
			}
		}
		for _, s := range bound {
			resident[s.chatID] = true
		}
		for chat := range mgr.overviewExposed.pinned {
			if !resident[chat] {
				mgr.mu.Unlock()
				t.Fatalf("step %d: obsolete exposed pin for %q", step, chat)
			}
		}
		if pins := len(mgr.overviewExposed.pinned); pins > len(resident) ||
			mgr.overviewExposed.Len() > maxIdentityTombstones+len(resident) ||
			mgr.overviewExposed.HistoryLen() > maxIdentityTombstones {
			mgr.mu.Unlock()
			t.Fatalf("step %d: pins=%d resident_chats=%d entries=%d history=%d",
				step, pins, len(resident), mgr.overviewExposed.Len(), mgr.overviewExposed.HistoryLen())
		}
		mgr.overviewExposed.Range(func(chat string, exposure overviewExposure) {
			next := seenOverview{exposure.durable, exposure.title, exposure.active, exposure.values}
			if previous, ok := observed[chat]; ok {
				if prior := visible[chat]; !reflect.DeepEqual(prior, next) && exposure.revision <= previous {
					t.Errorf("step %d: retained chat %q changed without advancing revision from %d to %d",
						step, chat, previous, exposure.revision)
				}
				if exposure.revision < previous {
					t.Errorf("step %d: retained chat %q revision fell from %d to %d", step, chat, previous, exposure.revision)
				}
			}
			observed[chat] = exposure.revision
			visible[chat] = next
		})
		mgr.mu.Unlock()
	}
	if cachedRenames == 0 || boundRenames == 0 {
		t.Fatalf("model missed rename variants: cached=%d bound=%d", cachedRenames, boundRenames)
	}

	// Exercise a full non-resident watermark history and full cache. Shuffled
	// silent transfers have no Y publication: REST alone changes exposed owners.
	t.Run("full_capacity_rest_handoff", func(t *testing.T) {
		store := newResolvingCursorStore()
		mgr := NewManager(Config{Store: store})
		t.Cleanup(func() { mustOK(t, mgr.CloseAll(context.Background())) })
		rng := rand.New(rand.NewSource(19713))
		revisions := make(map[string]int64)
		exposedOwners := make(map[string]string)
		ingest := func(id string) Summary {
			_, row, _ := mgr.ingestEpochEvent(omorpc.EpochToken{}, &omorpc.Event{
				Type: "extension_event", SessionID: id,
				Raw: []byte(`{"name":"omo.task.updated","data":{"tasks":[]}}`),
			})
			return row
		}
		check := func(row Summary) {
			if row.ChatID == "" {
				return
			}
			if previous := row.ReplacesSessionID; previous != "" &&
				exposedOwners[previous] != "" && exposedOwners[previous] != row.DurableSessionID {
				t.Fatalf("%s:%s replaces exposed %s:%s",
					row.ChatID, row.DurableSessionID, previous, exposedOwners[previous])
			}
			if current := row.LiveValues().LastActivityMS; current != nil {
				if previous, ok := revisions[row.ChatID]; ok && *current < previous {
					t.Fatalf("%s revision fell from %d to %d", row.ChatID, previous, *current)
				}
				revisions[row.ChatID] = *current
			}
			exposedOwners[row.ChatID] = row.DurableSessionID
		}
		for i := 0; i < maxOverviewCacheEntries; i++ {
			x, a := fmt.Sprintf("x-%03d", i), fmt.Sprintf("a-%03d", i)
			store.setOwner(x, a, "Original")
			ingest(x)
			mgr.mu.Lock()
			mgr.overviewCache[x].task.ReceivedAt = "2100-01-01T00:00:00Z"
			mgr.overviewCache[x].liveRevision = liveRevision{}
			row := mgr.projectOverviewLocked(Summary{DurableSessionID: x})
			mgr.mu.Unlock()
			check(row)
		}
		for i := 0; i < maxOverviewCacheEntries; i++ {
			y := fmt.Sprintf("y-%03d", i)
			store.setOwner(y, fmt.Sprintf("b-%03d", i), "Replacement")
			ingest(y)
		}
		for _, i := range rng.Perm(maxOverviewCacheEntries) {
			store.deleteOwner(fmt.Sprintf("x-%03d", i))
			store.setOwner(fmt.Sprintf("y-%03d", i), fmt.Sprintf("a-%03d", i), "Replacement")
		}
		for _, row := range mgr.LiveSummaries() {
			check(row)
		}
		for i := maxOverviewCacheEntries - 16; i < maxOverviewCacheEntries; i++ {
			x := fmt.Sprintf("x-%03d", i)
			store.setOwner(x, fmt.Sprintf("b-%03d", i), "Returned")
			check(ingest(x))
		}
		for _, row := range mgr.LiveSummaries() {
			check(row)
		}
	})

	t.Run("evicted_watermark_silent_return", func(t *testing.T) {
		store := newResolvingCursorStore()
		mgr := NewManager(Config{Store: store})
		t.Cleanup(func() { mustOK(t, mgr.CloseAll(context.Background())) })
		rng := rand.New(rand.NewSource(19714))
		revisions := make(map[string]int64)
		ingest := func(id string) Summary {
			_, row, _ := mgr.ingestEpochEvent(omorpc.EpochToken{}, &omorpc.Event{
				Type: "extension_event", SessionID: id,
				Raw: []byte(`{"name":"omo.task.updated","data":{"tasks":[]}}`),
			})
			return row
		}
		check := func(row Summary) {
			if row.ChatID == "" {
				return
			}
			if current := row.LiveValues().LastActivityMS; current != nil {
				if previous, ok := revisions[row.ChatID]; ok && *current < previous {
					t.Fatalf("%s revision fell from %d to %d", row.ChatID, previous, *current)
				}
				revisions[row.ChatID] = *current
			}
		}

		// Given older resident durables and newer chat revisions that leave
		// residency without changing the resident durables' activity.
		for i := 0; i < 2; i++ {
			y, b := fmt.Sprintf("return-y-%d", i), fmt.Sprintf("return-b-%d", i)
			store.setOwner(y, b, "Shared")
			check(ingest(y))
		}
		for i := 0; i < 2; i++ {
			x, a := fmt.Sprintf("return-x-%d", i), fmt.Sprintf("return-a-%d", i)
			store.setOwner(x, a, "Shared")
			check(ingest(x))
			store.setOwner(x, fmt.Sprintf("parked-%d", i), "Shared")
			check(ingest(x))
		}

		// When more than a full history of unrelated rows is published,
		// refresh the older durables so their cache entries remain resident.
		for _, n := range rng.Perm(2*maxIdentityTombstones + 1) {
			for i := 0; i < 2; i++ {
				check(ingest(fmt.Sprintf("return-y-%d", i)))
			}
			id := fmt.Sprintf("return-filler-%d", n)
			check(ingest(id))
		}
		mgr.mu.Lock()
		for i := 0; i < 2; i++ {
			if _, retained := mgr.overviewExposed.Get(fmt.Sprintf("return-a-%d", i)); retained {
				mgr.mu.Unlock()
				t.Fatal("fixture did not evict the returning chat's watermark")
			}
		}
		mgr.mu.Unlock()

		// Then shuffled silent transfers back to the former chats never
		// lower their exposed revisions on REST or subsequent publication.
		for _, i := range rng.Perm(2) {
			store.setOwner(fmt.Sprintf("return-y-%d", i), fmt.Sprintf("return-a-%d", i), "Shared")
		}
		for _, row := range mgr.LiveSummaries() {
			check(row)
		}
		for _, i := range rng.Perm(2) {
			check(ingest(fmt.Sprintf("return-y-%d", i)))
		}
		mgr.mu.Lock()
		if mgr.overviewExposed.HistoryLen() > maxIdentityTombstones {
			t.Error("exposed revision history exceeded its bound")
		}
		mgr.mu.Unlock()
	})

	t.Run("nil_revision_idle_return", func(t *testing.T) {
		store := newResolvingCursorStore()
		mgr := NewManager(Config{Store: store})
		t.Cleanup(func() { mustOK(t, mgr.CloseAll(context.Background())) })
		project := func(durable string) Summary {
			mgr.mu.Lock()
			defer mgr.mu.Unlock()
			return mgr.projectOverviewLocked(Summary{DurableSessionID: durable})
		}

		// Given an idle row with no activity receipt and an evicted watermark.
		store.setOwner("old-idle", "idle-chat", "Idle")
		first := project("old-idle").LiveValues().LastActivityMS
		if first == nil {
			t.Fatal("initial idle row was not stamped")
		}
		store.deleteOwner("old-idle")
		for i := 0; i <= maxIdentityTombstones; i++ {
			id := fmt.Sprintf("idle-filler-%d", i)
			store.setOwner(id, id, "Filler")
			project(id)
		}
		mgr.mu.Lock()
		_, retained := mgr.overviewExposed.Get("idle-chat")
		mgr.mu.Unlock()
		if retained {
			t.Fatal("fixture retained the idle row's exposure")
		}

		// When the same chat returns on another idle durable, it is stamped
		// and its newly exposed owner is recorded without an activity receipt.
		store.setOwner("new-idle", "idle-chat", "Idle")
		returned := project("new-idle").LiveValues().LastActivityMS
		mgr.mu.Lock()
		exposure, known := mgr.overviewExposed.Get("idle-chat")
		mgr.mu.Unlock()
		if returned == nil || *returned <= *first || !known ||
			exposure.durable != "new-idle" || exposure.revision != *returned {
			t.Fatalf("idle return lost exposure: before=%d after=%v owner=%+v known=%t",
				*first, returned, exposure, known)
		}
	})

	t.Run("expired_source_owner_suppresses_manager_and_subscriber_remaps", func(t *testing.T) {
		store := newResolvingCursorStore()
		store.setOwner("source", "chat-a", "First")
		mgr := NewManager(Config{Store: store})
		t.Cleanup(func() { mustOK(t, mgr.CloseAll(context.Background())) })
		mgr.overviewCache["source"] = &overviewCacheEntry{}
		sub := &overviewSubscriber{allLive: true, queue: make(chan overviewUpdate, 1), stop: make(chan struct{})}
		mgr.overviewSubscribers[1] = sub
		publish := func(id string) Summary {
			snapshot := Summary{DurableSessionID: id}
			mgr.mu.Lock()
			subscribers := mgr.updateOverviewLocked(&snapshot)
			deliverOverview(subscribers, snapshot)
			mgr.mu.Unlock()
			return snapshot
		}

		// Given both histories saw A:X, but a REST read exposed A:Y.
		publish("source")
		store.deleteOwner("source")
		store.setOwner("replacement", "chat-a", "First")
		mgr.mu.Lock()
		mgr.projectOverviewLocked(Summary{DurableSessionID: "replacement"})
		mgr.mu.Unlock()
		for i := 0; i <= maxIdentityTombstones; i++ {
			publish(fmt.Sprintf("owner-filler-%d", i))
		}
		mgr.mu.Lock()
		_, retained := mgr.overviewExposed.Get("chat-a")
		managerSource, managerKnown := mgr.overviewPrevious.ids.Get("source")
		subscriberSource, subscriberKnown := sub.published.ids.Get("source")
		mgr.mu.Unlock()
		if retained || !managerKnown || managerSource != "chat-a" ||
			!subscriberKnown || subscriberSource != "chat-a" {
			t.Fatalf("fixture did not expire exposure while retaining sources: exposed=%t manager=%q subscriber=%q",
				retained, managerSource, subscriberSource)
		}

		// When B claims the resident source, neither publication may remap
		// A without positive evidence that A still exposes that source.
		store.setOwner("source", "chat-b", "Second")
		managerRow := publish("source")
		subscriberRow := (<-sub.queue).summary
		if managerRow.ReplacesSessionID != "" || subscriberRow.ReplacesSessionID != "" {
			t.Fatalf("expired source remapped A: manager=%+v subscriber=%+v", managerRow, subscriberRow)
		}
	})
}
