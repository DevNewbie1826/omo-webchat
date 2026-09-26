package session

import "testing"

func TestManagerInstanceIDDiffersAcrossManagers(t *testing.T) {
	// Given two independent manager lifetimes.
	first := NewManager(Config{})
	second := NewManager(Config{})

	// When their identities are observed.
	firstID := first.InstanceID()
	secondID := second.InstanceID()

	// Then each identity is nonempty, stable, and distinct.
	if firstID == "" || secondID == "" {
		t.Fatalf("manager instance IDs must be nonempty: first=%q second=%q", firstID, secondID)
	}
	if first.InstanceID() != firstID || second.InstanceID() != secondID {
		t.Fatal("manager instance ID changed during its lifetime")
	}
	if firstID == secondID {
		t.Fatalf("different managers share instance ID %q", firstID)
	}
}
