//go:build darwin || linux

package omorpc

import (
	"context"
	"errors"
	"io"
	"net"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

type ensureGate struct {
	control net.Conn
	done    chan struct{}
	daemon  *EnsuredDaemon
	err     error
}

// A real child connection proves the supervisor started before the competing
// listener is installed. The child then blocks on I/O, not a scheduling sleep.
func startEnsureGate(t *testing.T, dir, socket string) *ensureGate {
	t.Helper()
	controlPath := filepath.Join(dir, "control.sock")
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: controlPath, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	defer closeEnsureFixture(t, listener)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	gate := &ensureGate{done: make(chan struct{})}
	t.Cleanup(func() {
		cancel()
		if gate.control != nil {
			closeEnsureFixture(t, gate.control)
		}
		select {
		case <-gate.done:
			if gate.daemon != nil {
				if err := gate.daemon.StopBounded(5 * time.Second); err != nil {
					t.Error(err)
				}
			}
		case <-time.After(10 * time.Second):
			t.Error("ensure flight did not stop")
		}
	})
	cfg := helperEnsureConfig(dir, socket, helperSupervisorScript(t), "await-control")
	cfg.Env = setEnv(cfg.Env, "OMORPC_ENSURE_CONTROL", controlPath)
	cfg.Env = setEnv(cfg.Env, "OMO_RUNTIME", "node")
	cfg.ReadyTimeout = 10 * time.Second
	cfg.LockTimeout = 10 * time.Second
	go func() { gate.daemon, gate.err = EnsureDaemon(ctx, cfg); close(gate.done) }()
	deadline, _ := ctx.Deadline()
	if err := listener.SetDeadline(deadline); err != nil {
		t.Fatal(err)
	}
	gate.control, err = listener.Accept()
	if err != nil {
		t.Fatalf("supervisor start event: %v", err)
	}
	return gate
}

func serveForeignEndpoint(t *testing.T, path string, serve func(net.Conn)) <-chan struct{} {
	t.Helper()
	listener, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	observed := make(chan struct{}, 1)
	var mu sync.Mutex
	connections := make(map[net.Conn]struct{})
	stopped := false
	var workers sync.WaitGroup
	workers.Add(1)
	go func() {
		defer workers.Done()
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			mu.Lock()
			if stopped {
				closeEnsureFixture(t, conn)
				mu.Unlock()
				return
			}
			connections[conn] = struct{}{}
			workers.Add(1)
			mu.Unlock()
			select {
			case observed <- struct{}{}:
			default:
			}
			go func() {
				defer workers.Done()
				defer func() { closeEnsureFixture(t, conn); mu.Lock(); delete(connections, conn); mu.Unlock() }()
				serve(conn)
			}()
		}
	}()
	t.Cleanup(func() {
		mu.Lock()
		stopped = true
		closeEnsureFixture(t, listener)
		for conn := range connections {
			closeEnsureFixture(t, conn)
		}
		mu.Unlock()
		done := make(chan struct{})
		go func() { workers.Wait(); close(done) }()
		select {
		case <-done:
			t.Log("cleanup: foreign listener workers joined")
		case <-time.After(5 * time.Second):
			t.Error("foreign listener did not stop")
		}
	})
	return observed
}

func closeEnsureFixture(t *testing.T, closer io.Closer) {
	t.Helper()
	if err := closer.Close(); err != nil && !errors.Is(err, net.ErrClosed) {
		t.Error(err)
	}
}
