package session

import (
	"context"
	"fmt"
	"math/rand"
	"testing"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

func TestPR197R13ResidentPromotionPreservesFullHistoryWatermarks(t *testing.T) {
	for _, trigger := range []string{"publication", "rest", "new_resident"} {
		t.Run(trigger, func(t *testing.T) {
			// Given a full non-resident history, each with a high revision,
			// and a full cache of different, lower-revision durables.
			store := newResolvingCursorStore()
			mgr := NewManager(Config{Store: store})
			t.Cleanup(func() { mustOK(t, mgr.CloseAll(context.Background())) })
			ingest := func(id string) Summary {
				_, row, _ := mgr.ingestEpochEvent(omorpc.EpochToken{}, &omorpc.Event{
					Type: "extension_event", SessionID: id,
					Raw: []byte(`{"name":"omo.task.updated","data":{"tasks":[]}}`),
				})
				return row
			}
			want := make(map[string]int64)
			for i := 0; i < maxOverviewCacheEntries; i++ {
				id, chat := fmt.Sprintf("x-%03d", i), fmt.Sprintf("a-%03d", i)
				store.setOwner(id, chat, "Original")
				ingest(id)
				mgr.mu.Lock()
				mgr.overviewCache[id].task.ReceivedAt = "2100-01-01T00:00:00Z"
				mgr.overviewCache[id].liveRevision = liveRevision{}
				row := mgr.projectOverviewLocked(Summary{DurableSessionID: id})
				want[chat] = *row.LiveValues().LastActivityMS
				mgr.mu.Unlock()
			}
			for i := 0; i < maxOverviewCacheEntries; i++ {
				id := fmt.Sprintf("y-%03d", i)
				store.setOwner(id, fmt.Sprintf("b-%03d", i), "Replacement")
				ingest(id)
			}
			if mgr.overviewExposed.HistoryLen() != maxIdentityTombstones {
				t.Fatal("fixture did not fill non-resident exposure history")
			}

			// When every A silently takes ownership of an already cached Y,
			// one projection observes all ownership changes before churn.
			for i := 0; i < maxOverviewCacheEntries; i++ {
				store.deleteOwner(fmt.Sprintf("x-%03d", i))
				store.setOwner(fmt.Sprintf("y-%03d", i), fmt.Sprintf("a-%03d", i), "Replacement")
			}
			switch trigger {
			case "publication":
				ingest("y-000")
			case "rest":
				mgr.LiveSummaries()
			case "new_resident":
				ingest("new-unowned")
			}

			// Then the newly resident entries must be pinned BEFORE history
			// eviction can discard their retained revision high-watermarks.
			rows := mgr.LiveSummaries()
			regressed, lost := 0, 0
			for _, row := range rows {
				if previous, ok := want[row.ChatID]; ok {
					revision := row.LiveValues().LastActivityMS
					if revision == nil || *revision < previous {
						regressed++
						if regressed == 1 {
							t.Logf("FIRST_REGRESSION chat=%s previous=%d current=%v",
								row.ChatID, previous, revisionValueR13(revision))
						}
					}
				}
			}
			mgr.mu.Lock()
			for chat, previous := range want {
				exposure, present := mgr.overviewExposed.Get(chat)
				if !present || exposure.revision < previous {
					lost++
				}
			}
			t.Logf("PROMOTION trigger=%s lost_watermarks=%d regressed_rows=%d pins=%d history=%d",
				trigger, lost, regressed, len(mgr.overviewExposed.pinned), mgr.overviewExposed.HistoryLen())
			mgr.mu.Unlock()
			if lost != 0 || regressed != 0 {
				t.Fatalf("resident promotion lost retained row watermarks: lost=%d regressed=%d", lost, regressed)
			}
		})
	}
}

func revisionValueR13(value *int64) int64 {
	if value == nil {
		return -1
	}
	return *value
}

func TestPR197R13ExposedPinsAdversarialModel(t *testing.T) {
	// Given the existing ownership/residency model, widened beyond its twelve
	// chats so the non-resident history is exercised as well as the cache.
	for _, seed := range []int64{19713, 0, 29} {
		t.Run(fmt.Sprintf("seed_%d", seed), func(t *testing.T) {
			store := newResolvingCursorStore()
			mgr := NewManager(Config{Store: store})
			t.Cleanup(func() { mustOK(t, mgr.CloseAll(context.Background())) })
			rng := rand.New(rand.NewSource(seed))
			owners := make(map[string]string)
			ingest := func(id string) {
				mgr.ingestEpochEvent(omorpc.EpochToken{}, &omorpc.Event{
					Type: "extension_event", SessionID: id,
					Raw: []byte(`{"name":"omo.task.updated","data":{"tasks":[]}}`),
				})
			}
			for step := 0; step < 1800; step++ {
				id := fmt.Sprintf("durable-%03d", rng.Intn(2*maxOverviewCacheEntries))
				if step < 2*maxOverviewCacheEntries {
					id = fmt.Sprintf("durable-%03d", step)
				}
				chat := fmt.Sprintf("chat-%03d", rng.Intn(3*maxIdentityTombstones))
				// When a single chat's cursor changes, release its previous
				// durable, including silent handoffs to an existing resident.
				for durable, owner := range owners {
					if owner == chat {
						store.deleteOwner(durable)
						delete(owners, durable)
					}
				}
				store.setOwner(id, chat, "Title")
				owners[id] = chat
				if step%3 == 0 {
					ingest(id)
				} else if step%3 == 1 {
					ingest(fmt.Sprintf("durable-%03d", rng.Intn(2*maxOverviewCacheEntries)))
				} else {
					mgr.LiveSummaries()
				}
				// Then compare pins with the independent ownership model,
				// never with the implementation's residency predicate.
				mgr.mu.Lock()
				resident := make(map[string]bool)
				for durable := range mgr.overviewCache {
					if owner := owners[durable]; owner != "" {
						resident[owner] = true
					} else if _, known := mgr.overviewOwners.Get(durable); !known {
						resident[durable] = true
					}
				}
				for key := range mgr.overviewExposed.pinned {
					if !resident[key] {
						t.Errorf("seed=%d step=%d obsolete pin=%s", seed, step, key)
					}
				}
				mgr.overviewExposed.Range(func(key string, _ overviewExposure) {
					_, pinned := mgr.overviewExposed.pinned[key]
					if pinned != resident[key] {
						t.Errorf("seed=%d step=%d pin=%t resident=%t chat=%s",
							seed, step, pinned, resident[key], key)
					}
				})
				if mgr.overviewExposed.HistoryLen() > maxIdentityTombstones ||
					mgr.overviewExposed.Len() > maxIdentityTombstones+len(resident) {
					t.Errorf("seed=%d step=%d exposure bounds exceeded", seed, step)
				}
				mgr.mu.Unlock()
				if t.Failed() {
					return
				}
			}
		})
	}
}
