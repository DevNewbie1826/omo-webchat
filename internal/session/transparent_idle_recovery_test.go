package session

import (
	"context"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc/omorpctest"
)

func TestTransparentIdleRecovery(t *testing.T) {
	t.Run("notified_idle", func(t *testing.T) {
		assertTransparentLifecycleRecovery(t, func(d *omorpctest.Daemon, path string) {
			d.EvictSessionWithEvent(path, "session_closed")
		})
	})
	t.Run("successful_close_response", func(t *testing.T) {
		assertTransparentLifecycleRecovery(t, func(d *omorpctest.Daemon, path string) {
			d.EmitCloseSessionResponse(path, true)
		})
	})
	t.Run("negative_close_response_ignored", func(t *testing.T) {
		d := newDaemon(t)
		client := dial(t, d)
		barrier := make(chan struct{}, 1)
		mgr := NewManager(Config{
			Client: client, Store: newMemStore(), QueueSize: 32,
			OnQueueUpdate: func(string, *Session) { barrier <- struct{}{} },
		})
		t.Cleanup(func() { _ = mgr.CloseAll(context.Background()) })
		chat := testChat{id: "negative-close-response", cwd: t.TempDir()}
		pane := newRecorder(32)
		original, _, detach := acquire(t, mgr, chat, pane)
		defer detach()
		_, _ = pane.await(t, FrameReady)
		_ = pane.drain()
		beforeOpen := d.OpenCount()

		d.EmitCloseSessionResponse(original.SessionFile(), false)
		d.EmitSession(original.SessionFile(), map[string]any{"type": omorpc.EventQueueUpdate, "ordered": []any{}, "pendingMessageCount": 0})
		awaitLifecycleBarrier(t, barrier)

		if original.Resumable() {
			t.Fatal("negative close response marked the route resumable")
		}
		again, started, againDetach := acquire(t, mgr, chat, nil)
		defer againDetach()
		if started || again != original || d.OpenCount() != beforeOpen {
			t.Fatalf("negative response reopened route: started=%v same=%v opens=%d->%d", started, again == original, beforeOpen, d.OpenCount())
		}
	})
}

func assertTransparentLifecycleRecovery(t *testing.T, evict func(*omorpctest.Daemon, string)) {
	t.Helper()
	d := newDaemon(t)
	client := dial(t, d)
	store := newMemStore()
	barrier := make(chan struct{}, 1)
	mgr := NewManager(Config{
		Client: client, Store: store, QueueSize: 32,
		OnQueueUpdate: func(string, *Session) { barrier <- struct{}{} },
	})
	t.Cleanup(func() { _ = mgr.CloseAll(context.Background()) })
	chat := testChat{id: "transparent-lifecycle", cwd: t.TempDir()}
	pane := newRecorder(32)
	original, _, detach := acquire(t, mgr, chat, pane)
	defer detach()
	_, _ = pane.await(t, FrameReady)
	_ = pane.drain()
	beforeOpen := d.OpenCount()
	originalPath := original.SessionFile()
	originalDurable := original.ID()
	originalRoute := original.RoutingID()

	evict(d, originalPath)
	d.EmitSession(originalPath, map[string]any{"type": omorpc.EventQueueUpdate, "ordered": []any{}, "pendingMessageCount": 0})
	awaitLifecycleBarrier(t, barrier)

	if !original.Resumable() {
		t.Fatal("lifecycle record did not mark the route resumable")
	}
	if d.OpenCount() != beforeOpen {
		t.Fatalf("notice eagerly reopened route: opens=%d->%d", beforeOpen, d.OpenCount())
	}
	for _, frame := range pane.drain() {
		if frame.Kind == FrameError || frame.Kind == FrameReady {
			t.Fatalf("silent lifecycle marking published UI frame: %+v", frame)
		}
	}

	replacement, started, replacementDetach := acquire(t, mgr, chat, nil)
	defer replacementDetach()
	if !started || replacement == original {
		t.Fatalf("lazy acquire did not replace route: started=%v same=%v", started, replacement == original)
	}
	if replacement.ID() != originalDurable || replacement.SessionFile() != originalPath || replacement.ChatID() != original.ChatID() {
		t.Fatalf("identity changed: durable=%q path=%q chat=%q", replacement.ID(), replacement.SessionFile(), replacement.ChatID())
	}
	if replacement.cwd != chat.cwd {
		t.Fatalf("cwd changed: got %q want %q", replacement.cwd, chat.cwd)
	}
	if replacement.RoutingID() == originalRoute || d.OpenCount() != beforeOpen+1 {
		t.Fatalf("route was not replaced exactly once: route=%q opens=%d", replacement.RoutingID(), d.OpenCount())
	}
}

func awaitLifecycleBarrier(t *testing.T, barrier <-chan struct{}) {
	t.Helper()
	timer := time.NewTimer(testTimeout)
	defer timer.Stop()
	select {
	case <-barrier:
	case <-timer.C:
		t.Fatal("lifecycle barrier was not observed")
	}
}
