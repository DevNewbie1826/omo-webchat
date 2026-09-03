package wsbridge

import (
	"context"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/session"
)

func TestExternalWriteErrorPreservesTypedLeafState(t *testing.T) {
	mapped, err := mapError("error", "chat-1", session.Frame{Kind: session.FrameError, Data: session.ErrorInfo{Code: "external-write-detected", Message: "drift", KnownLeaf: "daemon-leaf", ObservedLeaf: "disk-leaf"}})
	if err != nil {
		t.Fatal(err)
	}
	frame, ok := mapped.(map[string]any)
	if !ok || frame["code"] != "external-write-detected" || frame["knownLeaf"] != "daemon-leaf" || frame["observedLeaf"] != "disk-leaf" {
		t.Fatalf("mapped external-write frame = %#v", mapped)
	}
}

func TestSubscriberDetachBeforeReadyReleasesInitializationFlight(t *testing.T) {
	s := newSubscriber(nil)
	published := make(chan struct{})
	flightReleased := make(chan struct{})

	detach := s.wrapDetach(func() {})
	go func() {
		close(published)
		s.activate(context.Background(), false)
		close(flightReleased)
	}()

	<-published
	detach()

	timer := time.NewTimer(time.Second)
	defer timer.Stop()
	select {
	case <-flightReleased:
	case <-timer.C:
		t.Fatal("detach between publication and Ready delivery retained initialization flight")
	}

	s.mu.Lock()
	active := s.active
	s.mu.Unlock()
	if active {
		t.Fatal("detached subscriber activated without Ready delivery")
	}
}
