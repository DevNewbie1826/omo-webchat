package session

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

// Exercise both legal gaps in the automatic observer: its goroutine has not
// started, or it is finishing dispatch when the client clears CurrentEpoch.
func TestManagerObservesOwnedEpochAfterDisconnect(t *testing.T) {
	for _, betweenEvents := range []bool{false, true} {
		for _, reconnectFirst := range []bool{false, true} {
			name := "late-start"
			if betweenEvents {
				name = "between-events"
			}
			if reconnectFirst {
				name += "/successor-already-acquired"
			} else {
				name += "/current-zero"
			}
			t.Run(name, func(t *testing.T) {
				d := newDaemon(t)
				client := dial(t, d)
				entered, release := make(chan struct{}), make(chan struct{})
				var releaseOnce sync.Once
				unblock := func() { releaseOnce.Do(func() { close(release) }) }
				// Configure before launching the observer, modeling delayed scheduling
				// without a production test hook or a second event-stream consumer.
				mgr := NewManager(Config{Store: newMemStore(), QueueSize: 64, OnQueueUpdate: func(string, *Session) {
					close(entered)
					<-release
				}})
				mgr.cfg.Client = client
				t.Cleanup(func() {
					unblock()
					if err := mgr.CloseAll(context.Background()); err != nil {
						t.Errorf("close manager: %v", err)
					}
				})
				frames := newRecorder(16)
				s, _, detach := acquire(t, mgr, testChat{id: "deleted-chat", cwd: t.TempDir()}, frames)
				defer detach()
				if frame := frames.next(t); frame.Kind != FrameReady {
					t.Fatalf("initial frame = %+v, want ready", frame)
				}
				oldToken, oldEvents := client.CurrentEpoch()
				if betweenEvents {
					mgr.eventWG.Add(1)
					go mgr.eventLoop()
					d.Emit(map[string]any{"type": "queue_update", "sessionId": s.routingID, "pendingMessageCount": 0})
					select {
					case <-entered:
					case <-time.After(testTimeout):
						t.Fatal("observer did not enter queue dispatch")
					}
				}
				mgr.RetireIdentity(s.chatID)
				mgr.mu.Lock()
				_, mapped := mgr.durableToChat[s.ID()]
				mgr.mu.Unlock()
				if mapped {
					t.Fatal("permanently deleted durable identity remained mapped")
				}
				if live := mgr.LiveSummaries(); len(live) != 0 {
					t.Fatalf("permanently deleted identity remained live: %+v", live)
				}
				d.DropConnections()
				select {
				case _, ok := <-oldEvents:
					if ok {
						t.Fatal("old epoch delivered an unexpected event instead of closing")
					}
				case <-time.After(testTimeout):
					t.Fatal("old epoch did not close")
				}
				if token, _ := client.CurrentEpoch(); token != (omorpc.EpochToken{}) {
					t.Fatal("disconnect did not clear current epoch")
				}
				var successor *Session
				if reconnectFirst {
					var detachSuccessor func()
					successor, _, detachSuccessor = acquire(t, mgr, testChat{id: "successor", cwd: t.TempDir()}, nil)
					defer detachSuccessor()
					if successor.epoch == oldToken {
						t.Fatal("successor reused disconnected epoch")
					}
				}
				if betweenEvents {
					unblock()
				} else {
					mgr.eventWG.Add(1)
					go mgr.eventLoop()
				}
				// This notification must come from the automatic event observer.
				frames.awaitError(t, "provider_disconnected")
				mgr.mu.Lock()
				_, retired := mgr.retiredDurable[s.ID()]
				mgr.mu.Unlock()
				if !retired {
					t.Fatal("epoch invalidation revived permanently deleted durable identity")
				}
				if _, err := client.Call(context.Background(), omorpc.ListSessions{}); err != nil {
					t.Fatalf("reconnect: %v", err)
				}
				// A later wire event must not revive the permanent tombstone. The
				// following distinct event is a FIFO ingestion barrier, not a delay.
				arrived := make(chan Summary, 4)
				unsubscribe := mgr.SubscribeOverview(func(summary Summary) { arrived <- summary })
				defer unsubscribe()
				emitUnboundActivity(d, s.ID(), activitySnapshotOrder[0], map[string]any{"tasks": []any{}})
				emitUnboundActivity(d, "ingestion-barrier", activitySnapshotOrder[0], map[string]any{"tasks": []any{}})
				if got := awaitOverview(t, arrived); got.ChatID != "ingestion-barrier" {
					t.Fatalf("later-epoch deleted identity published overview: %+v", got)
				}
				// The ingestion barrier also joins the entire reconciliation pass;
				// checking immediately after the old session's frame could race a
				// mistaken invalidation of another token later in that same pass.
				if successor != nil {
					successor.lifecycleMu.Lock()
					invalid := successor.closed || successor.resumable
					successor.lifecycleMu.Unlock()
					mgr.mu.Lock()
					routed := mgr.byRoute[successor.routingID] == successor
					mgr.mu.Unlock()
					if invalid || !routed {
						t.Fatal("older disconnect invalidated the current-epoch session")
					}
				}
				for _, live := range mgr.LiveSummaries() {
					if live.ChatID == s.chatID || live.DurableSessionID == s.ID() {
						t.Fatalf("later-epoch deleted identity recreated overview: %+v", live)
					}
				}
			})
		}
	}
}
