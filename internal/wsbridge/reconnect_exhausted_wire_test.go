package wsbridge

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/wscontract"
)

func TestReconnectExhaustionSurvivesSubscriberWireBoundary(t *testing.T) {
	const chatID = "exhausted-wire"
	h := newInPlaceBridgeHarness(t, chatID)
	conn, frames := h.connect(t)
	attachAndAwaitHistory(t, conn, frames, chatID)
	awaitCommandFence(t, conn, frames)
	// Removing the listener before disconnect guarantees every reconnect
	// attempt fails. Await the exact terminal frame, not a retry-duration sleep.
	h.daemon.Stop()
	awaitTransportLoss(t, frames)
	wire := frames.nextMatching(t, "error", time.Minute, func(f map[string]any) bool {
		return f["code"] == "reconnect_exhausted"
	})
	if wire["sessionId"] != chatID {
		t.Fatalf("exhaustion frame = %v", wire)
	}
	raw, err := json.Marshal(wire)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := wscontract.ParseServerFrame(raw)
	if err != nil {
		t.Fatalf("generated contract rejected subscriber output %s: %v", raw, err)
	}
	frame, ok := parsed.(*wscontract.ErrorFrame)
	if !ok || frame.Code == nil || *frame.Code != "reconnect_exhausted" {
		t.Fatalf("generated error frame = %#v", parsed)
	}
	encoded, err := json.Marshal(frame)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := wscontract.ParseServerFrame(encoded); err != nil {
		t.Fatalf("generated round trip: %v", err)
	}
}
