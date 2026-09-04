package session

import (
	"errors"
	"fmt"
	"testing"
	"time"
)

type synchronousLedgerRecorder struct {
	*recorder
}

func (*synchronousLedgerRecorder) SynchronousAttach() {}

func TestAttachReplaysFullSendOperationLedger(t *testing.T) {
	s := &Session{durableID: "durable-full-ledger", queueSize: DefaultQueueSize, readyPublished: true}
	for i := 0; i < maxSendOperationLedger; i++ {
		requestID := fmt.Sprintf("request-%02d", i)
		if err, stop := s.beginSendOperation(requestID); err != nil || stop {
			t.Fatalf("begin operation %d = (%v, %v)", i, err, stop)
		}
		s.recordSendOperation(requestID, nil)
		s.completeSendOperation(requestID, nil)
	}

	sub := &synchronousLedgerRecorder{recorder: newRecorder(maxSendOperationLedger + 1)}
	attached := make(chan error, 1)
	go func() {
		_, err := s.attachChecked(sub)
		attached <- err
	}()
	select {
	case err := <-attached:
		if err != nil {
			t.Fatalf("attach full ledger: %v", err)
		}
	case <-time.After(testTimeout):
		t.Fatal("attach blocked while replaying a full operation ledger")
	}
	t.Cleanup(func() { s.broadcast.close(ErrSubscriberSessionEnd) })

	if ready := sub.next(t); ready.Kind != FrameReady {
		t.Fatalf("first replay frame = %+v, want ready", ready)
	}
	for i := 0; i < maxSendOperationLedger; i++ {
		frame := sub.next(t)
		wantID := fmt.Sprintf("request-%02d", i)
		if frame.Kind != FrameAck || frame.RequestID != wantID {
			t.Fatalf("operation replay %d = %+v, want ack for %q", i, frame, wantID)
		}
	}
}

func TestFullSendOperationLedgerRejectsWhenEveryEntryIsInFlight(t *testing.T) {
	s := &Session{durableID: "durable-in-flight"}
	for i := 0; i < maxSendOperationLedger; i++ {
		requestID := fmt.Sprintf("request-%02d", i)
		if err, stop := s.beginSendOperation(requestID); err != nil || stop {
			t.Fatalf("begin operation %d = (%v, %v)", i, err, stop)
		}
		s.recordSendOperation(requestID, nil)
	}

	err, stop := s.beginSendOperation("overflow")
	if !stop || !errors.Is(err, ErrSendBackpressure) {
		t.Fatalf("full in-flight ledger admission = (%v, %v), want send backpressure", err, stop)
	}
	if len(s.sendOperationFIFO) != maxSendOperationLedger || len(s.sendOperations) != maxSendOperationLedger {
		t.Fatalf("ledger changed after rejection: fifo=%d map=%d", len(s.sendOperationFIFO), len(s.sendOperations))
	}
	if _, exists := s.sendOperations["request-00"]; !exists {
		t.Fatal("oldest in-flight operation was evicted")
	}
	if _, exists := s.sendOperations["overflow"]; exists {
		t.Fatal("rejected operation was inserted")
	}
}

func TestFullSendOperationLedgerEvictsOldestTerminalEntry(t *testing.T) {
	s := &Session{durableID: "durable-terminal-eviction"}
	for i := 0; i < maxSendOperationLedger; i++ {
		requestID := fmt.Sprintf("request-%02d", i)
		if err, stop := s.beginSendOperation(requestID); err != nil || stop {
			t.Fatalf("begin operation %d = (%v, %v)", i, err, stop)
		}
		s.recordSendOperation(requestID, nil)
	}
	s.completeSendOperation("request-00", nil)

	if err, stop := s.beginSendOperation("replacement"); err != nil || stop {
		t.Fatalf("replacement admission = (%v, %v)", err, stop)
	}
	if _, exists := s.sendOperations["request-00"]; exists {
		t.Fatal("oldest terminal operation was not evicted")
	}
	for i := 1; i < maxSendOperationLedger; i++ {
		requestID := fmt.Sprintf("request-%02d", i)
		operation, exists := s.sendOperations[requestID]
		if !exists || operation.phase != sendOperationAdmitted {
			t.Fatalf("in-flight operation %q was not preserved: %+v, exists=%v", requestID, operation, exists)
		}
	}
	if got := s.sendOperationFIFO[len(s.sendOperationFIFO)-1]; got != "replacement" {
		t.Fatalf("newest ledger entry = %q, want replacement", got)
	}
}

func TestSuccessfulProviderCompletionMarksSendOperationTerminalForReplay(t *testing.T) {
	s := &Session{durableID: "durable-success", queueSize: 1, readyPublished: true}
	if err, stop := s.beginSendOperation("successful-send"); err != nil || stop {
		t.Fatalf("begin operation = (%v, %v)", err, stop)
	}
	s.recordSendOperation("successful-send", nil)
	if operation := s.sendOperations["successful-send"]; operation.phase != sendOperationAdmitted {
		t.Fatalf("admission phase = %v, want admitted", operation.phase)
	}

	// Detached completion callbacks use publishDetachedError for both success
	// and failure; success records the terminal outcome without publishing an
	// additional live frame.
	s.publishDetachedError(nil, "chat.send", "successful-send")
	operation := s.sendOperations["successful-send"]
	if operation.phase != sendOperationTerminal || operation.outcome.Kind != FrameAck {
		t.Fatalf("successful completion = %+v, want terminal ack", operation)
	}

	sub := &synchronousLedgerRecorder{recorder: newRecorder(2)}
	if _, err := s.attachChecked(sub); err != nil {
		t.Fatalf("attach completed operation: %v", err)
	}
	t.Cleanup(func() { s.broadcast.close(ErrSubscriberSessionEnd) })
	if ready := sub.next(t); ready.Kind != FrameReady {
		t.Fatalf("first replay frame = %+v, want ready", ready)
	}
	if outcome := sub.next(t); outcome.Kind != FrameAck || outcome.RequestID != "successful-send" {
		t.Fatalf("successful replay outcome = %+v", outcome)
	}
}
