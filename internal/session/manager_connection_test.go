package session

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

func TestManagerWaitForConnectionUsesCloseTimeoutBudget(t *testing.T) {
	d := newDaemon(t)
	client, err := omorpc.DialWithConfig(t.Context(), d.SocketPath(), omorpc.Config{
		ReconnectInitial:     time.Second,
		ReconnectMax:         time.Second,
		ReconnectMaxAttempts: 8,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close() })
	mgr := NewManager(Config{Client: client, Store: newMemStore(), CloseTimeout: 25 * time.Millisecond})
	t.Cleanup(func() { _ = mgr.CloseAll(context.Background()) })

	_, events := client.CurrentEpoch()
	d.Stop()
	awaitStreamClosed(t, events)

	result := make(chan error, 1)
	go func() { result <- mgr.WaitForConnection(context.Background()) }()
	select {
	case err := <-result:
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("WaitForConnection error = %v, want deadline exceeded", err)
		}
	case <-time.After(testTimeout):
		t.Fatal("WaitForConnection exceeded its bounded budget")
	}
}
