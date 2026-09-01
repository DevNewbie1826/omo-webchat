package omorpc

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

const ensureHelperModeEnv = "OMORPC_ENSURE_HELPER_MODE"

// TestEnsureHelperProcess is exec'd by the fake supervisor shell script. In
// the normal test process it is a no-op; in helper mode it either exits
// before readiness or serves the minimum real JSONL protocol needed by the
// ensure probe and a post-start client call.
func TestEnsureHelperProcess(t *testing.T) {
	mode := os.Getenv(ensureHelperModeEnv)
	if mode == "" {
		return
	}
	if mode == "die" {
		os.Exit(7)
	}
	if mode != "serve" {
		t.Fatalf("unknown helper mode %q", mode)
	}

	socket := os.Getenv("OMORPC_ENSURE_HELPER_SOCKET")
	_ = os.Remove(socket)
	ln, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatalf("helper listen: %v", err)
	}
	defer ln.Close()
	for {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		go serveEnsureHelper(conn)
	}
}

func serveEnsureHelper(conn net.Conn) {
	defer conn.Close()
	scanner := bufio.NewScanner(conn)
	for scanner.Scan() {
		var request map[string]any
		if json.Unmarshal(scanner.Bytes(), &request) != nil {
			continue
		}
		id, _ := request["id"].(string)
		command, _ := request["type"].(string)
		response := map[string]any{
			"id": id, "type": "response", "command": command, "success": true,
		}
		switch command {
		case CmdGetProtocolInfo:
			response["data"] = map[string]any{
				"protocolVersion": 1,
				"serverVersion":   "fake-supervisor-1",
				"capabilities":    []string{capMultiSession, capExtensionEvents},
				"mode":            "multi",
			}
		case CmdListSessions:
			response["data"] = map[string]any{"sessions": []any{}}
		default:
			response["success"] = false
			response["error"] = "unknown_command: " + command
		}
		frame, err := EncodeFrame(response)
		if err == nil {
			_, _ = conn.Write(frame)
		}
	}
	if scanner.Err() != nil {
		return
	}
}

func TestEnsureDaemonExistingCompatibleReused(t *testing.T) {
	d := newMockDaemon(t)
	marker := filepath.Join(t.TempDir(), "spawned")
	script := writeFakeSupervisor(t, fmt.Sprintf("echo spawned > %q\nexit 99", marker))

	ensured, err := EnsureDaemon(context.Background(), EnsureConfig{
		AgentDir:        t.TempDir(),
		SocketPath:      d.SocketPath(),
		BinaryPath:      script,
		ExpectedVersion: "newer-client-version",
	})
	if err != nil {
		t.Fatalf("EnsureDaemon: %v", err)
	}
	t.Cleanup(func() { _ = ensured.Close() })
	if ensured.Owned {
		t.Fatal("existing compatible daemon reported as owned")
	}
	if _, err := os.Stat(marker); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("supervisor was spawned while compatible daemon existed: %v", err)
	}
	if ensured.VersionWarning == "" || !strings.Contains(ensured.VersionWarning, "newer-client-version") {
		t.Fatalf("version mismatch warning = %q", ensured.VersionWarning)
	}
}

func TestEnsureDaemonMissingSocketSpawnsAndBecomesReady(t *testing.T) {
	dir := shortEnsureTempDir(t)
	socket := filepath.Join(dir, "rpc", "rpc.sock")
	script := helperSupervisorScript(t)
	cfg := helperEnsureConfig(dir, socket, script, "serve")

	ensured, err := EnsureDaemon(context.Background(), cfg)
	if err != nil {
		t.Fatalf("EnsureDaemon: %v", err)
	}
	if !ensured.Owned {
		t.Fatal("spawned daemon was not reported as owned")
	}
	if ensured.ProtocolInfo == nil || ensured.ProtocolInfo.ServerVersion != "fake-supervisor-1" {
		t.Fatalf("negotiated protocol info = %+v", ensured.ProtocolInfo)
	}
	resp, err := ensured.Client.Call(context.Background(), ListSessions{})
	if err != nil || resp == nil || !resp.Success {
		t.Fatalf("post-ensure RPC call: response=%+v err=%v", resp, err)
	}
	stopCtx, cancel := context.WithTimeout(context.Background(), testAwaitTimeout)
	defer cancel()
	if err := ensured.Stop(stopCtx); err != nil {
		t.Fatalf("Stop: %v", err)
	}
}

func TestEnsureDaemonIncompatibleCapabilities(t *testing.T) {
	d := newMockDaemon(t)
	d.SetCapabilities([]string{capMultiSession})

	ensured, err := EnsureDaemon(context.Background(), EnsureConfig{
		AgentDir:   t.TempDir(),
		SocketPath: d.SocketPath(),
		BinaryPath: filepath.Join(t.TempDir(), "must-not-be-resolved"),
	})
	if ensured != nil {
		_ = ensured.Close()
		t.Fatal("incompatible daemon returned a handle")
	}
	var incompatible *ErrIncompatibleDaemon
	if !errors.As(err, &incompatible) {
		t.Fatalf("EnsureDaemon error = %T (%v), want *ErrIncompatibleDaemon", err, err)
	}
	if len(incompatible.MissingCapabilities) != 1 || incompatible.MissingCapabilities[0] != capExtensionEvents {
		t.Fatalf("missing capabilities = %v", incompatible.MissingCapabilities)
	}
}

func TestEnsureDaemonSupervisorDiesWithoutSocket(t *testing.T) {
	dir := shortEnsureTempDir(t)
	socket := filepath.Join(dir, "rpc", "rpc.sock")
	cfg := helperEnsureConfig(dir, socket, helperSupervisorScript(t), "die")
	cfg.ReadyTimeout = testAwaitTimeout

	started := time.Now()
	ensured, err := EnsureDaemon(context.Background(), cfg)
	if ensured != nil {
		_ = ensured.Close()
		t.Fatal("dead supervisor returned a handle")
	}
	if err == nil || !strings.Contains(err.Error(), "exited before readiness") {
		t.Fatalf("EnsureDaemon error = %v, want bounded supervisor-exit failure", err)
	}
	if elapsed := time.Since(started); elapsed >= cfg.ReadyTimeout {
		t.Fatalf("supervisor death was not observed promptly: %v", elapsed)
	}
}

func helperEnsureConfig(dir, socket, script, mode string) EnsureConfig {
	return EnsureConfig{
		AgentDir:     dir,
		SocketPath:   socket,
		BinaryPath:   script,
		ReadyTimeout: testAwaitTimeout,
		ProbeTimeout: 100 * time.Millisecond,
		LockTimeout:  testAwaitTimeout,
		LockRetry:    10 * time.Millisecond,
		Env: append(os.Environ(),
			ensureHelperModeEnv+"="+mode,
			"OMORPC_ENSURE_HELPER_SOCKET="+socket,
			"OMORPC_ENSURE_TEST_BINARY="+os.Args[0],
		),
	}
}

func helperSupervisorScript(t *testing.T) string {
	t.Helper()
	return writeFakeSupervisor(t, `exec "$OMORPC_ENSURE_TEST_BINARY" -test.run='^TestEnsureHelperProcess$'`)
}

func writeFakeSupervisor(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "fake-supervisor.sh")
	contents := "#!/bin/sh\n" + body + "\n"
	if err := os.WriteFile(path, []byte(contents), 0o700); err != nil {
		t.Fatalf("write fake supervisor: %v", err)
	}
	return path
}

func shortEnsureTempDir(t *testing.T) string {
	t.Helper()
	base := os.TempDir()
	if runtime.GOOS == "darwin" {
		base = "/tmp"
	}
	dir, err := os.MkdirTemp(base, "oe-*")
	if err != nil {
		t.Fatalf("ensure temp dir: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	return dir
}
