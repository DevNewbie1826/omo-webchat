//go:build windows

package omorpc

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestWindowsWrongHandshakeRejected(t *testing.T) {
	controlCleanupReceipt(t)
	path := productionPipeFixtureAt(t, filepath.Join(t.TempDir(), "rpc.sock"), bytes.Repeat([]byte{1}, 32), bytes.Repeat([]byte{2}, 32))
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	c, err := Dial(ctx, path)
	if c != nil {
		c.Close()
		t.Fatal("CONTROL_ASSERT wrong_secret wrong raw handshake accepted")
	}
	if err == nil || isSpawnableProbeError(err) {
		t.Fatalf("wrong auth should fail without permission to spawn: %v", err)
	}
}

func TestWindowsOwnedStopPreservesReplacementEndpoint(t *testing.T) {
	controlCleanupReceipt(t)
	cfg := pipeEnsureConfig(t)
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	owner, err := EnsureDaemon(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := owner.StopBounded(5 * time.Second); err != nil {
			t.Error(err)
		}
	})
	if !owner.Owned {
		t.Fatal("fresh helper unowned")
	}
	secret := bytes.Repeat([]byte{3}, 32)
	productionPipeFixtureAt(t, cfg.SocketPath, secret, secret)
	if err := owner.StopBounded(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	preserved, readErr := os.ReadFile(cfg.SocketPath + ".secret")
	if readErr != nil || !bytes.Equal(preserved, secret) {
		t.Fatal("CONTROL_ASSERT replacement_endpoint owned Stop damaged replacement secret")
	}
	replacement, err := EnsureDaemon(ctx, cfg)
	if err != nil {
		t.Fatalf("replacement was damaged by owner Stop: %v", err)
	}
	defer replacement.Close()
	if replacement.Owned {
		t.Fatal("replacement became launch-owned")
	}
	after, err := os.ReadFile(cfg.SocketPath + ".secret")
	if err != nil || !bytes.Equal(after, secret) {
		t.Fatal("replacement secret changed")
	}
	if err := replacement.StopBounded(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	again, err := Dial(ctx, cfg.SocketPath)
	if err != nil {
		t.Fatalf("shared Stop damaged replacement: %v", err)
	}
	if err := again.Close(); err != nil {
		t.Fatal(err)
	}
	t.Log("cleanup: owned job drained; replacement pipe and secret remained usable")
}

func TestWindowsConcurrentEnsurePublishesOneSecretAndProducer(t *testing.T) {
	cfg := pipeEnsureConfig(t)
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	const callers = 4
	type result struct {
		daemon *EnsuredDaemon
		err    error
	}
	results := make(chan result, callers)
	start := make(chan struct{})
	for range callers {
		go func() { <-start; d, err := EnsureDaemon(ctx, cfg); results <- result{d, err} }()
	}
	close(start)
	owners := 0
	var pid uint32
	for range callers {
		select {
		case got := <-results:
			if got.err != nil {
				t.Error(got.err)
				continue
			}
			t.Cleanup(func() {
				if err := got.daemon.StopBounded(5 * time.Second); err != nil {
					t.Error(err)
				}
			})
			if got.daemon.Owned {
				owners++
			}
			got.daemon.Client.mu.Lock()
			observed := got.daemon.Client.current.conn.(*identifiedPipe).pid
			got.daemon.Client.mu.Unlock()
			if pid == 0 {
				pid = observed
			} else if observed != pid {
				t.Error("concurrent ensure started a second producer")
			}
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
	if owners != 1 {
		t.Fatalf("owned producers=%d, want 1", owners)
	}
}
