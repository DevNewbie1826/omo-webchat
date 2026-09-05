//go:build windows

package omorpc

import (
	"bytes"
	"context"
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Microsoft/go-winio"
)

func TestWindowsEnsureHelper(t *testing.T) {
	path := os.Getenv("OMORPC_PIPE_HELPER")
	if path == "" {
		return
	}
	secret, err := os.ReadFile(path + ".secret")
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(append([]byte(strings.ToLower(filepath.Clean(path))), secret...))
	listener, err := winio.ListenPipe(fmt.Sprintf(`\\.\pipe\senpi-rpc-%x`, sum[:16]), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	for {
		conn, err := listener.Accept()
		if err != nil {
			t.Fatal(err)
		}
		go serveProductionPipe(conn, secret)
	}
}

func pipeEnsureConfig(t *testing.T) EnsureConfig {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "rpc.sock")
	return EnsureConfig{
		AgentDir: dir, SocketPath: path, StateDir: dir, BinaryPath: os.Args[0],
		ArgsTemplate: []string{"-test.run=^TestWindowsEnsureHelper$"},
		Env:          append(os.Environ(), "OMORPC_PIPE_HELPER="+path, "OMO_RUNTIME=node"),
		ReadyTimeout: 5 * time.Second, ProbeTimeout: time.Second,
	}
}

func TestWindowsEnsureFreshSecretReuseAndOwnedStop(t *testing.T) {
	cfg := pipeEnsureConfig(t)
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	owned, err := EnsureDaemon(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := owned.StopBounded(5 * time.Second); err != nil {
			t.Error(err)
		}
	})
	if !owned.Owned {
		t.Fatal("fresh supervisor was not identified as a job member")
	}
	secret, err := os.ReadFile(cfg.SocketPath + ".secret")
	if err != nil || len(secret) != 32 {
		t.Fatalf("secret length=%d error=%v", len(secret), err)
	}
	shared, err := EnsureDaemon(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	if shared.Owned {
		t.Fatal("shared supervisor ownership claimed")
	}
	if err := shared.StopBounded(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	if _, err := owned.Client.Call(ctx, GetProtocolInfo{}); err != nil {
		t.Fatalf("shared Stop killed owner: %v", err)
	}
	if err := owned.StopBounded(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	after, err := os.ReadFile(cfg.SocketPath + ".secret")
	if err != nil || !bytes.Equal(secret, after) {
		t.Fatalf("owned Stop changed shared secret: %v", err)
	}
	t.Log("cleanup: owned job drained; shared secret preserved")
}

func TestWindowsReconnectReadsReplacementSecret(t *testing.T) {
	d := newMockDaemon(t)
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	c, err := Dial(ctx, d.SocketPath())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	before, err := os.ReadFile(d.SocketPath() + ".secret")
	if err != nil {
		t.Fatal(err)
	}
	events := c.Events()
	d.Restart()
	select {
	case <-events:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	after, err := os.ReadFile(d.SocketPath() + ".secret")
	if err != nil || bytes.Equal(before, after) {
		t.Fatal("fixture did not replace secret")
	}
	if _, err := c.Call(ctx, GetProtocolInfo{}); err != nil {
		t.Fatalf("reconnect with changed secret: %v", err)
	}
}
