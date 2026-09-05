//go:build windows

package omorpc

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Microsoft/go-winio"
)

// These contracts first ran as explicit defect diagnostics on the old transport.
func TestWindowsProduction(t *testing.T) {
	t.Run("client_transport", func(t *testing.T) {
		path := productionPipeFixture(t)
		ctx, cancel := context.WithTimeout(t.Context(), 2*time.Second)
		defer cancel()
		c, err := Dial(ctx, path)
		if c != nil {
			if err := c.Close(); err != nil {
				t.Error(err)
			}
		}
		if err != nil {
			t.Fatalf("production Dial: %v", err)
		}
	})
	t.Run("readiness_without_socket_file", func(t *testing.T) {
		path := productionPipeFixture(t)
		ctx, cancel := context.WithTimeout(t.Context(), 2*time.Second)
		defer cancel()
		c, _, stable, peer, err := probeAuthenticatedDaemon(ctx, EnsureConfig{SocketPath: path, ProbeTimeout: time.Second}, os.Getpid())
		if c != nil {
			if err := c.Close(); err != nil {
				t.Error(err)
			}
		}
		if err != nil || !stable || peer != peerForeign {
			t.Fatalf("readiness stable=%t peer=%d error=%v; fixture is not in a launched job", stable, peer, err)
		}
	})
	t.Run("unknown_peer", func(t *testing.T) {
		if peerUnknownAccepted() {
			t.Fatal("unverified peer accepted as launch ownership evidence")
		}
	})
}

func productionPipeFixture(t *testing.T) string {
	t.Helper()
	secret := bytes.Repeat([]byte{0x7b}, 32)
	return productionPipeFixtureAt(t, filepath.Join(t.TempDir(), "rpc.sock"), secret, secret)
}

func productionPipeFixtureAt(t *testing.T, path string, secret, accepted []byte) string {
	t.Helper()
	if err := os.WriteFile(path+".secret", secret, 0600); err != nil {
		t.Fatal(err)
	}
	// Independent implementation of the runtime's address contract, not the
	// production address function: mismatched normalization/auth must fail.
	digest := sha256.Sum256(append([]byte(strings.ToLower(filepath.Clean(path))), secret...))
	name := fmt.Sprintf(`\\.\pipe\senpi-rpc-%x`, digest[:16])
	listener, err := winio.ListenPipe(name, nil)
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	var mu sync.Mutex
	var active net.Conn
	closed := false
	t.Cleanup(func() {
		mu.Lock()
		closed = true
		if active != nil {
			if err := active.Close(); err != nil {
				t.Error(err)
			}
		}
		mu.Unlock()
		if err := listener.Close(); err != nil {
			t.Error(err)
		}
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Error("pipe fixture did not stop")
		}
	})
	go func() {
		defer close(done)
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			mu.Lock()
			if closed {
				conn.Close()
				mu.Unlock()
				return
			}
			active = conn
			mu.Unlock()
			serveProductionPipe(conn, accepted)
			mu.Lock()
			active = nil
			mu.Unlock()
		}
	}()
	return path
}

func serveProductionPipe(conn net.Conn, secret []byte) {
	defer conn.Close()
	got := make([]byte, 32)
	if _, err := io.ReadFull(conn, got); err != nil || !bytes.Equal(got, secret) {
		return
	}
	decoder := json.NewDecoder(conn)
	for {
		var req struct {
			ID   string `json:"id"`
			Type string `json:"type"`
		}
		if err := decoder.Decode(&req); err != nil {
			return
		}
		if err := json.NewEncoder(conn).Encode(map[string]any{
			"type": "response", "id": req.ID, "command": req.Type, "success": true,
			"data": ProtocolInfo{ProtocolVersion: 1, ServerVersion: "fixture", Capabilities: []string{"multi_session", "extension_events"}},
		}); err != nil {
			return
		}
	}
}
