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
	"testing"
	"time"

	"github.com/Microsoft/go-winio"
)

// This diagnostic asserts the old production defects before the transport fix.
// The same live pipe fixture becomes the positive regression in the fix commit.
func TestWindowsProductionRED(t *testing.T) {
	t.Run("client_transport", func(t *testing.T) {
		path := productionPipeFixture(t)
		ctx, cancel := context.WithTimeout(t.Context(), 2*time.Second)
		defer cancel()
		c, err := Dial(ctx, path)
		if c != nil {
			c.Close()
		}
		if err == nil {
			t.Fatal("RED not reproduced: production Dial unexpectedly passed")
		}
		t.Logf("RED: production Dial against authenticated named pipe: %v", err)
	})
	t.Run("readiness_without_socket_file", func(t *testing.T) {
		path := productionPipeFixture(t)
		ctx, cancel := context.WithTimeout(t.Context(), 2*time.Second)
		defer cancel()
		c, _, stable, peer, err := probeAuthenticatedDaemon(ctx, EnsureConfig{SocketPath: path, ProbeTimeout: time.Second}, os.Getpid())
		if c != nil {
			c.Close()
		}
		if err == nil && stable && peer == peerOwned {
			t.Fatal("RED not reproduced: pipe readiness unexpectedly passed")
		}
		t.Logf("RED: production readiness stable=%t peer=%d error=%v", stable, peer, err)
	})
	t.Run("unknown_peer", func(t *testing.T) {
		if !peerUnknownAccepted() {
			t.Fatal("RED not reproduced: unknown peer already rejected")
		}
		t.Log("RED: unverified peer is accepted as launch ownership evidence")
	})
}

func productionPipeFixture(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "rpc.sock")
	secret := bytes.Repeat([]byte{0x7b}, 32)
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
	t.Cleanup(func() {
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
			serveProductionPipe(conn, secret)
		}
	}()
	return path
}

func serveProductionPipe(conn net.Conn, secret []byte) {
	defer conn.Close()
	if err := conn.SetDeadline(time.Now().Add(2 * time.Second)); err != nil {
		return
	}
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
