package session

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

type enrolledIdentityErrorStore struct{ *memCursorStore }

func (s enrolledIdentityErrorStore) UpdateIdentity(context.Context, string, string, string) error {
	return errors.New("identity persistence rejected")
}

func TestEnrolledAttachLifecycle(t *testing.T) {
	t.Run("rapid_reopen", func(t *testing.T) {
		h := newEnrolledHarness(t)
		for i := 0; i < 4; i++ {
			s, r, detach := h.attach()
			h.stream(r, "rapid-live")
			detach()
			mustOK(t, s.Close())
			h.assertDetached()
		}
	})

	t.Run("multi_viewer_single_attachment", func(t *testing.T) {
		h := newEnrolledHarness(t)
		first, r, releaseFirst := h.attach()
		before := h.d.RequestCount(omorpc.CmdOpenSession)
		secondRecorder := newRecorder(64)
		second, created, releaseSecond, err := h.m.Acquire(t.Context(), h.chat, secondRecorder)
		mustOK(t, err)
		defer releaseSecond()
		if created || second != first || h.d.Attachments(h.opened.State.SessionFile) != 2 ||
			h.d.RequestCount(omorpc.CmdOpenSession) != before {
			t.Fatal("two viewers acquired more than one dedicated attachment")
		}
		h.stream(r, "two-viewers")
		_, frame := secondRecorder.await(t, FrameMessageDelta)
		if frame.Data.(map[string]any)["delta"] != "two-viewers" {
			t.Fatal("second viewer did not stream from the shared attachment")
		}
		releaseFirst()
		releaseSecond()
		mustOK(t, h.m.StopContext(t.Context(), h.chat.id))
		h.assertDetached()
	})

	t.Run("dedicated_drop_reattach", func(t *testing.T) {
		h := newEnrolledHarness(t)
		stale, r, detach := h.attach()
		oldEpoch := stale.epoch
		// Closing the transport directly (not releaseAttach) simulates EOF.
		mustOK(t, stale.client.Close())
		select {
		case <-stale.attachStop:
		case <-time.After(testTimeout):
			t.Fatal("dedicated drop did not stop its attachment pump")
		}
		if !stale.Resumable() {
			t.Fatal("dedicated drop did not make the chat resumable")
		}
		r.awaitError(t, "provider_disconnected")
		h.assertDetached()
		fresh, freshRecorder, freshDetach := h.attach()
		defer freshDetach()
		if fresh == stale || fresh.epoch == oldEpoch || fresh.routingID != stale.routingID {
			t.Fatal("drop did not reattach under a new epoch to the SAME external route")
		}
		// A delayed old pump's invalidation must not remove the newer same-route binding.
		h.m.invalidateEpoch(oldEpoch)
		if fresh.Resumable() || !h.m.epochCurrent(fresh.epoch) {
			t.Fatal("stale loss invalidated the newer dedicated binding")
		}
		h.stream(freshRecorder, "after-dedicated-drop")
		detach()
		freshDetach()
		mustOK(t, fresh.Close())
		h.assertDetached()
	})

	t.Run("epoch_resolver_keeps_live", func(t *testing.T) {
		h := newEnrolledHarness(t)
		s, r, detach := h.attach()
		h.m.invalidateDisconnectedEpochs()
		h.m.scheduleSessionReconciliation()
		if s.Resumable() || !h.m.epochCurrent(s.epoch) || h.main.EpochCurrent(s.epoch) {
			t.Fatal("main epoch gates invalidated a live dedicated route")
		}
		ran := false
		reused, created, release, err := h.m.acquire(
			t.Context(), h.chat, nil, nil, func() error { return nil }, nil,
			func(got *Session) error {
				ran = true
				if got != s {
					return errors.New("revalidateMutation replaced live dedicated session")
				}
				return nil
			}, false, true, false)
		mustOK(t, err)
		defer release()
		if created || reused != s || !ran || h.d.Attachments(s.sessionFile) != 2 {
			t.Fatal("reacquire/revalidateMutation did not preserve the dedicated route")
		}
		h.stream(r, "epoch-live")
		detach()
		mustOK(t, s.Close())
		h.assertDetached()
	})

	t.Run("main_reconnect_keeps_stream", func(t *testing.T) {
		h := newEnrolledHarness(t)
		// Route only main through a droppable wire proxy, leaving owner and C untouched.
		mustOK(t, h.m.CloseAll(t.Context()))
		p := newEnrolledWireProxy(t, h.d.SocketPath(), nil)
		main, err := omorpc.DialWithConfig(t.Context(), p.path, omorpc.Config{EventBuffer: 256})
		mustOK(t, err)
		t.Cleanup(func() { _ = main.Close() })
		h.main = main
		h.m = NewManager(Config{Client: main, Store: h.store, QueueSize: 64, DialAttach: func(ctx context.Context) (*omorpc.Client, error) {
			return omorpc.DialWithConfig(ctx, h.d.SocketPath(), omorpc.Config{NoReconnect: true, EventBuffer: 1024})
		}})
		t.Cleanup(func() { _ = h.m.CloseAll(context.Background()) })
		s, r, detach := h.attach()
		oldMain, stream := main.CurrentEpoch()
		before := h.d.RequestCount(omorpc.CmdOpenSession)
		p.dropFirst()
		awaitStreamClosed(t, stream)
		mustOK(t, main.EnsureConnected(t.Context()))
		newMain, _ := main.CurrentEpoch()
		if newMain == oldMain {
			t.Fatal("main did not establish a successor epoch")
		}
		h.m.invalidateDisconnectedEpochs()
		h.m.scheduleSessionReconciliation()
		if s.Resumable() || h.d.RequestCount(omorpc.CmdOpenSession) != before || h.d.Attachments(s.sessionFile) != 2 {
			t.Fatal("main reconnect dropped or reopened a live dedicated session")
		}
		h.stream(r, "after-main-reconnect")
		detach()
		mustOK(t, s.Close())
		h.assertDetached()
	})

	t.Run("drop_before_publish_no_leak", func(t *testing.T) {
		h := newEnrolledHarness(t)
		cur := h.store.stored(h.chat.id)
		cur.DurableSessionID = "" // Forces UpdateIdentity after accepted attach.
		mustOK(t, h.store.SaveCursor(t.Context(), h.chat.id, cur))
		h.m.cfg.Store = enrolledIdentityErrorStore{h.store}
		dialAttach := h.m.cfg.DialAttach
		h.m.cfg.DialAttach = func(ctx context.Context) (*omorpc.Client, error) {
			c, err := dialAttach(ctx)
			if c != nil {
				t.Cleanup(func() { _ = c.Close() })
			}
			return c, err
		}
		_, _, _, err := h.m.Acquire(t.Context(), h.chat, nil)
		if err == nil {
			t.Fatal("fixture did not reject identity publication")
		}
		h.assertDetached()
	})

	t.Run("retire_replaced_no_leak", func(t *testing.T) {
		h := newEnrolledHarness(t)
		s, _, detach := h.attach()
		detach()
		s.retireReplaced()
		h.assertDetached()
	})

	t.Run("closing_reopen_attached_false", func(t *testing.T) {
		h := newEnrolledHarness(t)
		dialAttach := h.m.cfg.DialAttach
		var once sync.Once
		h.m.cfg.DialAttach = func(ctx context.Context) (*omorpc.Client, error) {
			// Explicit release between discovery and dedicated open: host's reply
			// is attached:false, so the new opener must NOT be adopted as an attach.
			once.Do(func() {
				_, err := h.owner.Call(ctx, omorpc.CloseSession{SessionID: h.opened.SessionID})
				mustOK(t, err)
			})
			return dialAttach(ctx)
		}
		before := h.d.RequestCount(omorpc.CmdOpenSession)
		s, _, detach, err := h.m.Acquire(t.Context(), h.chat, nil)
		mustOK(t, err)
		defer detach()
		if s.client != h.main || s.attachClient != nil || h.d.RequestCount(omorpc.CmdOpenSession)-before != 2 {
			t.Fatal("attached:false accepted as dedicated or failed to fall back exactly once")
		}
		if s.ID() != h.opened.State.SessionID {
			t.Fatal("attached:false fallback changed durable identity")
		}
		// Owner's explicit end is the only close in this scenario.
		mustOK(t, h.m.StopContext(t.Context(), h.chat.id))
		if h.d.RequestCount(omorpc.CmdCloseSession) != 1 {
			t.Fatal("webchat explicitly closed an attached:false fallback residual")
		}
		mustOK(t, h.main.Close())
		if !h.d.AwaitAttachments(s.sessionFile, 0, testTimeout) {
			t.Fatal("attached:false fallback retained a dedicated attachment")
		}
	})

	for _, cancelSecond := range []bool{false, true} {
		name := "concurrent_acquires"
		if cancelSecond {
			name += "_cancel"
		}
		t.Run(name, func(t *testing.T) {
			h := newEnrolledHarness(t)
			entered, release := make(chan struct{}), make(chan struct{})
			unblock := sync.OnceFunc(func() { close(release) })
			defer unblock()
			firstDone, secondDone := make(chan enrolledAcquireResult, 1), make(chan enrolledAcquireResult, 1)
			go func() {
				s, _, detach, err := h.m.AcquireInitializedChecked(t.Context(), h.chat, nil,
					func(*Session, bool, func()) { close(entered); <-release }, func() error { return nil })
				firstDone <- enrolledAcquireResult{s: s, detach: detach, err: err}
			}()
			select {
			case <-entered:
			case <-time.After(testTimeout):
				t.Fatal("first Acquire did not reach prepublication barrier")
			}
			// Subscribe to actual enqueue, not WithCancel's parent Done lookup.
			queued := make(chan struct{})
			h.m.chats.mu.Lock()
			h.m.chats.onQueued = func(string) { close(queued) }
			h.m.chats.mu.Unlock()
			t.Cleanup(func() {
				h.m.chats.mu.Lock()
				h.m.chats.onQueued = nil
				h.m.chats.mu.Unlock()
			})
			secondContext, cancel := context.WithCancel(t.Context())
			defer cancel()
			go func() {
				s, _, detach, err := h.m.Acquire(secondContext, h.chat, nil)
				secondDone <- enrolledAcquireResult{s: s, detach: detach, err: err}
			}()
			select {
			case <-queued:
			case <-time.After(testTimeout):
				t.Fatal("second direct Acquire did not enqueue while first was held")
			}
			h.m.chats.mu.Lock()
			h.m.chats.onQueued = nil
			flight := h.m.chats.flights[h.chat.id]
			waiting := flight != nil && flight.owned && len(flight.waiters) == 1 && !flight.waiters[0].granted
			h.m.chats.mu.Unlock()
			if !waiting || h.d.RequestCount(omorpc.CmdOpenSession) != 2 ||
				h.d.Attachments(h.opened.State.SessionFile) != 2 {
				t.Fatal("second direct Acquire did not wait behind the unpublished first attachment")
			}
			if cancelSecond {
				cancel()
				second := awaitEnrolledAcquire(t, secondDone)
				if !errors.Is(second.err, context.Canceled) {
					t.Fatalf("queued second Acquire cancellation=%v", second.err)
				}
				h.m.chats.mu.Lock()
				remaining := len(flight.waiters)
				h.m.chats.mu.Unlock()
				if remaining != 0 {
					t.Fatal("canceled second Acquire remained in the FIFO")
				}
				unblock()
				first := awaitEnrolledAcquire(t, firstDone)
				mustOK(t, first.err)
				mustOK(t, first.s.Close())
				h.assertDetached()
				return
			}
			unblock()
			first, second := awaitEnrolledAcquire(t, firstDone), awaitEnrolledAcquire(t, secondDone)
			mustOK(t, first.err)
			mustOK(t, second.err)
			if first.s != second.s || h.d.Attachments(h.opened.State.SessionFile) != 2 ||
				h.d.RequestCount(omorpc.CmdOpenSession) != 2 {
				t.Fatal("concurrent same-chat acquisitions did not share one dedicated connection")
			}
			mustOK(t, first.s.Close())
			h.assertDetached()
		})
	}

	t.Run("stale_late_result", func(t *testing.T) {
		h := newEnrolledHarness(t)
		entered, release := make(chan struct{}), make(chan struct{})
		unblock := sync.OnceFunc(func() { close(release) })
		defer unblock()
		var calls atomic.Int32
		done := make(chan enrolledAcquireResult, 1)
		go func() {
			s, _, detach, err := h.m.AcquireInitializedChecked(t.Context(), h.chat, nil, func(*Session, bool, func()) {
				close(entered)
				<-release
			}, func() error {
				calls.Add(1)
				return nil
			})
			done <- enrolledAcquireResult{s: s, detach: detach, err: err}
		}()
		select {
		case <-entered:
		case <-time.After(testTimeout):
			t.Fatal("late attach did not reach unpublished barrier")
		}
		h.m.mu.Lock()
		h.m.bumpSlotGenerationLocked(h.chat.id) // newer metadata generation wins
		h.m.mu.Unlock()
		unblock()
		got := awaitEnrolledAcquire(t, done)
		if !errors.Is(got.err, ErrManagerClosed) || calls.Load() < 2 {
			t.Fatalf("stale result published past newer generation: %v", got.err)
		}
		h.assertDetached()
		fresh, r, detach := h.attach()
		h.stream(r, "after-stale-result")
		detach()
		mustOK(t, fresh.Close())
		h.assertDetached()
	})
}

func TestEnrolledAttachLifecycleResidualPruned(t *testing.T) {
	for _, action := range []string{"session_closed", "epoch_invalidated", "foreign_epoch", "foreign_source", "unrelated_route", "session_unloaded"} {
		t.Run(action, func(t *testing.T) {
			h := newEnrolledHarness(t)
			epoch, stream := h.main.CurrentEpoch()
			foreignEpoch, _ := h.owner.CurrentEpoch()
			route := h.opened.SessionID
			target := retiringRoute{route: route, epoch: epoch}
			sibling := retiringRoute{route: "other-residual", epoch: epoch}
			foreign := retiringRoute{route: route, epoch: foreignEpoch}
			h.m.mu.Lock()
			for _, key := range []retiringRoute{target, sibling, foreign} {
				h.m.mainAttachedResiduals[key] = struct{}{}
			}
			h.m.mu.Unlock()

			client, token, eventRoute, eventType := h.main, epoch, route, "session_closed"
			switch action {
			case "epoch_invalidated":
				mustOK(t, h.main.Close())
				awaitStreamClosed(t, stream)
				h.m.invalidateEpoch(epoch)
			case "foreign_epoch":
				token = foreignEpoch
			case "foreign_source":
				client, token = h.owner, foreignEpoch
			case "unrelated_route":
				eventRoute = "unrelated-route"
			case "session_unloaded":
				eventType = "session_unloaded"
			}
			if action != "epoch_invalidated" {
				raw, err := json.Marshal(map[string]any{"type": eventType, "sessionId": eventRoute})
				mustOK(t, err)
				h.m.ingestClientEvent(client, token, &omorpc.Event{Type: eventType, SessionID: eventRoute, Raw: raw})
			}

			h.m.mu.Lock()
			_, targetPresent := h.m.mainAttachedResiduals[target]
			_, siblingPresent := h.m.mainAttachedResiduals[sibling]
			_, foreignPresent := h.m.mainAttachedResiduals[foreign]
			h.m.mu.Unlock()
			wantTarget := action != "session_closed" && action != "epoch_invalidated"
			wantSibling := action != "epoch_invalidated"
			if targetPresent != wantTarget || siblingPresent != wantSibling || !foreignPresent {
				t.Fatalf("%s residuals: target=%v sibling=%v foreign=%v, want %v/%v/true",
					action, targetPresent, siblingPresent, foreignPresent, wantTarget, wantSibling)
			}
			t.Logf("%s: target=%v sibling=%v foreign=%v", action, targetPresent, siblingPresent, foreignPresent)
		})
	}
}

func TestEnrolledAttachLifecycleMainDuplicateIngestion(t *testing.T) {
	h := newEnrolledHarness(t)
	s, r, detach := h.attach()
	raw, err := json.Marshal(map[string]any{
		"type": "extension_event", "sessionId": s.routingID,
		"name": "omo.task.updated", "data": map[string]any{"parent_session_id": s.ID(), "tasks": []any{map[string]any{"task_id": "dedicated-only", "status": "running"}}},
	})
	mustOK(t, err)
	mainEpoch, _ := h.main.CurrentEpoch()
	h.m.ingestClientEvent(h.main, mainEpoch, &omorpc.Event{Type: "extension_event", SessionID: s.routingID, Raw: raw})
	h.m.mu.Lock()
	duplicate := h.m.overviewCache[s.ID()] != nil || h.m.overviewCache[s.routingID] != nil
	h.m.mu.Unlock()
	if duplicate {
		t.Fatal("main ingested a dedicated route event into duplicate overview authority")
	}
	h.d.EmitSession(s.sessionFile, map[string]any{"type": "extension_event", "name": "omo.task.updated",
		"data": map[string]any{"parent_session_id": s.ID(), "tasks": []any{map[string]any{"task_id": "dedicated-only", "status": "running"}}}})
	r.await(t, FrameExtensionEvent)
	summary, ok := s.summary()
	if !ok || summary.TaskDigest == nil || len(summary.TaskDigest.Tasks) != 1 {
		t.Fatal("dedicated pump did not run the normal activity ingestion")
	}
	detach()
	mustOK(t, s.Close())
	h.assertDetached()
}
