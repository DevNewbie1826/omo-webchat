package api

import (
	"context"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

type unifiedBlockingCaller struct {
	entered chan struct{}
	exited  chan struct{}
}

func (c *unifiedBlockingCaller) CallInEpoch(ctx context.Context, _ omorpc.Command) (*omorpc.Response, omorpc.EpochToken, error) {
	close(c.entered)
	<-ctx.Done()
	close(c.exited)
	return nil, omorpc.EpochToken{}, ctx.Err()
}

func TestUnifiedSessionWatcherLifecycleCancelsAndJoinsPoll(t *testing.T) {
	// Given: an RPC call that lasts until the server cancels it.
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	s := &Server{ctx: ctx}
	caller := &unifiedBlockingCaller{entered: make(chan struct{}), exited: make(chan struct{})}
	stop := s.startRPCWatcher(caller)
	t.Cleanup(stop)
	select {
	case <-caller.entered:
	case <-ctx.Done():
		t.Fatal("watcher did not poll immediately")
	}
	// When: server teardown joins the running poll.
	stop()
	// Then: the call exited and the watcher did not publish cancelled state.
	select {
	case <-caller.exited:
	default:
		t.Fatal("watcher stop returned before RPC call exited")
	}
	if len(s.rpcWatcher.Sessions()) != 0 {
		t.Fatal("cancelled poll published a snapshot")
	}
	t.Log("cleanup: watcher cancellation joined, no polling goroutine remains")
}

func TestUnifiedSessionWatcherLifecycleWithoutClientIsEmpty(t *testing.T) {
	s := &Server{ctx: t.Context()}
	stop := s.startRPCWatcher(nil)
	defer stop()
	s.rpcWatcher.Tick(t.Context())
	if rows := s.rpcWatcher.Sessions(); rows == nil || len(rows) != 0 {
		t.Fatalf("disabled watcher=%+v", rows)
	}
}
