//go:build windows

package omorpc

import "testing"

func TestWindowsFixtureShutdown_whenNativeStalledIdle(t *testing.T) {
	// Given: the actual stalled fixture has no client to release Accept.
	// When: returning from the nested test runs its registered cleanup.
	passed := t.Run("fixture", func(fixtureT *testing.T) {
		nativeStalledPipe(fixtureT, false)
	})

	// Then: the close-order adapter requires worker completion before Close.
	if !passed {
		t.Fatal("idle native stalled fixture shutdown failed")
	}
}
