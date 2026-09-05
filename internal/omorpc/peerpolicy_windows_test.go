//go:build windows

package omorpc

import "testing"

func TestPeerUnknownRejectedOnWindows(t *testing.T) {
	if peerUnknownAccepted() {
		t.Fatal("unknown peer accepted despite available named-pipe credentials")
	}
}

func TestWindowsProvenanceRequiresVerifiedOwnedPeer(t *testing.T) {
	identity := socketIdentity{Device: 1, Inode: 2}
	for _, tc := range []struct {
		name   string
		peer   peerProvenance
		stable bool
		owned  bool
	}{
		{"unknown", peerUnknown, true, false}, {"foreign", peerForeign, true, false},
		{"unstable_owned", peerOwned, false, false}, {"owned", peerOwned, true, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p := &endpointProvenance{peers: make(map[socketIdentity]peerProvenance)}
			p.observe(identity, tc.stable, tc.peer)
			if p.owns(identity) != tc.owned {
				t.Fatalf("ownership=%t, want %t", p.owns(identity), tc.owned)
			}
		})
	}
}

func TestWindowsForeignIdentityCannotBecomeOwned(t *testing.T) {
	identity := socketIdentity{Device: 1, Inode: 2}
	p := &endpointProvenance{peers: make(map[socketIdentity]peerProvenance)}
	p.observe(identity, true, peerForeign)
	p.observe(identity, true, peerOwned)
	if p.owns(identity) {
		t.Fatal("foreign endpoint became owned")
	}
}
