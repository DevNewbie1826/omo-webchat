package session

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc/omorpctest"
)

func TestManagerReacquirePreservesReusedRoute(t *testing.T) {
	for _, checked := range []bool{false, true} {
		name := "ordinary"
		if checked {
			name = "checked"
		}
		t.Run(name, func(t *testing.T) {
			d := newDaemon(t)
			client := dial(t, d)
			store := newMemStore()
			oldPath := filepath.Join(t.TempDir(), "old.jsonl")
			if err := os.WriteFile(oldPath, []byte("{\"type\":\"session\",\"version\":3}\n"), 0600); err != nil {
				t.Fatal(err)
			}
			chat := testChat{id: "retained-old", cwd: t.TempDir()}
			store.cursors[chat.id] = Cursor{SessionFile: oldPath}
			// Delay only the observer, not acquisition or the disconnect protocol,
			// so B deterministically publishes its reused route before reconciliation.
			mgr := NewManager(Config{Store: store, QueueSize: 64})
			mgr.cfg.Client = client
			replacement := omorpctest.New(filepath.Dir(d.SocketPath()))
			t.Cleanup(replacement.Stop)
			t.Cleanup(func() {
				if err := mgr.CloseAll(context.Background()); err != nil {
					t.Errorf("close manager: %v", err)
				}
			})
			frames := newRecorder(16)
			old, _, detach := acquire(t, mgr, chat, frames)
			defer detach()
			if got := frames.next(t); got.Kind != FrameReady || !got.Resumed {
				t.Fatalf("old initial frame = %+v", got)
			}
			oldToken, oldEvents := client.CurrentEpoch()
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
				t.Fatal("restart must reuse only the route, on a distinct epoch")
			}
			arrived := make(chan Summary, 8)
			unsubscribe := mgr.SubscribeOverview(func(summary Summary) { arrived <- summary })
			defer unsubscribe()
			mgr.eventWG.Add(1)
			go mgr.eventLoop()
			emitUnboundActivity(replacement, "invalidation-barrier", activitySnapshotOrder[0], map[string]any{"tasks": []any{}})
			if got := awaitOverview(t, arrived); got.ChatID != "invalidation-barrier" {
				t.Fatalf("invalidation barrier = %+v", got)
			}
			if !errors.Is(old.acquisitionError(), ErrSessionResumable) {
				t.Fatal("old owner was not automatically made resumable")
			}
			frames.awaitError(t, "provider_disconnected")
			mgr.mu.Lock()
			retained := mgr.byChat[old.chatID] == old && mgr.byRoute[current.routingID] == current
			_, deleted := mgr.retiredDurable[old.ID()]
			mgr.mu.Unlock()
			if !retained || deleted {
				t.Fatal("automatic invalidation must retain nondeleted A and B's route")
			}

			reopenedFrames := newRecorder(16)
			var reopened *Session
			var started bool
			var detachReopened func()
			var err error
			if checked {
				reopened, started, detachReopened, err = mgr.AcquireInitializedChecked(context.Background(), chat, reopenedFrames, nil, func() error { return nil })
			} else {
				reopened, started, detachReopened, err = mgr.Acquire(context.Background(), chat, reopenedFrames)
			}
			if err != nil {
				t.Fatalf("reacquire: %v", err)
			}
			defer detachReopened()
			if !started || reopened == old || reopened.epoch != current.epoch || reopened.routingID == current.routingID || reopened.ID() != old.ID() {
				t.Fatal("A must reopen its durable identity on E2 with a new route")
			}
			if got := reopenedFrames.next(t); got.Kind != FrameReady || !got.Resumed {
				t.Fatalf("reopened initial frame = %+v", got)
			}
			// Join actual wire ingestion after publication; map/lifecycle checks
			// alone would miss a session that remains available but loses events.
			replacement.Emit(map[string]any{"type": "message_delta", "sessionId": current.routingID, "delta": "reacquire-route-proof"})
			emitUnboundActivity(replacement, "reacquire-barrier", activitySnapshotOrder[0], map[string]any{"tasks": []any{}})
			if got := awaitOverview(t, arrived); got.ChatID != "reacquire-barrier" {
				t.Fatalf("reacquire barrier = %+v", got)
			}
			mgr.mu.Lock()
			routed := mgr.byRoute[current.routingID] == current && mgr.byChat[current.chatID] == current
			reopenedRouted := mgr.byRoute[reopened.routingID] == reopened && mgr.byChat[chat.id] == reopened
			mgr.mu.Unlock()
			if !routed {
				t.Fatal("reacquiring A removed B's reused route")
			}
			if !reopenedRouted {
				t.Fatal("reopened A was not published")
			}
			if err := current.acquisitionError(); err != nil {
				t.Fatalf("B unavailable after reacquisition: %v", err)
			}
			if got := currentFrames.next(t); got.Kind != FrameMessageDelta || got.SessionID != current.ID() {
				t.Fatalf("B routed event = %+v", got)
			}
			// Closing the retired holder and its replacement must not close B.
			mustOK(t, old.Close())
			mustOK(t, reopened.Close())
			mgr.mu.Lock()
			routed = mgr.byRoute[current.routingID] == current
			mgr.mu.Unlock()
			if !routed {
				t.Fatal("closing A removed B's route")
			}
			mustOK(t, current.acquisitionError())
		})
	}
}
