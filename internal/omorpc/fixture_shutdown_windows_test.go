//go:build windows

package omorpc

import (
	"context"
	"testing"
	"time"
)

func TestWindowsFixtureShutdown_whenIdle(t *testing.T) {
	// Given: a real pipe fixture with no client connection.
	// When: returning from the nested test runs its fixture cleanup.
	passed := t.Run("fixture", func(fixtureT *testing.T) {
		productionPipeFixture(fixtureT)
	})

	// Then: cleanup completes without requiring an external client.
	if !passed {
		t.Fatal("idle pipe fixture cleanup failed")
	}
}

func TestWindowsFixtureShutdown_whenConnectionRemainsActive(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	var events <-chan *Event

	passed := t.Run("fixture", func(fixtureT *testing.T) {
		// Given: the real pipe worker has served a negotiated client.
		path := productionPipeFixture(fixtureT)
		client, err := Dial(ctx, path)
		if err != nil {
			fixtureT.Fatal(err)
		}
		// Parent cleanup deliberately follows the nested fixture cleanup.
		t.Cleanup(func() {
			if err := client.Close(); err != nil {
				t.Error(err)
			}
		})
		events = client.Events()
		select {
		case <-events:
			fixtureT.Fatal("client stream was not idle and open before shutdown")
		default:
		}

		// When: return with the client still open and run fixture cleanup.
	})

	// Then: cleanup closes the serving connection and its client stream.
	if !passed {
		t.Fatal("active pipe fixture cleanup failed")
	}
	select {
	case _, open := <-events:
		if open {
			t.Fatal("fixture shutdown delivered an event instead of closing the stream")
		}
	case <-ctx.Done():
		t.Fatalf("fixture shutdown left the active client connected: %v", ctx.Err())
	}
}
