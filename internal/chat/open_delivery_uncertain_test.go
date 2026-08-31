package chat

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"sync"
	"testing"
	"time"
)

// slowCompletingPipe records every write ENTRY, then completes the write only
// after hold has elapsed. hold sits between one and two send timeouts: the
// caller's Send always gives up before the write lands (the delivery-unknown
// state the manager must not retry), yet the writer is free again well within
// a follow-up Send's own deadline, so any second command reaches the pipe -
// and is recorded - before that second Send can return. Entry recording is
// synchronous with the write, so it orders strictly before the Send that
// issued it returns.
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
// The witness is deterministic. A reverted guard runs the fallback open inside
// AcquireAttach and that fallback awaits its own Send, which cannot return
// before the writer has entered the pipe with the second command. So a second
// entry is always recorded before AcquireAttach returns, and asserting the
// entry count after the acquire result cannot race the fallback.
func TestResumedOpenSendTimeoutDoesNotIssueFallbackOpen(t *testing.T) {
	const sendTimeout = 500 * time.Millisecond
	pipe := &slowCompletingPipe{hold: sendTimeout + sendTimeout/2, entries: make(chan []byte, 8)}
	proc := &Process{stdin: pipe, sendTimeout: sendTimeout}
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

	result := make(chan error, 1)
	go func() {
		_, _, _, err := manager.AcquireAttach(context.Background(), SessionOptions{
			ID:          "uncertain-resume",
			Binary:      "unused-existing-provider",
			PiSessionID: "/tmp/provider-session.jsonl",
		}, nil)
		result <- err
	}()

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

	// AcquireAttach has returned; a reverted guard would already have recorded
	// its fallback command here.
	select {
	case raw := <-pipe.entries:
		t.Fatalf("delivery-unknown resume issued a second open command: %s", raw)
	default:
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
