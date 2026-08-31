package chat

import (
	"slices"
	"testing"
)

func TestManagerLiveIDsReturnsSortedAliveSessions(t *testing.T) {
	// Given
	manager := NewManager()
	t.Cleanup(manager.CloseAll)
	manager.sessions["zeta"] = &Session{id: "zeta", frames: newBroadcaster()}
	manager.sessions["closed"] = &Session{id: "closed", done: true, frames: newBroadcaster()}
	manager.sessions["alpha"] = &Session{id: "alpha", frames: newBroadcaster()}

	// When
	got := manager.LiveIDs()

	// Then
	want := []string{"alpha", "zeta"}
	if !slices.Equal(got, want) {
		t.Fatalf("LiveIDs() = %v, want %v", got, want)
	}
}
