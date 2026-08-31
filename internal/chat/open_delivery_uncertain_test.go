package chat

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// slowCompletingPipe records every write ENTRY, then completes the write only
// after hold has elapsed. hold exceeds a single send timeout so the caller's
// Send always gives up before the write lands - the delivery-unknown state the
// manager must not retry. Entry recording is synchronous with the write.
type slowCompletingPipe struct {
	hold    time.Duration
	entries chan []byte
}

func (p *slowCompletingPipe) Write(b []byte) (int, error) {
	p.entries <- append([]byte(nil), b...)
	time.Sleep(p.hold)
	return len(b), nil
}

func (p *slowCompletingPipe) Close() error { return nil }

// TestResumedOpenSendTimeoutDoesNotIssueFallbackOpen pins the
// delivery-unknown contract: when the resumed open_session write misses its
// send deadline, the manager must NOT open a fresh session, because the first
// command can still reach the provider afterwards and orphan a provider-side
// session.
//
// The witness is deterministic and independent of writer scheduling. It counts
// ENQUEUES (Process.afterEnqueue), not pipe entries. A reverted guard runs the
// fallback open inside AcquireAttach on a background context; that fallback's
// Send cannot return until it has enqueued its frame and then timed out, so a
// second enqueue is guaranteed to fire before AcquireAttach returns. Keying on
// pipe entry instead would be racy: the writer might not have dequeued the
// fallback frame yet (or the frame could be discarded as expired before entry).
// Enqueue happens-before AcquireAttach's return, so asserting the enqueue count
// afterwards cannot miss the fallback regardless of how slowly the first write
// entered the pipe.
func TestResumedOpenSendTimeoutDoesNotIssueFallbackOpen(t *testing.T) {
	const sendTimeout = 500 * time.Millisecond
	// hold exceeds one send timeout so the first Send always times out with the
	// write still in flight (delivery unknown). Its exact value never gates the
	// witness because the witness observes enqueue, not write entry.
	pipe := &slowCompletingPipe{hold: 3 * sendTimeout, entries: make(chan []byte, 8)}
	proc := &Process{stdin: pipe, sendTimeout: sendTimeout}
	t.Cleanup(proc.stopWriter)

	var enqueues atomic.Int64
	enqueued := make(chan struct{}, 8)
	proc.afterEnqueue = func(*writeRequest) {
		enqueues.Add(1)
		select {
		case enqueued <- struct{}{}:
		default:
		}
	}

	provider := &sharedProvider{
		proc:     proc,
		state:    sharedProviderStarted,
		sessions: make(map[string]*sessionRoute),
		pending:  make(map[string]pendingProviderRequest),
		requests: make(map[string]*sessionRoute),
		done:     make(chan struct{}),
	}
	provider.closeProcess = func() error { close(provider.done); return nil }
	manager := NewManager()
	defer manager.CloseAll()
	manager.provider = provider

	result := make(chan error, 1)
	go func() {
		_, _, _, err := manager.AcquireAttach(context.Background(), SessionOptions{
			ID:          "uncertain-resume",
			Binary:      "unused-existing-provider",
			PiSessionID: "/tmp/provider-session.jsonl",
		}, nil)
		result <- err
	}()

	// The first (resume) open must enqueue and reach the pipe as an
	// open_session with a sessionPath, so the scenario under test really is a
	// resumed open whose write is stuck in flight.
	select {
	case <-enqueued:
	case <-time.After(10 * time.Second):
		t.Fatal("resume open never enqueued")
	}
	var first []byte
	select {
	case first = <-pipe.entries:
	case <-time.After(10 * time.Second):
		t.Fatal("resume open never reached the provider pipe")
	}
	var cmd map[string]any
	if err := json.Unmarshal(first, &cmd); err != nil {
		t.Fatal(err)
	}
	if cmd["type"] != "open_session" || cmd["sessionPath"] == nil {
		t.Fatalf("first command = %v, want resumed open_session", cmd)
	}

	select {
	case err := <-result:
		if !errors.Is(err, ErrSendTimeout) {
			t.Fatalf("AcquireAttach error = %v, want a send-timeout error", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("timed-out resume did not return")
	}

	// AcquireAttach has returned. A reverted guard's fallback open runs a
	// second Send on a background context, which cannot return - and therefore
	// AcquireAttach cannot return - before that Send has enqueued. So the total
	// enqueue count is fixed at exactly one here for the correct guard; a second
	// enqueue is a delivery-unknown resume that wrongly issued a fallback open.
	if got := enqueues.Load(); got != 1 {
		t.Fatalf("enqueue count after acquire = %d, want exactly 1 (a second enqueue means a fallback open was issued for a delivery-unknown resume)", got)
	}
}

// TestResumedOpenCancellationDoesNotIssueFallbackOpen keeps the cancellation
// arm of the same contract: a cancelled resume surfaces the cancellation and
// never reports success. The exactly-once witness lives in the send-timeout
// test above, where the fallback cannot short-circuit on an already cancelled
// context.
func TestResumedOpenCancellationDoesNotIssueFallbackOpen(t *testing.T) {
	pipe := &slowCompletingPipe{hold: 2 * time.Second, entries: make(chan []byte, 8)}
	proc := &Process{stdin: pipe, sendTimeout: 10 * time.Second}
	t.Cleanup(proc.stopWriter)
	provider := &sharedProvider{
		proc:     proc,
		state:    sharedProviderStarted,
		sessions: make(map[string]*sessionRoute),
		pending:  make(map[string]pendingProviderRequest),
		requests: make(map[string]*sessionRoute),
		done:     make(chan struct{}),
	}
	provider.closeProcess = func() error { close(provider.done); return nil }
	manager := NewManager()
	defer manager.CloseAll()
	manager.provider = provider

	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan error, 1)
	go func() {
		_, _, _, err := manager.AcquireAttach(ctx, SessionOptions{
			ID:          "uncertain-resume-cancel",
			Binary:      "unused-existing-provider",
			PiSessionID: "/tmp/provider-session.jsonl",
		}, nil)
		result <- err
	}()
	select {
	case <-pipe.entries:
	case <-time.After(10 * time.Second):
		t.Fatal("resume open never reached the provider pipe")
	}
	cancel()
	select {
	case err := <-result:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("AcquireAttach error = %v, want context canceled", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("cancelled resume did not return")
	}
}

type blockingUntilClosedPipe struct {
	entered chan struct{}
	release chan struct{}
	once    sync.Once
}

func (p *blockingUntilClosedPipe) Write([]byte) (int, error) {
	p.once.Do(func() { close(p.entered) })
	<-p.release
	return 0, io.ErrClosedPipe
}
func (p *blockingUntilClosedPipe) Close() error {
	select {
	case <-p.release:
	default:
		close(p.release)
	}
	return nil
}

func TestOpenProviderDeathWriteWaitHonorsCallerCancellation(t *testing.T) {
	pipe := &blockingUntilClosedPipe{entered: make(chan struct{}), release: make(chan struct{})}
	deathProc := &Process{stdin: pipe, sendTimeout: 10 * time.Second}
	t.Cleanup(deathProc.stopWriter)
	provider := &sharedProvider{
		proc:     deathProc,
		state:    sharedProviderStarted,
		sessions: make(map[string]*sessionRoute),
		pending:  make(map[string]pendingProviderRequest),
		requests: make(map[string]*sessionRoute),
		done:     make(chan struct{}),
	}
	close(provider.done)
	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan error, 1)
	go func() {
		result <- provider.openSession(ctx, newTestSession("death-open", nil), SessionOptions{Cwd: t.TempDir()})
	}()
	select {
	case <-pipe.entered:
	case <-time.After(2 * time.Second):
		t.Fatal("open write never entered controlled pipe")
	}
	cancel()
	select {
	case err := <-result:
		if err != context.Canceled {
			t.Fatalf("open error = %v, want context canceled", err)
		}
	case <-time.After(time.Second):
		t.Fatal("provider-death write arm ignored caller cancellation")
	}
	_ = pipe.Close()
}
