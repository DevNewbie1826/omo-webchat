package omorpctest

import (
	"context"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

func TestRequestPathBarrierObservesBlockedResumeOpen(t *testing.T) {
	// Given: one durable path and an exact gate for its next resume open.
	fixture := newQueueTest(t)
	baseline := fixture.d.RequestCountForPath(omorpc.CmdOpenSession, fixture.path)
	release := fixture.d.BlockHandlerForPath(omorpc.CmdOpenSession, fixture.path)
	t.Cleanup(release)
	result := make(chan error, 1)
	go func() {
		_, err := fixture.c.Call(context.Background(), omorpc.OpenSession{SessionPath: fixture.path})
		result <- err
	}()

	// When: the request reaches the fixture's path-specific handler barrier.
	if !fixture.d.AwaitRequestCountForPath(omorpc.CmdOpenSession, fixture.path, baseline+1, 2*time.Second) {
		t.Fatal("resume open did not reach the path barrier")
	}
	release()

	// Then: the exact request completes after release.
	timer := time.NewTimer(2 * time.Second)
	defer timer.Stop()
	select {
	case err := <-result:
		if err != nil {
			t.Fatalf("resume open after barrier release: %v", err)
		}
	case <-timer.C:
		t.Fatal("resume open did not complete after barrier release")
	}
}
