package session

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

type observedDoneContext struct {
	context.Context
	once     sync.Once
	observed chan struct{}
}

func (c *observedDoneContext) Done() <-chan struct{} {
	c.once.Do(func() { close(c.observed) })
	return c.Context.Done()
}

func TestOpenWaitsForPendingOpenThenReacquires(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	mgr := NewManager(Config{Client: client, DetachedOpenLimit: 2})
	t.Cleanup(func() { _ = mgr.CloseAll(context.Background()) })

	const chatID = "retry-pending-open"
	mgr.mu.Lock()
	mgr.pendingOpen[chatID] = make(chan struct{})
	mgr.mu.Unlock()
	mgr.openSlots <- struct{}{}
	t.Cleanup(func() { mgr.clearPendingOpen(chatID) })

	ctx := &observedDoneContext{Context: context.Background(), observed: make(chan struct{})}
	type result struct {
		data omorpc.OpenSessionData
		err  error
	}
	resultCh := make(chan result, 1)
	cwd := t.TempDir()
	go func() {
		data, _, err := mgr.open(ctx, chatID, cwd, "")
		resultCh <- result{data: data, err: err}
	}()

	select {
	case <-ctx.observed:
	case got := <-resultCh:
		t.Fatalf("retry returned before the pending open settled: %v", got.err)
	case <-time.After(testTimeout):
		t.Fatal("retry did not wait on the pending open")
	}

	mgr.clearPendingOpen(chatID)
	select {
	case got := <-resultCh:
		if got.err != nil {
			t.Fatalf("retry after pending open settled: %v", got.err)
		}
		if got.data.SessionID == "" {
			t.Fatal("retry returned an empty routing ID")
		}
		mgr.discardRouting(chatID, got.data.SessionID)
	case <-time.After(testTimeout):
		t.Fatal("retry did not re-acquire after the pending open settled")
	}
}

func TestOpenPendingWaitReturnsWrappedContextError(t *testing.T) {
	mgr := NewManager(Config{DetachedOpenLimit: 2})
	const chatID = "expired-pending-open"
	mgr.mu.Lock()
	mgr.pendingOpen[chatID] = make(chan struct{})
	mgr.mu.Unlock()
	mgr.openSlots <- struct{}{}
	t.Cleanup(func() { mgr.clearPendingOpen(chatID) })

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, _, err := mgr.open(ctx, chatID, t.TempDir(), "")
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("pending-open wait error = %v, want wrapped context cancellation", err)
	}
}
