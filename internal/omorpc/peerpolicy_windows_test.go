//go:build windows

package omorpc

import (
	"os"
	"path/filepath"
	"testing"
)

func TestPeerUnknownAcceptedOnWindows(t *testing.T) {
	if !peerUnknownAccepted() {
		t.Fatal("peerUnknownAccepted() = false on windows, want true: no peer-PID credential exists there")
	}
}

func TestObserveUnknownNovelIdentityBecomesOwnedOnWindows(t *testing.T) {
	provenance := newEndpointProvenance(filepath.Join(t.TempDir(), "novel.sock"))
	identity := socketIdentity{Device: 1, Inode: 1}

	provenance.observe(identity, true, peerUnknown)

	if !provenance.owns(identity) {
		t.Fatal("accepted unknown peer on a novel identity was not recorded as launch-owned")
	}
}

func TestObserveUnknownBaselineIdentityStaysUnownedOnWindows(t *testing.T) {
	existing := filepath.Join(t.TempDir(), "baseline.sock")
	if err := os.WriteFile(existing, []byte("baseline identity holder"), 0o600); err != nil {
		t.Fatal(err)
	}
	provenance := newEndpointProvenance(existing)
	identity, exists := currentSocketIdentity(existing)
	if !exists {
		t.Fatal("baseline endpoint has no identity")
	}

	provenance.observe(identity, true, peerUnknown)

	if provenance.owns(identity) {
		t.Fatal("accepted unknown peer on the attempt baseline identity was recorded as launch-owned")
	}
}
