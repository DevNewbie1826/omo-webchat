package omorpc

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"syscall"
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
	if mode != "serve" && mode != "serve-ignore-term" {
		t.Fatalf("unknown helper mode %q", mode)
	}
	if mode == "serve-ignore-term" {
		signal.Ignore(syscall.SIGTERM)
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
			capabilities := []string{capMultiSession}
			for _, capability := range strings.Split(os.Getenv("SENPI_RPC_CLIENT_CAPABILITIES"), ",") {
				if strings.TrimSpace(capability) == capExtensionEvents {
					capabilities = append(capabilities, capExtensionEvents)
					break
				}
			}
			response["data"] = map[string]any{
				"protocolVersion": 1,
				"serverVersion":   "fake-supervisor-1",
				"capabilities":    capabilities,
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

func TestEnsureDaemonMergesExtensionCapabilityIntoSpawnEnv(t *testing.T) {
	dir := shortEnsureTempDir(t)
	socket := filepath.Join(dir, "rpc", "rpc.sock")
	cfg := helperEnsureConfig(dir, socket, helperSupervisorScript(t), "serve")
	cfg.Env = append(cfg.Env, "SENPI_RPC_CLIENT_CAPABILITIES=custom_events")

	ensured, err := EnsureDaemon(context.Background(), cfg)
	if err != nil {
		t.Fatalf("EnsureDaemon: %v", err)
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), testAwaitTimeout)
		defer cancel()
		_ = ensured.Stop(ctx)
	}()
	if !slices.Contains(ensured.ProtocolInfo.Capabilities, capExtensionEvents) {
		t.Fatalf("spawned capabilities = %v, want extension_events", ensured.ProtocolInfo.Capabilities)
	}
}

func TestEnsureLockStaleReclaimAndEndpointScope(t *testing.T) {
	dir := shortEnsureTempDir(t)
	cfgA := EnsureConfig{AgentDir: dir, SocketPath: filepath.Join(dir, "a.sock"), LockTimeout: testAwaitTimeout, LockRetry: time.Millisecond}
	cfgB := cfgA
	cfgB.SocketPath = filepath.Join(dir, "b.sock")
	if ensureLockPath(cfgA) == ensureLockPath(cfgB) {
		t.Fatal("ensure lock must be keyed by SocketPath")
	}
	for _, stale := range []string{"not-a-pid\n", "99999999\n"} {
		path := ensureLockPath(cfgA)
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(stale), 0o600); err != nil {
			t.Fatal(err)
		}
		lock, err := acquireEnsureLock(context.Background(), cfgA)
		if err != nil {
			t.Fatalf("reclaim stale lock %q: %v", strings.TrimSpace(stale), err)
		}
		releaseEnsureLock(lock, path)
	}
}

func TestEnsureDaemonConcurrentSingleSpawn(t *testing.T) {
	dir := shortEnsureTempDir(t)
	socket := filepath.Join(dir, "rpc", "rpc.sock")
	marker := filepath.Join(dir, "spawns")
	script := writeFakeSupervisor(t, fmt.Sprintf("echo spawn >> %q\nexec \"$OMORPC_ENSURE_TEST_BINARY\" -test.run='^TestEnsureHelperProcess$'", marker))
	cfg := helperEnsureConfig(dir, socket, script, "serve")

	start := make(chan struct{})
	results := make(chan struct {
		d   *EnsuredDaemon
		err error
	}, 2)
	for i := 0; i < 2; i++ {
		go func() {
			<-start
			d, err := EnsureDaemon(context.Background(), cfg)
			results <- struct {
				d   *EnsuredDaemon
				err error
			}{d, err}
		}()
	}
	close(start)
	var daemons []*EnsuredDaemon
	for i := 0; i < 2; i++ {
		result := <-results
		if result.err != nil {
			t.Fatalf("concurrent EnsureDaemon: %v", result.err)
		}
		daemons = append(daemons, result.d)
	}
	data, err := os.ReadFile(marker)
	if err != nil {
		t.Fatalf("read spawn marker: %v", err)
	}
	if got := strings.Count(string(data), "spawn\n"); got != 1 {
		t.Fatalf("supervisor spawn count = %d, want exactly 1", got)
	}
	for _, daemon := range daemons {
		if daemon.Owned {
			ctx, cancel := context.WithTimeout(context.Background(), testAwaitTimeout)
			if err := daemon.Stop(ctx); err != nil {
				t.Errorf("stop owner: %v", err)
			}
			cancel()
		} else {
			_ = daemon.Close()
		}
	}
}

func TestEnsureLockSameSocketDifferentAgentDirsSingleSpawn(t *testing.T) {
	dir := shortEnsureTempDir(t)
	socket := filepath.Join(dir, "rpc", "rpc.sock")
	marker := filepath.Join(dir, "spawns")
	script := writeFakeSupervisor(t, fmt.Sprintf("echo spawn >> %q\nexec \"$OMORPC_ENSURE_TEST_BINARY\" -test.run='^TestEnsureHelperProcess$'", marker))
	cfgA := helperEnsureConfig(filepath.Join(dir, "agent-a"), socket, script, "serve")
	cfgB := helperEnsureConfig(filepath.Join(dir, "agent-b"), socket, script, "serve")

	start := make(chan struct{})
	results := make(chan struct {
		d   *EnsuredDaemon
		err error
	}, 2)
	for _, cfg := range []EnsureConfig{cfgA, cfgB} {
		cfg := cfg
		go func() {
			<-start
			d, err := EnsureDaemon(context.Background(), cfg)
			results <- struct {
				d   *EnsuredDaemon
				err error
			}{d, err}
		}()
	}
	close(start)

	var daemons []*EnsuredDaemon
	for i := 0; i < 2; i++ {
		result := <-results
		if result.err != nil {
			t.Fatalf("concurrent EnsureDaemon: %v", result.err)
		}
		daemons = append(daemons, result.d)
	}
	data, err := os.ReadFile(marker)
	if err != nil {
		t.Fatalf("read spawn marker: %v", err)
	}
	if got := strings.Count(string(data), "spawn\n"); got != 1 {
		t.Fatalf("supervisor spawn count = %d, want exactly 1", got)
	}
	stopEnsuredDaemons(t, daemons)
}

func TestEnsureDaemonStaleLockRaceSingleSpawn(t *testing.T) {
	dir := shortEnsureTempDir(t)
	socket := filepath.Join(dir, "rpc", "rpc.sock")
	marker := filepath.Join(dir, "spawns")
	startedFIFO := filepath.Join(dir, "started.fifo")
	releaseFIFO := filepath.Join(dir, "release.fifo")
	for _, path := range []string{startedFIFO, releaseFIFO} {
		if err := syscall.Mkfifo(path, 0o600); err != nil {
			t.Fatalf("mkfifo %s: %v", path, err)
		}
	}
	script := writeFakeSupervisor(t, fmt.Sprintf(
		"echo spawn >> %q\nprintf started > %q\nIFS= read -r _ < %q\nexec \"$OMORPC_ENSURE_TEST_BINARY\" -test.run='^TestEnsureHelperProcess$'",
		marker, startedFIFO, releaseFIFO,
	))
	cfg := helperEnsureConfig(dir, socket, script, "serve")
	lockPath := ensureLockPath(cfg)
	if err := os.MkdirAll(filepath.Dir(lockPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(lockPath, []byte("99999999\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	started := make(chan error, 1)
	go func() {
		data, err := os.ReadFile(startedFIFO)
		if err == nil && string(data) != "started" {
			err = fmt.Errorf("startup signal = %q, want started", data)
		}
		started <- err
	}()

	const callers = 16
	start := make(chan struct{})
	results := make(chan struct {
		d   *EnsuredDaemon
		err error
	}, callers)
	for i := 0; i < callers; i++ {
		go func() {
			<-start
			d, err := EnsureDaemon(context.Background(), cfg)
			results <- struct {
				d   *EnsuredDaemon
				err error
			}{d, err}
		}()
	}
	close(start)
	if err := <-started; err != nil {
		t.Fatal(err)
	}

	data, err := os.ReadFile(marker)
	if err != nil {
		t.Fatalf("read spawn marker: %v", err)
	}
	if got := strings.Count(string(data), "spawn\n"); got != 1 {
		t.Fatalf("supervisor spawn count before readiness = %d, want exactly 1", got)
	}
	locks, err := filepath.Glob(filepath.Join(filepath.Dir(socket), "*.ensure.lock"))
	if err != nil {
		t.Fatal(err)
	}
	if len(locks) != 1 || locks[0] != lockPath {
		t.Fatalf("live ensure locks = %v, want exactly %q", locks, lockPath)
	}
	if err := os.WriteFile(releaseFIFO, []byte("ready\n"), 0o600); err != nil {
		t.Fatalf("release supervisor: %v", err)
	}

	daemons := make([]*EnsuredDaemon, 0, callers)
	for i := 0; i < callers; i++ {
		result := <-results
		if result.err != nil {
			t.Fatalf("concurrent EnsureDaemon: %v", result.err)
		}
		daemons = append(daemons, result.d)
	}
	data, err = os.ReadFile(marker)
	if err != nil {
		t.Fatalf("read final spawn marker: %v", err)
	}
	if got := strings.Count(string(data), "spawn\n"); got != 1 {
		t.Fatalf("supervisor spawn count = %d, want exactly 1", got)
	}
	if locks, err = filepath.Glob(filepath.Join(filepath.Dir(socket), "*.ensure.lock")); err != nil || len(locks) != 0 {
		t.Fatalf("orphan ensure locks = %v, err=%v", locks, err)
	}
	stopEnsuredDaemons(t, daemons)
}

func stopEnsuredDaemons(t *testing.T, daemons []*EnsuredDaemon) {
	t.Helper()
	for _, daemon := range daemons {
		if daemon.Owned {
			ctx, cancel := context.WithTimeout(context.Background(), testAwaitTimeout)
			err := daemon.Stop(ctx)
			cancel()
			if err != nil {
				t.Errorf("stop owner: %v", err)
			}
		} else {
			_ = daemon.Close()
		}
	}
}

func TestEnsureDaemonLiveHandshakeTimeoutDoesNotSpawnOrUnlink(t *testing.T) {
	dir := shortEnsureTempDir(t)
	socket := filepath.Join(dir, "live.sock")
	ln, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	accepted := make(chan net.Conn, 1)
	go func() {
		conn, err := ln.Accept()
		if err == nil {
			accepted <- conn
		}
	}()
	marker := filepath.Join(dir, "spawned")
	script := writeFakeSupervisor(t, fmt.Sprintf("echo spawned > %q", marker))
	_, err = EnsureDaemon(context.Background(), EnsureConfig{
		AgentDir: dir, SocketPath: socket, BinaryPath: script,
		ProbeTimeout: 50 * time.Millisecond, LockTimeout: testAwaitTimeout,
	})
	if err == nil {
		t.Fatal("handshake timeout against live endpoint must fail")
	}
	select {
	case conn := <-accepted:
		_ = conn.Close()
	case <-time.After(testAwaitTimeout):
		t.Fatal("probe never connected to live endpoint")
	}
	if _, err := os.Stat(marker); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("supervisor spawned after live handshake timeout: %v", err)
	}
	if _, err := os.Stat(socket); err != nil {
		t.Fatalf("live endpoint was unlinked: %v", err)
	}
}

func TestEnsureDaemonDoesNotUnlinkReplacementEndpoint(t *testing.T) {
	dir := shortEnsureTempDir(t)
	socket := filepath.Join(dir, "replacement.sock")
	if err := os.WriteFile(socket, []byte("replacement"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg := helperEnsureConfig(dir, socket, helperSupervisorScript(t), "die")
	_, _ = EnsureDaemon(context.Background(), cfg)
	data, err := os.ReadFile(socket)
	if err != nil || string(data) != "replacement" {
		t.Fatalf("replacement endpoint changed: data=%q err=%v", data, err)
	}
}

func TestEnsuredDaemonStopEscalatesAfterCanceledWait(t *testing.T) {
	dir := shortEnsureTempDir(t)
	socket := filepath.Join(dir, "rpc", "rpc.sock")
	cfg := helperEnsureConfig(dir, socket, helperSupervisorScript(t), "serve-ignore-term")
	ensured, err := EnsureDaemon(context.Background(), cfg)
	if err != nil {
		t.Fatalf("EnsureDaemon: %v", err)
	}
	canceled, cancel := context.WithCancel(context.Background())
	cancel()
	if err := ensured.Stop(canceled); !errors.Is(err, context.Canceled) {
		t.Fatalf("first Stop = %v, want context.Canceled", err)
	}
	waitCtx, waitCancel := context.WithTimeout(context.Background(), 6*time.Second)
	defer waitCancel()
	if err := ensured.Stop(waitCtx); err != nil {
		t.Fatalf("Stop did not complete SIGKILL escalation: %v", err)
	}
	if err := ensured.process.Signal(syscall.Signal(0)); !errors.Is(err, os.ErrProcessDone) {
		t.Fatalf("SIGTERM-ignoring supervisor remains alive after Stop: %v", err)
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
