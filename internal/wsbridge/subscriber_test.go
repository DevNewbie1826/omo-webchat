package wsbridge

import (
	"context"
	"testing"
	"time"
)

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
