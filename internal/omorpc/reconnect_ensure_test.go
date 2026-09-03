package omorpc_test

// Regression coverage for reconnecting while the daemon socket FILE is
// missing: the observed runtime state where the supervisor may still be
// alive but every dial fails with "connect: no such file or directory"
// (errors.Is(err, os.ErrNotExist)). With the OnDialNotExist hook configured,
// the client asks the embedder to restore the endpoint once per reconnect
// flight and the next retry dials the recreated socket; with the hook nil or
// failing, today's bounded-retry behavior is unchanged.

import (
	"context"
	"errors"
	"os"
	"sync/atomic"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc/omorpctest"
)

func newRecoverDaemon(t *testing.T) *omorpctest.Daemon {
	t.Helper()
	// macOS caps unix socket paths at 104 bytes; use a short temp dir for
	// the socket and register cleanup with the test.
	dir, err := os.MkdirTemp("", "omorpc-rc-*")
	if err != nil {
		t.Fatalf("temp dir: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	d := omorpctest.New(dir)
	if err := d.Start(); err != nil {
		t.Fatalf("start daemon: %v", err)
	}
	t.Cleanup(d.Stop)
	return d
}

// awaitEpochClosed waits for the live epoch's event stream to close, the
// client-side signal that the transport epoch was invalidated.
func awaitEpochClosed(t *testing.T, events <-chan *omorpc.Event) {
	t.Helper()
	select {
	case <-events:
	case <-time.After(5 * time.Second):
		t.Fatal("connection epoch was not invalidated after the daemon stopped")
	}
}

// requireSocketAbsent pins the test precondition: the socket path is gone,
// so reconnect dials fail with os.ErrNotExist instead of ECONNREFUSED.
func requireSocketAbsent(t *testing.T, path string) {
	t.Helper()
	if _, err := os.Stat(path); err == nil {
		t.Fatalf("socket file %s still exists; precondition is a missing socket path", path)
	} else if !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("stat %s: %v", path, err)
	}
}

func missingSocketClient(t *testing.T, d *omorpctest.Daemon, cfg omorpc.Config) *omorpc.Client {
	t.Helper()
	cfg.ReconnectInitial = 5 * time.Millisecond
	cfg.ReconnectMax = 5 * time.Millisecond
	cfg.ReconnectMaxAttempts = 2
	client, err := omorpc.DialWithConfig(context.Background(), d.SocketPath(), cfg)
	if err != nil {
		t.Fatalf("initial dial: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })

	// Stop the daemon: the listener close unlinks the socket path and every
	// live connection dies, reproducing the missing-socket state.
	_, events := client.CurrentEpoch()
	d.Stop()
	awaitEpochClosed(t, events)
	requireSocketAbsent(t, d.SocketPath())
	return client
}

// TestReconnectRecoversMissingSocketViaOnDialNotExist: the daemon socket
// file disappears mid-connection; the OnDialNotExist hook recreates a
// listener at the same path; the in-flight reconnect dials the restored
// endpoint and the next call completes a full protocol roundtrip.
func TestReconnectRecoversMissingSocketViaOnDialNotExist(t *testing.T) {
	d := newRecoverDaemon(t)

	var hookCalls atomic.Int32
	hook := func(ctx context.Context) error {
		hookCalls.Add(1)
		return d.Start() // re-listens at the same socket path
	}
	client := missingSocketClient(t, d, omorpc.Config{OnDialNotExist: hook})

	callCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	resp, err := client.Call(callCtx, omorpc.GetProtocolInfo{})
	if err != nil {
		t.Fatalf("call after socket restore: %v", err)
	}
	if !resp.Success {
		t.Errorf("call after socket restore: response = %+v, want success", resp)
	}
	if got := hookCalls.Load(); got < 1 {
		t.Errorf("OnDialNotExist hook calls = %d, want at least 1", got)
	}
	if client.ProtocolInfo() == nil {
		t.Error("ProtocolInfo() = nil after recovery, want renegotiated handshake info")
	}
}

// TestReconnectHookErrorIgnoredByRetryLoop: a failing hook is logged-and-
// ignored territory for the dial path — it runs at most once per reconnect
// flight and the flight still exhausts its attempt budget with the typed
// ErrDisconnected instead of panicking or looping forever.
func TestReconnectHookErrorIgnoredByRetryLoop(t *testing.T) {
	d := newRecoverDaemon(t)

	var hookCalls atomic.Int32
	hook := func(ctx context.Context) error {
		hookCalls.Add(1)
		return errors.New("hook restore failed")
	}
	client := missingSocketClient(t, d, omorpc.Config{OnDialNotExist: hook})

	callCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	resp, err := client.Call(callCtx, omorpc.GetProtocolInfo{})
	if !errors.Is(err, omorpc.ErrDisconnected) {
		t.Fatalf("call with failing hook: err = %v, want ErrDisconnected", err)
	}
	if resp != nil {
		t.Errorf("call with failing hook: response = %+v, want nil", resp)
	}
	if got := hookCalls.Load(); got != 1 {
		t.Errorf("hook calls = %d, want exactly 1 (at most once per reconnect flight)", got)
	}
}

// TestReconnectMissingSocketNilHookKeepsBehavior: a zero-value OnDialNotExist
// keeps today's behavior exactly — a missing socket path exhausts the retry
// budget and surfaces ErrDisconnected, with no hook involved.
func TestReconnectMissingSocketNilHookKeepsBehavior(t *testing.T) {
	d := newRecoverDaemon(t)
	client := missingSocketClient(t, d, omorpc.Config{})

	callCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, err := client.Call(callCtx, omorpc.GetProtocolInfo{}); !errors.Is(err, omorpc.ErrDisconnected) {
		t.Fatalf("call with nil hook: err = %v, want ErrDisconnected", err)
	}
}
