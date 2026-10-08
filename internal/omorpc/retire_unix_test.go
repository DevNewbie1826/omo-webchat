//go:build darwin || linux

package omorpc

import (
	"errors"
	"net"
	"os"
	"path/filepath"
	"testing"
)

func shortSocketPath(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "retire-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	return filepath.Join(dir, "rpc.sock")
}

func TestRetireUnownedEngineIgnoresMissingEndpoint(t *testing.T) {
	if err := RetireUnownedEngine(t.Context(), shortSocketPath(t)); err != nil {
		t.Fatalf("missing endpoint = %v, want nil", err)
	}
}

func TestRetireUnownedEngineRemovesStaleSocket(t *testing.T) {
	path := shortSocketPath(t)
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: path, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	listener.SetUnlinkOnClose(false)
	_ = listener.Close()

	if err := RetireUnownedEngine(t.Context(), path); err != nil {
		t.Fatalf("stale socket = %v, want nil", err)
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("stale socket still present: %v", err)
	}
}

func TestRetireUnownedEngineRefusesNonEnginePeer(t *testing.T) {
	path := shortSocketPath(t)
	listener, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			_ = conn.Close()
		}
	}()

	if err := RetireUnownedEngine(t.Context(), path); !errors.Is(err, ErrDaemonNotOwned) {
		t.Fatalf("non-engine peer = %v, want ErrDaemonNotOwned", err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("refused peer socket must stay: %v", err)
	}
}
