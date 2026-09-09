package session

import (
	"fmt"
	"testing"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

func TestRecoveryCompletionPreservesAmbiguousAdmission(t *testing.T) {
	for _, retry := range []bool{false, true} {
		t.Run(fmt.Sprintf("retry=%v", retry), func(t *testing.T) {
			const requestID = "unknown-outcome"
			s := &Session{durableID: "durable-unknown", queueSize: DefaultQueueSize}
			if err, stop := s.beginSendOperation(requestID); err != nil || stop {
				t.Fatalf("admission = %v, %v", err, stop)
			}
			s.recordSendOperation(requestID, nil)
			if retry {
				if _, ok := s.PrepareDetachedSendRetry(requestID, false); !ok {
					t.Fatal("retry not prepared")
				}
				if err, stop := s.beginSendOperation(requestID); err != nil || stop {
					t.Fatalf("retry admission = %v, %v", err, stop)
				}
			}
			err := fmt.Errorf("%w: %w", ErrSendOutcomeUnknown, omorpc.ErrDisconnected)
			// Both the retry callback and the outer acquisition-error completion can
			// visit this publisher. Neither may turn ambiguity into terminal failure.
			s.CompleteDetachedSend(requestID, err)
			s.CompleteDetachedSend(requestID, err)
			s.publishDetachedOutcome(err, "chat.send", requestID)
			operation := s.sendOwner.operations[requestID]
			if operation.phase != sendOperationAdmitted || operation.published {
				t.Fatalf("ambiguous outcome = %+v", operation)
			}
			if prior, duplicate := s.beginSendOperation(requestID); !duplicate || prior != nil {
				t.Fatalf("explicit replay = %v, %v", prior, duplicate)
			}
		})
	}
}

func TestInvalidationPreservesAtLossWorkEligibility(t *testing.T) {
	for _, activity := range []string{"prompt", "run", "compaction", "local"} {
		t.Run(activity, func(t *testing.T) {
			s := &Session{}
			switch activity {
			case "prompt":
				s.promptInFlight = true
			case "run":
				s.providerRunActive = true
			case "compaction":
				s.compactionActive = true
			case "local":
				s.localCommandActive = true
			}
			s.invalidate("provider_disconnected", "lost")
			s.invalidate("provider_disconnected", "repeat loss")
			if !s.workAtLoss || s.activeLocked() {
				t.Fatalf("at-loss work=%v live work=%v", s.workAtLoss, s.activeLocked())
			}
		})
	}
}

func TestReconnectExhaustionPublishesToEveryLostSession(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d) // bounded two-attempt reconnect, no timing-based waits
	mgr := testManager(t, client, newMemStore(), 64)
	panes := []*recorder{newRecorder(16), newRecorder(16)}
	for i, pane := range panes {
		_, _, detach := acquire(t, mgr, testChat{id: fmt.Sprintf("exhausted-%d", i), cwd: t.TempDir()}, pane)
		defer detach()
		pane.await(t, FrameReady)
	}
	d.Stop() // listener is gone before connections close: every reconnect fails
	for _, pane := range panes {
		pane.awaitError(t, "provider_disconnected")
		pane.awaitError(t, "reconnect_exhausted")
	}
}
