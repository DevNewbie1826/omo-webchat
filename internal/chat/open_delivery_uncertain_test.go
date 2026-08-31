package chat

import (
	"context"
	"encoding/json"
	"io"
	"sync"
	"testing"
	"time"
)

type releaseRecordingPipe struct {
	entered chan struct{}
	release chan struct{}
	writes  chan []byte
	once    sync.Once
}

func (p *releaseRecordingPipe) Write(b []byte) (int, error) {
	p.once.Do(func() { close(p.entered) })
	<-p.release
	p.writes <- append([]byte(nil), b...)
	return len(b), nil
}

func (p *releaseRecordingPipe) Close() error { return nil }

func TestResumedOpenCancellationDoesNotIssueFallbackOpen(t *testing.T) {
	pipe := &releaseRecordingPipe{
		entered: make(chan struct{}),
		release: make(chan struct{}),
		writes:  make(chan []byte, 4),
	}
	provider := &sharedProvider{
		proc:     &Process{stdin: pipe, sendTimeout: 5 * time.Second},
		state:    sharedProviderStarted,
		sessions: make(map[string]*sessionRoute),
		pending:  make(map[string]pendingProviderRequest),
		requests: make(map[string]*sessionRoute),
		done:     make(chan struct{}),
	}
	provider.closeProcess = func() error {
		select {
		case <-pipe.release:
		default:
			close(pipe.release)
		}
		close(provider.done)
		return nil
	}
	manager := NewManager()
	defer manager.CloseAll()
	manager.provider = provider

	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan error, 1)
	go func() {
		_, _, _, err := manager.AcquireAttach(ctx, SessionOptions{
			ID:          "uncertain-resume",
			Binary:      "unused-existing-provider",
			PiSessionID: "/tmp/provider-session.jsonl",
		}, nil)
		result <- err
	}()
	select {
	case <-pipe.entered:
	case <-time.After(2 * time.Second):
		t.Fatal("resume open never entered the blocked writer")
	}
	cancel()
	select {
	case err := <-result:
		if err != context.Canceled {
			t.Fatalf("AcquireAttach error = %v, want context canceled", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("cancelled resume did not return")
	}

	select {
	case raw := <-pipe.writes:
		var cmd map[string]any
		if err := json.Unmarshal(raw, &cmd); err != nil {
			t.Fatal(err)
		}
		if cmd["type"] != "open_session" || cmd["sessionPath"] == nil {
			t.Fatalf("first command = %v, want resumed open_session", cmd)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("blocked resume was not released to the provider")
	}
	select {
	case raw := <-pipe.writes:
		t.Fatalf("delivery-unknown resume issued a second open command: %s", raw)
	default:
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
	provider := &sharedProvider{
		proc:     &Process{stdin: pipe, sendTimeout: 10 * time.Second},
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
