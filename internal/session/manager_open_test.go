package session

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc/omorpctest"
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
		data  omorpc.OpenSessionData
		epoch omorpc.EpochToken
		err   error
	}
	resultCh := make(chan result, 1)
	cwd := t.TempDir()
	go func() {
		data, epoch, err := mgr.open(ctx, chatID, cwd, "")
		resultCh <- result{data: data, epoch: epoch, err: err}
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
		mgr.discardRouting(chatID, got.data.SessionID, got.epoch)
	case <-time.After(testTimeout):
		t.Fatal("retry did not re-acquire after the pending open settled")
	}
}

func TestOpenCompletionReleasesSlotBeforeWakingWaiter(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	mgr := NewManager(Config{Client: client, DetachedOpenLimit: 2})
	t.Cleanup(func() { _ = mgr.CloseAll(context.Background()) })

	const chatID = "completion-slot-order"
	mgr.mu.Lock()
	mgr.pendingOpen[chatID] = make(chan struct{})
	mgr.mu.Unlock()
	mgr.openSlots <- struct{}{} // owner

	ctx := &observedDoneContext{Context: context.Background(), observed: make(chan struct{})}
	result := make(chan error, 1)
	var opened omorpc.OpenSessionData
	var openedEpoch omorpc.EpochToken
	go func() {
		var err error
		opened, openedEpoch, err = mgr.open(ctx, chatID, t.TempDir(), "")
		result <- err
	}()
	select {
	case <-ctx.observed:
	case <-time.After(testTimeout):
		t.Fatal("waiter did not reach pending-open completion wait")
	}

	// Occupy the slot the waiter released before sleeping. Completion must
	// release the owner's slot before notifying the waiter, or the waiter can
	// observe both slots occupied and report ErrOpenBusy.
	mgr.openSlots <- struct{}{}
	mgr.clearPendingOpen(chatID)
	select {
	case err := <-result:
		if err != nil {
			t.Fatalf("waiter after owner completion: %v", err)
		}
	case <-time.After(testTimeout):
		t.Fatal("waiter did not open after owner completion")
	}
	<-mgr.openSlots // unrelated occupied slot
	mgr.discardRouting(chatID, opened.SessionID, openedEpoch)
}

func TestLateOpenCleanupDropsDeadEpochCollidingRoute(t *testing.T) {
	root, err := os.MkdirTemp("", "sess-epoch-")
	if err != nil {
		t.Fatalf("temporary daemon directory: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	oldDaemon := omorpctest.New(root)
	if err := oldDaemon.Start(); err != nil {
		t.Fatalf("start old daemon: %v", err)
	}
	client := dial(t, oldDaemon)
	oldEpoch, oldEvents := client.CurrentEpoch()
	oldResp, err := client.Call(context.Background(), omorpc.OpenSession{CWD: t.TempDir()})
	if err != nil {
		t.Fatalf("open on old epoch: %v", err)
	}
	var oldOpen omorpc.OpenSessionData
	if err := json.Unmarshal(oldResp.Data, &oldOpen); err != nil {
		t.Fatalf("decode old open: %v", err)
	}

	oldDaemon.Stop()
	select {
	case <-oldEvents:
	case <-time.After(testTimeout):
		t.Fatal("old epoch did not close")
	}
	newDaemon := omorpctest.New(root)
	if err := newDaemon.Start(); err != nil {
		t.Fatalf("start replacement daemon: %v", err)
	}
	t.Cleanup(newDaemon.Stop)

	newResp, err := client.Call(context.Background(), omorpc.OpenSession{CWD: t.TempDir()})
	if err != nil {
		t.Fatalf("open on replacement epoch: %v", err)
	}
	var replacement omorpc.OpenSessionData
	if err := json.Unmarshal(newResp.Data, &replacement); err != nil {
		t.Fatalf("decode replacement open: %v", err)
	}
	if replacement.SessionID != oldOpen.SessionID {
		t.Fatalf("routing IDs did not collide: old=%q replacement=%q", oldOpen.SessionID, replacement.SessionID)
	}

	mgr := NewManager(Config{Client: client})
	t.Cleanup(func() { _ = mgr.CloseAll(context.Background()) })
	mgr.discardRouting("late-open", oldOpen.SessionID, oldEpoch)
	if got := newDaemon.RequestCount(omorpc.CmdCloseSession); got != 0 {
		t.Fatalf("dead-epoch cleanup sent %d close request(s) to replacement epoch", got)
	}
	if live := newDaemon.LiveSessions(); len(live) != 1 {
		t.Fatalf("dead-epoch cleanup closed replacement route: %v", live)
	}

	// A retained retry from the dead epoch is stale for the same reason and
	// must be dropped by the drain rather than sent on the replacement epoch.
	stale := retiringRoute{route: oldOpen.SessionID, epoch: oldEpoch}
	mgr.mu.Lock()
	mgr.rememberRetiringLocked("late-open", stale)
	mgr.mu.Unlock()
	if err := mgr.drainRetiring(context.Background(), "late-open"); err != nil {
		t.Fatalf("drain stale retiring route: %v", err)
	}
	mgr.mu.Lock()
	remaining := len(mgr.retiringByChat["late-open"])
	mgr.mu.Unlock()
	if remaining != 0 {
		t.Fatalf("stale retiring routes after drain = %d", remaining)
	}
	if got := newDaemon.RequestCount(omorpc.CmdCloseSession); got != 0 {
		t.Fatalf("stale drain sent %d close request(s) to replacement epoch", got)
	}
}

func TestResumeOpenFailureUsesStablePaneMessage(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	store := newMemStore()
	chat := testChat{id: "sanitize-resume-open", cwd: t.TempDir()}
	cursor := Cursor{SessionFile: "/private/provider/session.jsonl", DurableSessionID: "durable-private"}
	if err := store.SaveCursor(context.Background(), chat.id, cursor); err != nil {
		t.Fatalf("seed cursor: %v", err)
	}
	const detail = "private provider detail /Users/example/session.jsonl"
	d.FailNext(omorpc.CmdOpenSession, omorpc.ErrCodeOpenFailed+": "+detail)
	mgr := NewManager(Config{Client: client, Store: store, RetryAttempts: 1})
	t.Cleanup(func() { _ = mgr.CloseAll(context.Background()) })

	_, _, _, err := mgr.ResumeInitialized(context.Background(), chat, nil, nil)
	var resumeErr *ResumeError
	if !errors.As(err, &resumeErr) {
		t.Fatalf("resume error = %T %v, want *ResumeError", err, err)
	}
	if got, want := resumeErr.Info.Message, "could not resume the saved session"; got != want {
		t.Fatalf("pane message = %q, want %q", got, want)
	}
	if strings.Contains(resumeErr.Info.Message, detail) {
		t.Fatalf("pane message leaked provider detail: %q", resumeErr.Info.Message)
	}
	var stable *omorpc.StableError
	if !errors.As(err, &stable) || stable.Code != omorpc.ErrCodeOpenFailed {
		t.Fatalf("underlying error = %T %v, want coded open failure", err, err)
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
