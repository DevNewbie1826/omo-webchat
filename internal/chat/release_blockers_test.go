package chat

import (
	"errors"
	"io"
	"path/filepath"
	"reflect"
	"sync"
	"testing"
	"time"
)

func TestSessionPromptInFlightGate(t *testing.T) {
	logFile := filepath.Join(t.TempDir(), "rpc.log")
	s, writer := startMockSession(t, "chat-gate", "MOCK_PI_APPROVE=1", "MOCK_PI_LOG="+logFile)
	t.Cleanup(func() {
		if err := s.Close(); err != nil {
			t.Errorf("close session: %v", err)
		}
	})

	start, results := make(chan struct{}), make(chan error, 2)
	var wg sync.WaitGroup
	for _, message := range []string{"first", "second"} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			results <- s.SendPrompt(message, nil)
		}()
	}
	close(start)
	wg.Wait()
	first, second := <-results, <-results
	valid := first == nil && errors.Is(second, ErrPromptInFlight)
	valid = valid || second == nil && errors.Is(first, ErrPromptInFlight)
	if !valid {
		t.Fatalf("concurrent SendPrompt errors = %v, %v", first, second)
	}
	writer.waitForType(t, "approval", 2*time.Second)
	if got := readRPCLogLines(t, logFile); !reflect.DeepEqual(got, []string{"prompt"}) {
		t.Fatalf("provider work = %v, want one prompt", got)
	}
	if err := s.SendPrompt("overlap", nil); !errors.Is(err, ErrPromptInFlight) {
		t.Fatalf("overlapping SendPrompt error = %v", err)
	}
	confirmed := true
	if err := s.RespondApproval("approve-1", "", &confirmed, nil, nil); err != nil {
		t.Fatal(err)
	}
	writer.waitForType(t, "run.done", 2*time.Second)
	if err := s.SendPrompt("after completion", nil); err != nil {
		t.Fatalf("SendPrompt after completion: %v", err)
	}
}

type failingCommandWriter struct{}

func (failingCommandWriter) Write([]byte) (int, error) { return 0, io.ErrClosedPipe }
func (failingCommandWriter) Close() error              { return nil }

type controlledFailCommandWriter struct {
	entered chan struct{}
	fail    chan struct{}
}

func (w *controlledFailCommandWriter) Write([]byte) (int, error) {
	close(w.entered)
	<-w.fail
	return 0, io.ErrClosedPipe
}

func (*controlledFailCommandWriter) Close() error { return nil }

type acceptingCommandWriter struct{}

func (acceptingCommandWriter) Write(p []byte) (int, error) { return len(p), nil }
func (acceptingCommandWriter) Close() error                { return nil }

func TestSessionPromptWriteFailureRestoresIdleFinished(t *testing.T) {
	s := newTestSession("chat-prompt-write-failure", nil)
	s.proc = &Process{stdin: failingCommandWriter{}}

	if err := s.SendPrompt("cannot send", nil); err == nil {
		t.Fatal("SendPrompt with a failing provider writer returned nil")
	}
	s.mu.Lock()
	inFlight := s.promptInFlight
	stamped := !s.finishedAt.IsZero()
	s.mu.Unlock()
	if inFlight {
		t.Fatal("prompt gate remained set after write failure")
	}
	if !stamped {
		t.Fatal("prompt write failure did not stamp finishedAt")
	}
	if !s.IdleFinished(0, time.Now()) {
		t.Fatal("prompt write failure did not restore idle-finished state")
	}
}

func TestStalePromptWriteFailureDoesNotRollbackNewPrompt(t *testing.T) {
	firstWriter := &controlledFailCommandWriter{entered: make(chan struct{}), fail: make(chan struct{})}
	s := newTestSession("chat-stale-prompt-write", nil)
	s.proc = &Process{stdin: firstWriter}

	firstResult := make(chan error, 1)
	go func() { firstResult <- s.SendPrompt("first", nil) }()
	<-firstWriter.entered

	// The provider terminally rejects A while its write call is still parked.
	// Once that terminal error has been published, B is allowed to arm on a
	// fresh provider writer before A reports its stale write failure.
	s.failPrompt("rejected", "prompt-a")
	s.proc = &Process{stdin: acceptingCommandWriter{}}
	if err := s.SendPrompt("second", nil); err != nil {
		t.Fatalf("send second prompt: %v", err)
	}

	close(firstWriter.fail)
	if err := <-firstResult; err == nil {
		t.Fatal("first prompt write returned nil")
	}
	s.mu.Lock()
	inFlight := s.promptInFlight
	runDone := s.runDone
	s.mu.Unlock()
	if !inFlight || runDone {
		t.Fatalf("second prompt state was rolled back by stale A failure: inFlight=%v runDone=%v", inFlight, runDone)
	}
}

func TestSharedProviderWriteFailureOnlyRollsBackOwningSession(t *testing.T) {
	firstWriter := &controlledFailCommandWriter{entered: make(chan struct{}), fail: make(chan struct{})}
	proc := &Process{stdin: firstWriter}
	provider := &sharedProvider{proc: proc}
	sessionA := newTestSession("chat-write-a", nil)
	sessionA.shared, sessionA.routingHandle = provider, "rpc-a"
	sessionB := newTestSession("chat-write-b", nil)
	sessionB.shared, sessionB.routingHandle = provider, "rpc-b"

	resultA := make(chan error, 1)
	go func() { resultA <- sessionA.SendPrompt("first", nil) }()
	<-firstWriter.entered

	// B is already in flight independently when A's shared-process write
	// reports failure. A's rollback must be strictly session-local.
	sessionB.mu.Lock()
	sessionB.promptInFlight = true
	sessionB.promptSequence = 1
	sessionB.runDone = false
	sessionB.mu.Unlock()
	close(firstWriter.fail)
	if err := <-resultA; err == nil {
		t.Fatal("chat A prompt write returned nil")
	}
	sessionB.mu.Lock()
	inFlight, runDone := sessionB.promptInFlight, sessionB.runDone
	sessionB.mu.Unlock()
	if !inFlight || runDone {
		t.Fatalf("chat A failure rolled back chat B: inFlight=%v runDone=%v", inFlight, runDone)
	}
}

func TestSessionPromptGateClearsOnSendFailure(t *testing.T) {
	s, _ := startMockSession(t, "chat-send-failure")
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	if err := s.SendPrompt("cannot send", nil); err == nil {
		t.Fatal("SendPrompt after close succeeded")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.promptInFlight {
		t.Fatal("prompt gate remained set after send failure")
	}
}
