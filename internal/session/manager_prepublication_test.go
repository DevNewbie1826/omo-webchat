package session

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

type publicationGatedStore struct {
	*resolvingCursorStore
	persisted chan string
	release   chan struct{}
}

func (s *publicationGatedStore) UpdateIdentity(ctx context.Context, chatID, path, durableID string) error {
	if err := s.memCursorStore.UpdateIdentity(ctx, chatID, path, durableID); err != nil {
		return err
	}
	s.setOwner(durableID, chatID, "Replacement")
	if s.persisted != nil {
		s.persisted <- durableID
		select {
		case <-s.release:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return nil
}

func TestPR197AcquirePreservesPrepublicationActivity(t *testing.T) {
	for _, checked := range []bool{false, true} {
		name := "unchecked"
		if checked {
			name = "checked_initialization"
		}
		t.Run(name, func(t *testing.T) {
			d := newDaemon(t)
			client := dial(t, d)
			store := &publicationGatedStore{resolvingCursorStore: newResolvingCursorStore()}
			mgr := testManager(t, client, store, 64)
			chat := testChat{id: "replacement-chat", cwd: t.TempDir()}
			old, _, detach := acquire(t, mgr, chat, nil)
			defer detach()
			_, oldEvents := client.CurrentEpoch()
			mgr.invalidateEpoch(old.epoch)
			d.DropConnections()
			select {
			case <-oldEvents:
			case <-time.After(testTimeout):
				t.Fatal("old epoch did not close")
			}
			if _, err := client.Call(context.Background(), omorpc.ListSessions{}); err != nil {
				t.Fatal(err)
			}
			mustOK(t, store.SaveCursor(context.Background(), chat.id, Cursor{Name: "Replacement"}))
			store.deleteOwner(old.ID())

			entered := make(chan string, 1)
			release := make(chan struct{})
			unblock := sync.OnceFunc(func() { close(release) })
			defer unblock()
			if !checked {
				store.persisted, store.release = entered, release
			}
			type result struct {
				session *Session
				detach  func()
				err     error
			}
			done := make(chan result, 1)
			go func() {
				var got result
				if checked {
					got.session, _, got.detach, got.err = mgr.AcquireInitializedChecked(context.Background(), chat, nil,
						func(s *Session, _ bool, _ func()) {
							entered <- s.ID()
							<-release
						}, func() error { return nil })
				} else {
					got.session, _, got.detach, got.err = mgr.Acquire(context.Background(), chat, nil)
				}
				done <- got
			}()
			var durableID string
			select {
			case durableID = <-entered:
			case <-time.After(testTimeout):
				t.Fatal("replacement did not reach prepublication gate")
			}
			if durableID == old.ID() {
				t.Fatal("test did not replace durable identity")
			}
			barrier := make(chan Summary, 1)
			_, unsubscribe := mgr.SubscribeActivity(false, []string{"ingestion-barrier"}, func(s Summary, _ bool) { barrier <- s })
			defer unsubscribe()
			emitUnboundActivity(d, durableID, activitySnapshotOrder[0], map[string]any{
				"tasks": []any{map[string]any{"task_id": "before-publication", "status": "running"}},
			})
			emitUnboundActivity(d, "ingestion-barrier", activitySnapshotOrder[0], map[string]any{"tasks": []any{}})
			_ = awaitOverview(t, barrier)
			mgr.mu.Lock()
			pending := mgr.overviewCache[durableID] != nil
			_, retired := mgr.retiredDurable[durableID]
			retained := mgr.byChat[chat.id] == old
			mgr.mu.Unlock()
			unblock()
			var got result
			select {
			case got = <-done:
			case <-time.After(testTimeout):
				t.Fatal("replacement acquisition did not finish")
			}
			if got.detach != nil {
				defer got.detach()
			}
			mustOK(t, got.err)
			if !retained {
				t.Fatal("test gate was after publication")
			}
			summary, ok := got.session.summary()
			if !pending || retired || !ok || summary.TaskDigest == nil || len(summary.TaskDigest.Tasks) != 1 {
				t.Errorf("prepublication activity lost: cached=%v retired=%v summary=%+v", pending, retired, summary)
			}
			initial, stop := mgr.SubscribeActivity(false, []string{chat.id}, func(Summary, bool) {})
			stop()
			if len(initial) != 1 || initial[0].DurableSessionID != durableID || initial[0].TaskDigest == nil || len(initial[0].TaskDigest.Tasks) != 1 {
				t.Fatalf("replacement WS initial rows = %+v", initial)
			}
		})
	}
}
