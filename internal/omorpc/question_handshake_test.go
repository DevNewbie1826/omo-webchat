package omorpc_test

import (
	"testing"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

func TestQuestionCapabilityAdvertisedWhenDialing(t *testing.T) {
	// Given
	d := newMediaDaemon(t)
	// When
	dialMediaClient(t, d)
	// Then
	if !d.AwaitClientInfoCount(1, handshakeAwait) {
		t.Fatal("missing client handshake")
	}
	caps := handshakeCapabilities(t, d.LastRequest(omorpc.CmdSetClientInfo))
	if countCapability(caps, "question") != 1 {
		t.Fatalf("handshake capabilities = %v, want question exactly once", caps)
	}
}
