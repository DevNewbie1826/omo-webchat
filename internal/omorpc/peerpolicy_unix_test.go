//go:build darwin || linux

package omorpc

import (
	"path/filepath"
	"testing"
)

func TestPeerUnknownRejectedOnUnix(t *testing.T) {
	if peerUnknownAccepted() {
		t.Fatal("peerUnknownAccepted() = true on unix, want false: the peer credential lookup is definitive")
	}
}

func TestObserveUnknownPeerStaysUnrecordedOnUnix(t *testing.T) {
	provenance := newEndpointProvenance(filepath.Join(t.TempDir(), "novel.sock"))
	identity := socketIdentity{Device: 1, Inode: 1}

	provenance.observe(identity, true, peerUnknown)

	if got := provenance.provenance(identity); got != peerUnknown {
		t.Fatalf("provenance after unknown peer observation = %v, want unrecorded unknown", got)
	}
	if provenance.owns(identity) {
		t.Fatal("unknown peer observation recorded launch ownership")
	}
}

func TestObserveOwnedNovelIdentityBecomesOwnedOnUnix(t *testing.T) {
	provenance := newEndpointProvenance(filepath.Join(t.TempDir(), "novel.sock"))
	identity := socketIdentity{Device: 1, Inode: 1}

	provenance.observe(identity, true, peerOwned)

	if !provenance.owns(identity) {
		t.Fatal("owned peer observation on a novel identity was not recorded as launch-owned")
	}
}
