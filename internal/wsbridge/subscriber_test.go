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

func TestSubscriberActivationUsesGenerationBoundClaimAndDetachEndsReplay(t *testing.T) {
	conn := &connection{}
	sess := &session.Session{}
	s := newSubscriber(conn)
	conn.stateMu.Lock()
	conn.wsID, conn.chatID, conn.bindingGeneration, conn.sess, conn.sub = "ws", "original", 7, sess, s
	conn.stateMu.Unlock()

	s.BeginReplay()
	s.readyOnce.Do(func() { close(s.ready) })
	// An unmapped frame exercises activation's pending flush without requiring
	// a socket; stale mapped frames below are rejected by the captured claim.
	s.Deliver(session.Frame{Kind: session.FrameKind("unmapped")})
	if !s.activate(context.Background(), false) {
		t.Fatal("subscriber did not activate")
	}
	if s.claim.chatID != "original" || s.claim.generation != 7 || s.claim.session != sess {
		t.Fatalf("captured write claim = %+v", s.claim)
	}
	conn.outboundMu.Lock()
	replaying := conn.replayActive && conn.replayOwner == s
	conn.outboundMu.Unlock()
	if !replaying {
		t.Fatal("activation did not begin the pending replay")
	}

	conn.stateMu.Lock()
	conn.chatID, conn.bindingGeneration, conn.sess = "replacement", 8, &session.Session{}
	conn.stateMu.Unlock()
	if err := s.DeliverFrame(session.Frame{Kind: session.FrameName, Data: map[string]any{"name": "stale"}}); err != nil {
		t.Fatalf("stale delivery = %v", err)
	}
	if s.claim.chatID != "original" {
		t.Fatalf("stale subscriber adopted replacement binding: %+v", s.claim)
	}

	s.signalDetach()
	conn.outboundMu.Lock()
	replaying = conn.replayActive
	conn.outboundMu.Unlock()
	if replaying {
		t.Fatal("detach left replay active")
	}
}

func TestRecoveredAdmissionAckRejectsReboundGeneration(t *testing.T) {
	resumed := &session.Session{}
	conn := &connection{}
	op := &chatSendOperation{conn: conn, chatID: "original", bindingGeneration: 4, requestID: "request-1"}
	conn.stateMu.Lock()
	conn.chatID, conn.bindingGeneration, conn.sess = "replacement", 5, &session.Session{}
	conn.stateMu.Unlock()

	// A stale atomic claim is a no-op. With no socket installed, any attempted
	// delivery would instead return netClosedError and expose cross-binding use.
	if err := op.writeRecoveredAdmissionAck(resumed); err != nil {
		t.Fatalf("stale recovered ack attempted delivery: %v", err)
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
