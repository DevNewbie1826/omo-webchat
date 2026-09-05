package session

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc/omorpctest"
)

func TestManagerObservesReusedRouteEpoch(t *testing.T) {
	for _, betweenEvents := range []bool{false, true} {
		for _, secondOldRoute := range []bool{false, true} {
			name := "late-start"
			if betweenEvents {
				name = "between-events"
			}
			if secondOldRoute {
				name += "/discoverable-old-epoch"
			} else {
				name += "/hidden-old-epoch"
			}
			t.Run(name, func(t *testing.T) {
				d := newDaemon(t)
				client := dial(t, d)
				entered, release := make(chan struct{}), make(chan struct{})
				var once sync.Once
				unblock := func() { once.Do(func() { close(release) }) }
				// Resume A from a distinct durable file: the fixture's fresh-ID
				// counter also resets on restart, but only route reuse is intended.
				store := newMemStore()
				oldPath := filepath.Join(t.TempDir(), "old.jsonl")
				if err := os.WriteFile(oldPath, []byte("{\"type\":\"session\",\"version\":3}\n"), 0600); err != nil {
					t.Fatal(err)
				}
				store.cursors["deleted-old"] = Cursor{SessionFile: oldPath}
				mgr := NewManager(Config{Store: store, QueueSize: 64, OnQueueUpdate: func(string, *Session) {
					close(entered)
					<-release
				}})
				mgr.cfg.Client = client
				// Registered before manager cleanup so the successor stays available
				// until CloseAll has joined the observer and closed current routes.
				replacement := omorpctest.New(filepath.Dir(d.SocketPath()))
				t.Cleanup(replacement.Stop)
				t.Cleanup(func() {
					unblock()
					if err := mgr.CloseAll(context.Background()); err != nil {
						t.Errorf("close manager: %v", err)
					}
				})
				frames := newRecorder(16)
				old, _, detach := acquire(t, mgr, testChat{id: "deleted-old", cwd: t.TempDir()}, frames)
				defer detach()
				if got := frames.next(t); got.Kind != FrameReady {
					t.Fatalf("initial frame = %+v", got)
				}
				if secondOldRoute {
					_, _, detachOther := acquire(t, mgr, testChat{id: "other-old", cwd: t.TempDir()}, nil)
					defer detachOther()
				}
				oldToken, oldEvents := client.CurrentEpoch()
				if betweenEvents {
					mgr.eventWG.Add(1)
					go mgr.eventLoop()
					d.Emit(map[string]any{"type": "queue_update", "sessionId": old.routingID, "pendingMessageCount": 0})
					select {
					case <-entered:
					case <-time.After(testTimeout):
						t.Fatal("observer did not enter dispatch")
					}
				}
				mgr.RetireIdentity(old.chatID)
				d.Stop()
				select {
				case _, ok := <-oldEvents:
					if ok {
						t.Fatal("unexpected old event")
					}
				case <-time.After(testTimeout):
					t.Fatal("old epoch did not close")
				}
				if err := replacement.Start(); err != nil {
					t.Fatalf("restart daemon: %v", err)
				}
				currentFrames := newRecorder(16)
				current, _, detachCurrent := acquire(t, mgr, testChat{id: "current", cwd: t.TempDir()}, currentFrames)
				defer detachCurrent()
				if got := currentFrames.next(t); got.Kind != FrameReady {
					t.Fatalf("current initial frame = %+v", got)
				}
				if current.epoch == oldToken || current.routingID != old.routingID || current.ID() == old.ID() {
					t.Fatal("restart must reuse the route on a distinct epoch")
				}
				mgr.mu.Lock()
				retained := mgr.byChat[old.chatID] == old && mgr.byRoute[old.routingID] == current
				cacheCount := len(mgr.overviewCache)
				mgr.mu.Unlock()
				if !retained || cacheCount != 0 {
					t.Fatal("fixture must retain old chat behind overwritten route without a cache")
				}
				arrived := make(chan Summary, 8)
				unsubscribe := mgr.SubscribeOverview(func(summary Summary) { arrived <- summary })
				defer unsubscribe()
				if betweenEvents {
					unblock()
				} else {
					mgr.eventWG.Add(1)
					go mgr.eventLoop()
				}
				// Join reconciliation via real FIFO ingestion before inspecting state.
				emitUnboundActivity(replacement, old.ID(), activitySnapshotOrder[0], map[string]any{"tasks": []any{}})
				emitUnboundActivity(replacement, "reuse-barrier", activitySnapshotOrder[0], map[string]any{"tasks": []any{}})
				if got := awaitOverview(t, arrived); got.ChatID != "reuse-barrier" {
					t.Fatalf("deleted identity escaped tombstone: %+v", got)
				}
				// State after the barrier gives a deterministic RED without waiting
				// for a notification that the buggy observer can never publish.
				old.lifecycleMu.Lock()
				resumable := old.resumable
				old.lifecycleMu.Unlock()
				if !resumable {
					t.Fatal("hidden old owner was not automatically invalidated")
				}
				frames.awaitError(t, "provider_disconnected")
				mgr.mu.Lock()
				routed := mgr.byRoute[current.routingID] == current
				_, retired := mgr.retiredDurable[old.ID()]
				_, mapped := mgr.durableToChat[old.ID()]
				mgr.mu.Unlock()
				if !routed {
					t.Fatal("old epoch invalidation removed current owner's reused route")
				}
				if !retired || mapped {
					t.Fatal("permanent retirement was lost")
				}
				if err := current.acquisitionError(); err != nil {
					t.Fatalf("current session unavailable: %v", err)
				}
				replacement.Emit(map[string]any{"type": "message_delta", "sessionId": current.routingID, "delta": "current-route-proof"})
				if got := currentFrames.next(t); got.Kind != FrameMessageDelta || got.SessionID != current.ID() {
					t.Fatalf("current routed event = %+v", got)
				}
				// Reconciliation must not repeatedly detach retained resumable
				// sessions after observeEpoch has pruned its transient barrier.
				mgr.observeEpoch(current.epoch)
				mgr.invalidateDisconnectedEpochs()
				mgr.mu.Lock()
				_, churn := mgr.invalidatedEpochs[oldToken]
				mgr.mu.Unlock()
				if churn {
					t.Fatal("already-resumable ownership reintroduced invalidation barrier")
				}
				if !errors.Is(old.acquisitionError(), ErrSessionResumable) {
					t.Fatal("old session did not retain resumable state")
				}
			})
		}
	}
}
