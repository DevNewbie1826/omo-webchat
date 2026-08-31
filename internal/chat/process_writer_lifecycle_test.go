package chat

import (
	"context"
	"errors"
	"io"
	"os/exec"
	"sync"
	"testing"
	"time"
)

func TestProcessFailedStartDoesNotSpawnWriter(t *testing.T) {
	var observed *Process
	_, err := Start(context.Background(), ProcessOptions{
		Binary: t.TempDir() + "/missing-provider",
		beforeStart: func(p *Process) {
			observed = p
		},
	})
	if err == nil {
		t.Fatal("missing provider unexpectedly started")
	}
	if observed == nil {
		t.Fatal("failed start did not reach the exec boundary")
	}
	if observed.writerDone != nil || observed.writeQueue != nil {
		t.Fatalf("failed start spawned writer machinery: done=%v queue=%v", observed.writerDone, observed.writeQueue)
	}
}

func TestProcessNaturalEOFReapsWriter(t *testing.T) {
	sh, err := exec.LookPath("sh")
	if err != nil {
		t.Skipf("sh not in PATH: %v", err)
	}
	proc, err := Start(context.Background(), ProcessOptions{Binary: sh, Args: []string{"-c", "exit 0"}})
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-proc.exited:
	case <-time.After(5 * time.Second):
		t.Fatal("provider did not exit")
	}
	select {
	case <-proc.writerDone:
	default:
		t.Fatal("natural provider exit did not reap the writer")
	}
}

type closeReleasingPipe struct {
	entered chan struct{}
	release chan struct{}
	once    sync.Once
}

func (p *closeReleasingPipe) Write([]byte) (int, error) {
	p.once.Do(func() { close(p.entered) })
	<-p.release
	return 0, io.ErrClosedPipe
}

func (p *closeReleasingPipe) Close() error {
	select {
	case <-p.release:
	default:
		close(p.release)
	}
	return nil
}

func TestProcessConcurrentSendCloseFailsFastAndReapsWriter(t *testing.T) {
	sh, err := exec.LookPath("sh")
	if err != nil {
		t.Skipf("sh not in PATH: %v", err)
	}
	proc, err := Start(context.Background(), ProcessOptions{Binary: sh, Args: []string{"-c", "read _"}, SendTimeout: 5 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	pipe := &closeReleasingPipe{entered: make(chan struct{}), release: make(chan struct{})}
	_ = proc.stdin.Close()
	proc.stdin = pipe

	inFlight := make(chan error, 1)
	go func() { inFlight <- proc.Send(map[string]any{"type": "blocked"}) }()
	select {
	case <-pipe.entered:
	case <-time.After(2 * time.Second):
		t.Fatal("send never entered the controlled writer")
	}

	closed := make(chan error, 1)
	go func() { closed <- proc.Close() }()
	select {
	case <-proc.writerClose:
	case <-time.After(2 * time.Second):
		t.Fatal("Close did not publish writer shutdown")
	}

	start := time.Now()
	err = proc.Send(map[string]any{"type": "after-close"})
	if err == nil {
		t.Fatal("Send after close began returned nil")
	}
	if elapsed := time.Since(start); elapsed >= time.Second {
		t.Fatalf("Send after close waited %v instead of failing immediately", elapsed)
	}
	select {
	case err := <-inFlight:
		if err == nil {
			t.Fatal("in-flight Send returned nil during close")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("in-flight Send was not released by closing stdin")
	}
	select {
	case err := <-closed:
		if err != nil && !errors.Is(err, context.Canceled) {
			t.Fatalf("Close: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Close did not reap process and writer")
	}
	select {
	case <-proc.writerDone:
	default:
		t.Fatal("writer was not reaped")
	}
}
