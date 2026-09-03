package omorpc

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
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
	if mode == "descendant-ladder" {
		runtimeName := os.Getenv("OMO_RUNTIME")
		pidPath := os.Getenv("OMORPC_ENSURE_DESCENDANT_PID")
		if runtimeName != "node" {
			child := exec.Command("sleep", "60")
			if err := child.Start(); err != nil {
				t.Fatalf("helper start descendant: %v", err)
			}
			if err := os.WriteFile(pidPath, []byte(fmt.Sprint(child.Process.Pid)), 0o600); err != nil {
				t.Fatalf("helper write descendant pid: %v", err)
			}
			os.Exit(7)
		}
		pidData, err := os.ReadFile(pidPath)
		if err != nil {
			t.Fatalf("helper read descendant pid: %v", err)
		}
		var pid int
		if _, err := fmt.Sscan(string(pidData), &pid); err != nil {
			t.Fatalf("helper parse descendant pid: %v", err)
		}
		if err := syscall.Kill(pid, 0); !errors.Is(err, syscall.ESRCH) {
			t.Fatalf("automatic-attempt descendant %d survived into node attempt: %v", pid, err)
		}
		mode = "serve"
	}
	if mode == "supervised-drop" {
		socket := os.Getenv("OMORPC_ENSURE_HELPER_SOCKET")
		_ = os.Remove(socket)
		ln, err := net.Listen("unix", socket)
		if err != nil {
			t.Fatalf("supervised helper listen: %v", err)
		}
		ln.(*net.UnixListener).SetUnlinkOnClose(false)
		conn, err := ln.Accept()
		if err != nil {
			t.Fatalf("supervised helper accept: %v", err)
		}
		scanner := bufio.NewScanner(conn)
		_ = scanner.Scan()
		_ = conn.Close()
		_ = ln.Close()
		os.Exit(7)
	}
	if mode == "saturate-log" {
		_, _ = os.Stderr.Write(bytes.Repeat([]byte("x"), daemonSpawnLogLimit+1024))
		os.Exit(7)
	}
	if mode == "runtime-ladder" {
		runtimeName := os.Getenv("OMO_RUNTIME")
		if runtimeName == "" {
			runtimeName = "automatic"
		}
		marker := os.Getenv("OMORPC_ENSURE_RUNTIME_MARKER")
		file, err := os.OpenFile(marker, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
		if err != nil {
			t.Fatalf("helper open runtime marker: %v", err)
		}
		_, _ = fmt.Fprintln(file, runtimeName)
		_ = file.Close()
		socket := os.Getenv("OMORPC_ENSURE_HELPER_SOCKET")
		if runtimeName != "node" {
			_ = os.Remove(socket)
			ln, err := net.Listen("unix", socket)
			if err != nil {
				t.Fatalf("helper create stale socket: %v", err)
			}
			ln.(*net.UnixListener).SetUnlinkOnClose(false)
			ownershipConn, err := ln.Accept()
			if err != nil {
				t.Fatalf("helper accept ownership probe: %v", err)
			}
			_ = ownershipConn.Close()
			probeConn, err := ln.Accept()
			if err != nil {
				t.Fatalf("helper accept readiness probe: %v", err)
			}
			scanner := bufio.NewScanner(probeConn)
			_ = scanner.Scan()
			_ = probeConn.Close()
			_ = ln.Close()
			os.Exit(7)
		}
		if _, err := os.Lstat(socket); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("stale socket was not removed before node attempt: %v", err)
		}
		if err := os.WriteFile(os.Getenv("OMORPC_ENSURE_CLEANUP_MARKER"), []byte("clean"), 0o600); err != nil {
			t.Fatalf("helper write cleanup marker: %v", err)
		}
		mode = "serve"
	}
	if mode == "flock-exit" {
		path := os.Getenv("OMORPC_ENSURE_HELPER_LOCK_PATH")
		file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
		if err != nil {
			t.Fatalf("helper open lock: %v", err)
		}
		if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX); err != nil {
			t.Fatalf("helper flock: %v", err)
		}
		_, _ = fmt.Fprintln(os.Stdout, "lock held")
		os.Exit(0) // The kernel, not stale-content recovery, releases the flock.
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
	ln.(*net.UnixListener).SetUnlinkOnClose(false)
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
	cfg.ReadyTimeout = 10 * time.Second

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

func TestEnsureExtensionEventsCapabilityNilInheritsEnvironment(t *testing.T) {
	if got := EnsureExtensionEventsCapability(nil); got != nil {
		t.Fatalf("EnsureExtensionEventsCapability(nil) = %#v, want nil for os/exec inheritance", got)
	}
}

func TestEnsureExtensionEventsCapabilityNormalizesValues(t *testing.T) {
	env := EnsureExtensionEventsCapability([]string{
		"SENPI_RPC_CLIENT_CAPABILITIES= native_only, ,native_only, extension_events,",
		"OMO_RPC_CLIENT_CAPABILITIES=custom_only,, custom_only ",
	})
	for key, want := range map[string]string{
		"SENPI_RPC_CLIENT_CAPABILITIES": "native_only,extension_events",
		"OMO_RPC_CLIENT_CAPABILITIES":   "custom_only,extension_events",
	} {
		if got, _ := lookupEnv(env, key); got != want {
			t.Fatalf("%s = %q, want %q", key, got, want)
		}
	}
}

func TestLauncherBrandProfileValidation(t *testing.T) {
	valid := `{"name":"OmO","command":"omo","displayVersion":"1","configDir":".omo","flatLayout":false,"envPrefix":"OMO","userAgent":"omo","originator":"omo","update":{"packageName":"omo-ai","distTag":"beta","command":"npm i -g omo-ai@beta","changelogUrl":"https://example.test/releases"}}`
	if err := validateLauncherBrandProfile(valid); err != nil {
		t.Fatalf("valid profile: %v", err)
	}
	for _, invalid := range []string{"null", `{}`, `{"name":"OmO"}`, `[]`} {
		if err := validateLauncherBrandProfile(invalid); err == nil {
			t.Fatalf("profile %s accepted", invalid)
		}
	}
}

func TestLauncherUpdateCommandMatchesInstallShape(t *testing.T) {
	bunRoot := filepath.Join(t.TempDir(), ".bun", "install", "global", "node_modules", "omo-ai")
	if got, want := launcherUpdateCommand(bunRoot), "bun add --cwd "+shellQuote(bunRoot)+" -g omo-ai@beta"; got != want {
		t.Fatalf("bun update command = %q, want %q", got, want)
	}
	npmRoot := filepath.Join(t.TempDir(), "lib", "node_modules", "omo-ai")
	if got := launcherUpdateCommand(npmRoot); got != "npm i -g omo-ai@beta" {
		t.Fatalf("npm update command = %q", got)
	}
}

func TestNativeChildAdapterExecsWithSupervisorDescriptor(t *testing.T) {
	dir := t.TempDir()
	marker := filepath.Join(dir, "adapter")
	native := writeFakeSupervisor(t, fmt.Sprintf(`
read value <&3
printf '%%s %%s' "$$" "$value" > %q
`, marker))
	cfg := EnsureConfig{StateDir: dir}
	adapter, err := writeNativeChildWrapper(cfg, native, testLauncherBrandProfileJSON(), []string{
		"SENPI_RPC_CLIENT_CAPABILITIES=custom",
		"OMO_RPC_CLIENT_CAPABILITIES=custom",
	})
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(adapter)
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(adapter)
	cmd.Env = setEnv(os.Environ(), "OMO_RUNTIME", "node")
	cmd.ExtraFiles = []*os.File{reader}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	_ = reader.Close()
	if _, err := io.WriteString(writer, "descriptor\n"); err != nil {
		t.Fatal(err)
	}
	_ = writer.Close()
	if err := cmd.Wait(); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(marker)
	if err != nil {
		t.Fatal(err)
	}
	if got, want := strings.Fields(string(data)), []string{fmt.Sprint(cmd.Process.Pid), "descriptor"}; !slices.Equal(got, want) {
		t.Fatalf("adapter result = %v, want %v", got, want)
	}
}

func TestEnsureDaemonSpawnEnvironmentContainsPATH(t *testing.T) {
	dir := shortEnsureTempDir(t)
	socket := filepath.Join(dir, "rpc", "rpc.sock")
	marker := filepath.Join(dir, "path")
	script := writeFakeSupervisor(t, fmt.Sprintf("printf '%%s' \"$PATH\" > %q\nexec \"$OMORPC_ENSURE_TEST_BINARY\" -test.run='^TestEnsureHelperProcess$'", marker))
	cfg := helperEnsureConfig(dir, socket, script, "serve")

	ensured, err := EnsureDaemon(context.Background(), cfg)
	if err != nil {
		t.Fatalf("EnsureDaemon: %v", err)
	}
	defer stopEnsuredDaemons(t, []*EnsuredDaemon{ensured})
	path, err := os.ReadFile(marker)
	if err != nil {
		t.Fatalf("read spawned PATH: %v", err)
	}
	if string(path) == "" {
		t.Fatal("spawned supervisor PATH is empty")
	}
}

func TestEnsureDaemonRuntimeLadderCleanupAndWinnerCache(t *testing.T) {
	dir := shortEnsureTempDir(t)
	socket := filepath.Join(dir, "rpc", "rpc.sock")
	runtimeMarker := filepath.Join(dir, "runtimes")
	cleanupMarker := filepath.Join(dir, "cleanup")
	script := helperSupervisorScript(t)
	cfg := helperEnsureConfig(dir, socket, script, "runtime-ladder")
	cfg.Env = append(cfg.Env,
		"OMORPC_ENSURE_RUNTIME_MARKER="+runtimeMarker,
		"OMORPC_ENSURE_CLEANUP_MARKER="+cleanupMarker,
	)

	first, err := EnsureDaemon(context.Background(), cfg)
	if err != nil {
		log, _ := os.ReadFile(filepath.Join(filepath.Dir(socket), "daemon-spawn.log"))
		identity, exists := currentSocketIdentity(socket)
		t.Fatalf("first EnsureDaemon: %v socket=%v/%+v\n%s", err, exists, identity, log)
	}
	stopEnsuredDaemons(t, []*EnsuredDaemon{first})
	if _, err := os.Stat(cleanupMarker); err != nil {
		t.Fatalf("node attempt did not observe stale-socket cleanup: %v", err)
	}
	spawnLog, err := os.ReadFile(filepath.Join(filepath.Dir(socket), "daemon-spawn.log"))
	if err != nil {
		t.Fatalf("read spawn log: %v", err)
	}
	if got := string(spawnLog); !strings.Contains(got, "attempt: automatic") || !strings.Contains(got, "attempt: node") {
		t.Fatalf("spawn log does not preserve both attempt signatures: %q", got)
	}

	second, err := EnsureDaemon(context.Background(), cfg)
	if err != nil {
		t.Fatalf("second EnsureDaemon: %v", err)
	}
	stopEnsuredDaemons(t, []*EnsuredDaemon{second})
	data, err := os.ReadFile(runtimeMarker)
	if err != nil {
		t.Fatalf("read runtime attempts: %v", err)
	}
	if got, want := strings.Fields(string(data)), []string{"automatic", "node", "node"}; !slices.Equal(got, want) {
		t.Fatalf("runtime attempts = %v, want %v", got, want)
	}
}

func TestEnsureDaemonUserRuntimeIsAuthoritative(t *testing.T) {
	dir := shortEnsureTempDir(t)
	socket := filepath.Join(dir, "rpc.sock")
	marker := filepath.Join(dir, "runtimes")
	script := writeFakeSupervisor(t, fmt.Sprintf("echo \"${OMO_RUNTIME-unset}\" >> %q\nexit 7", marker))
	cfg := helperEnsureConfig(dir, socket, script, "die")
	cfg.Env = setEnv(cfg.Env, "OMO_RUNTIME", "custom")

	if ensured, err := EnsureDaemon(context.Background(), cfg); err == nil || ensured != nil {
		t.Fatalf("EnsureDaemon = (%v, %v), want configured single-attempt failure", ensured, err)
	}
	data, err := os.ReadFile(marker)
	if err != nil {
		t.Fatalf("read runtime marker: %v", err)
	}
	if got := strings.Fields(string(data)); !slices.Equal(got, []string{"custom"}) {
		t.Fatalf("configured runtime attempts = %v, want [custom]", got)
	}
}

func TestEnsureDaemonBothRuntimeAttemptsReturnTypedError(t *testing.T) {
	dir := shortEnsureTempDir(t)
	socket := filepath.Join(dir, "rpc.sock")
	marker := filepath.Join(dir, "runtimes")
	script := writeFakeSupervisor(t, fmt.Sprintf("echo \"${OMO_RUNTIME-automatic}\" >> %q\nexit 7", marker))
	cfg := helperEnsureConfig(dir, socket, script, "die")

	_, err := EnsureDaemon(context.Background(), cfg)
	var fallback *ErrDaemonRuntimeFallback
	if !errors.As(err, &fallback) {
		t.Fatalf("EnsureDaemon error = %T (%v), want *ErrDaemonRuntimeFallback", err, err)
	}
	if fallback.Automatic == nil || fallback.Node == nil {
		t.Fatalf("typed fallback error does not name both attempts: %+v", fallback)
	}
	data, readErr := os.ReadFile(marker)
	if readErr != nil {
		t.Fatalf("read runtime marker: %v", readErr)
	}
	if got := strings.Fields(string(data)); !slices.Equal(got, []string{"automatic", "node"}) {
		t.Fatalf("runtime attempts = %v, want [automatic node]", got)
	}
}

func TestEnsureDaemonReapsAttemptDescendantsBeforeFallback(t *testing.T) {
	dir := shortEnsureTempDir(t)
	socket := filepath.Join(dir, "rpc.sock")
	pidPath := filepath.Join(dir, "descendant.pid")
	cfg := helperEnsureConfig(dir, socket, helperSupervisorScript(t), "descendant-ladder")
	cfg.Env = append(cfg.Env, "OMORPC_ENSURE_DESCENDANT_PID="+pidPath)

	ensured, err := EnsureDaemon(context.Background(), cfg)
	if err != nil {
		t.Fatalf("EnsureDaemon: %v", err)
	}
	stopEnsuredDaemons(t, []*EnsuredDaemon{ensured})
}

func TestRemoveOwnedSocketPreservesReplacementListener(t *testing.T) {
	dir := shortEnsureTempDir(t)
	socket := filepath.Join(dir, "replacement.sock")
	first, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	first.(*net.UnixListener).SetUnlinkOnClose(false)
	identity, exists := currentSocketIdentity(socket)
	if !exists {
		t.Fatal("first listener has no socket identity")
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(socket); err != nil {
		t.Fatal(err)
	}
	replacement, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	defer replacement.Close()

	cfg := EnsureConfig{AgentDir: dir, SocketPath: socket, LockTimeout: testAwaitTimeout, LockRetry: time.Millisecond}
	lock, err := acquireEnsureLock(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	if err := removeOwnedSocket(socket, &identity); err != nil {
		t.Fatal(err)
	}
	releaseEnsureLock(lock)
	if _, exists := currentSocketIdentity(socket); !exists {
		t.Fatal("replacement listener was unlinked")
	}
}

func TestEnsureDaemonDoesNotClaimCompetingCompatibleProducer(t *testing.T) {
	dir := shortEnsureTempDir(t)
	socket := filepath.Join(dir, "competitor.sock")
	startedFIFO := filepath.Join(dir, "supervisor-started")
	if err := syscall.Mkfifo(startedFIFO, 0o600); err != nil {
		t.Fatal(err)
	}
	script := writeFakeSupervisor(t, fmt.Sprintf("printf started > %q\nsleep 60", startedFIFO))
	cfg := helperEnsureConfig(dir, socket, script, "serve")

	resultCh := make(chan struct {
		daemon *EnsuredDaemon
		err    error
	}, 1)
	go func() {
		daemon, err := EnsureDaemon(context.Background(), cfg)
		resultCh <- struct {
			daemon *EnsuredDaemon
			err    error
		}{daemon, err}
	}()
	fifo, err := os.Open(startedFIFO)
	if err != nil {
		t.Fatal(err)
	}
	started, err := io.ReadAll(fifo)
	_ = fifo.Close()
	if err != nil || string(started) != "started" {
		t.Fatalf("supervisor start signal = %q, err = %v", started, err)
	}

	t.Setenv("SENPI_RPC_CLIENT_CAPABILITIES", capExtensionEvents)
	competitor, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	defer competitor.Close()
	go func() {
		for {
			conn, err := competitor.Accept()
			if err != nil {
				return
			}
			go serveEnsureHelper(conn)
		}
	}()

	var result struct {
		daemon *EnsuredDaemon
		err    error
	}
	select {
	case result = <-resultCh:
	case <-time.After(testAwaitTimeout):
		t.Fatal("EnsureDaemon did not accept competing producer")
	}
	if result.err != nil {
		t.Fatalf("EnsureDaemon: %v", result.err)
	}
	if result.daemon.Owned {
		t.Fatal("competing producer was reported as owned")
	}
	if err := result.daemon.Stop(context.Background()); err != nil {
		t.Fatalf("Stop unowned daemon: %v", err)
	}
	if _, exists := currentSocketIdentity(socket); !exists {
		t.Fatal("Stop unlinked the competing producer socket")
	}
	ctx, cancel := context.WithTimeout(context.Background(), testAwaitTimeout)
	defer cancel()
	client, err := Dial(ctx, socket)
	if err != nil {
		t.Fatalf("competing producer is not live after Stop: %v", err)
	}
	_ = client.Close()
}

func TestAuthenticatedPeerCannotClaimAfterConnectReplacementInode(t *testing.T) {
	dir := shortEnsureTempDir(t)
	socket := filepath.Join(dir, "replacement.sock")
	cfg := helperEnsureConfig(dir, socket, helperSupervisorScript(t), "serve")
	ensured, err := EnsureDaemon(context.Background(), cfg)
	if err != nil {
		t.Fatalf("EnsureDaemon: %v", err)
	}

	connectedBeforeReplacement, err := probeDaemon(context.Background(), cfg)
	if err != nil {
		t.Fatalf("connect owned endpoint before replacement: %v", err)
	}
	defer connectedBeforeReplacement.Close()
	if err := os.Remove(socket); err != nil {
		t.Fatalf("unlink owned endpoint: %v", err)
	}
	t.Setenv("SENPI_RPC_CLIENT_CAPABILITIES", capExtensionEvents)
	competitor, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatalf("listen competitor: %v", err)
	}
	defer competitor.Close()
	go func() {
		for {
			conn, err := competitor.Accept()
			if err != nil {
				return
			}
			go serveEnsureHelper(conn)
		}
	}()

	client, identity, stable, authenticated, err := probeAuthenticatedDaemon(context.Background(), cfg, ensured.process.Pid)
	if err != nil {
		t.Fatalf("authenticate replacement: %v", err)
	}
	_ = client.Close()
	if !stable || authenticated {
		t.Fatalf("replacement authentication = stable:%v authenticated:%v identity:%+v", stable, authenticated, identity)
	}
	if err := ensured.StopBounded(testAwaitTimeout); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	if current, exists := currentSocketIdentity(socket); !exists || current != identity {
		t.Fatalf("Stop removed competitor: exists=%v identity=%+v want=%+v", exists, current, identity)
	}
}

func TestEnsureDaemonSpawnLogReservesBothAttemptPartitions(t *testing.T) {
	dir := shortEnsureTempDir(t)
	socket := filepath.Join(dir, "rpc.sock")
	cfg := helperEnsureConfig(dir, socket, helperSupervisorScript(t), "saturate-log")

	if ensured, err := EnsureDaemon(context.Background(), cfg); err == nil || ensured != nil {
		t.Fatalf("EnsureDaemon = (%v, %v), want fallback failure", ensured, err)
	}
	data, err := os.ReadFile(filepath.Join(dir, "daemon-spawn.log"))
	if err != nil {
		t.Fatal(err)
	}
	if len(data) > daemonSpawnLogLimit {
		t.Fatalf("spawn log size = %d, limit = %d", len(data), daemonSpawnLogLimit)
	}
	for _, attempt := range []string{"automatic", "node"} {
		if !bytes.Contains(data, []byte("spawn attempt: "+attempt+"\n")) {
			t.Fatalf("saturated spawn log omitted %s header", attempt)
		}
	}
}

func TestSpawnAttemptTemporaryLogIsBoundedDuringCapture(t *testing.T) {
	dir := shortEnsureTempDir(t)
	capture, finish, err := openSpawnAttemptLog(filepath.Join(dir, "daemon-spawn.log"), "noisy", false)
	if err != nil {
		t.Fatal(err)
	}
	bounded := capture.(*boundedSpawnLog)
	if _, err := capture.Write(bytes.Repeat([]byte("x"), daemonSpawnLogLimit*8)); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(bounded.file.Name())
	if err != nil {
		t.Fatal(err)
	}
	if info.Size() > daemonSpawnLogLimit/2 {
		t.Fatalf("temporary spawn log size = %d, half-budget = %d", info.Size(), daemonSpawnLogLimit/2)
	}
	if err := finish(); err != nil {
		t.Fatal(err)
	}
}

func TestDefaultEnsureLockBudgetCoversRuntimeLadder(t *testing.T) {
	cfg, err := normalizeEnsureConfig(EnsureConfig{AgentDir: t.TempDir(), ReadyTimeout: 125 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	fullLadder := 2 * (cfg.ReadyTimeout + daemonStopGrace + daemonKillWait)
	if cfg.LockTimeout < fullLadder {
		t.Fatalf("default lock timeout = %v, full runtime ladder = %v", cfg.LockTimeout, fullLadder)
	}
}

func TestEnsureDaemonCapturesBoundedSupervisorStderr(t *testing.T) {
	dir := shortEnsureTempDir(t)
	stateDir := filepath.Join(dir, "state")
	socket := filepath.Join(dir, "rpc.sock")
	script := writeFakeSupervisor(t, "echo signed-supervisor-error >&2\nexec \"$OMORPC_ENSURE_TEST_BINARY\" -test.run='^TestEnsureHelperProcess$'")
	cfg := helperEnsureConfig(dir, socket, script, "serve")
	cfg.StateDir = stateDir

	ensured, err := EnsureDaemon(context.Background(), cfg)
	if err != nil {
		t.Fatalf("EnsureDaemon: %v", err)
	}
	stopEnsuredDaemons(t, []*EnsuredDaemon{ensured})
	data, err := os.ReadFile(filepath.Join(stateDir, "daemon-spawn.log"))
	if err != nil {
		t.Fatalf("read daemon spawn log: %v", err)
	}
	if !strings.Contains(string(data), "signed-supervisor-error") {
		t.Fatalf("daemon spawn log = %q", data)
	}

	log, err := newBoundedSpawnLog(filepath.Join(stateDir, "bounded.log"), 4)
	if err != nil {
		t.Fatalf("newBoundedSpawnLog: %v", err)
	}
	if _, err := log.Write([]byte("abcdefgh")); err != nil {
		t.Fatalf("write bounded log: %v", err)
	}
	if err := log.Close(); err != nil {
		t.Fatalf("close bounded log: %v", err)
	}
	bounded, err := os.ReadFile(filepath.Join(stateDir, "bounded.log"))
	if err != nil || string(bounded) != "abcd" {
		t.Fatalf("bounded log = %q, err = %v", bounded, err)
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

func TestEnsureLockEndpointScopeAndPersistentFile(t *testing.T) {
	dir := shortEnsureTempDir(t)
	cfgA := EnsureConfig{AgentDir: dir, SocketPath: filepath.Join(dir, "a.sock"), LockTimeout: testAwaitTimeout, LockRetry: time.Millisecond}
	cfgB := cfgA
	cfgB.SocketPath = filepath.Join(dir, "b.sock")
	if ensureLockPath(cfgA) == ensureLockPath(cfgB) {
		t.Fatal("ensure lock must be keyed by SocketPath")
	}
	path := ensureLockPath(cfgA)
	if err := os.WriteFile(path, []byte("contents are not ownership\n"), 0o666); err != nil {
		t.Fatal(err)
	}
	lock, err := acquireEnsureLock(context.Background(), cfgA)
	if err != nil {
		t.Fatalf("acquire persistent lock: %v", err)
	}
	releaseEnsureLock(lock)
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("persistent lock removed on release: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("persistent lock mode = %o, want 600", info.Mode().Perm())
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

func TestEnsureDaemonFlockMutualExclusion(t *testing.T) {
	dir := shortEnsureTempDir(t)
	socket := filepath.Join(dir, "rpc", "rpc.sock")
	marker := filepath.Join(dir, "spawns")
	script := writeFakeSupervisor(t, fmt.Sprintf("echo spawn >> %q\nexec \"$OMORPC_ENSURE_TEST_BINARY\" -test.run='^TestEnsureHelperProcess$'", marker))
	cfg := helperEnsureConfig(dir, socket, script, "serve")
	cfg.LockTimeout = 40 * time.Millisecond
	cfg.LockRetry = 5 * time.Millisecond

	lockPath := ensureLockPath(cfg)
	if err := os.MkdirAll(filepath.Dir(lockPath), 0o700); err != nil {
		t.Fatal(err)
	}
	owner, err := os.OpenFile(lockPath, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	if err := syscall.Flock(int(owner.Fd()), syscall.LOCK_EX); err != nil {
		_ = owner.Close()
		t.Fatalf("hold ensure flock: %v", err)
	}

	ensured, err := EnsureDaemon(context.Background(), cfg)
	if ensured != nil {
		_ = ensured.Close()
		t.Fatal("contended ensure returned a daemon")
	}
	var lockTimeout *ErrEnsureLockTimeout
	if !errors.As(err, &lockTimeout) {
		t.Fatalf("contended EnsureDaemon error = %T (%v), want *ErrEnsureLockTimeout", err, err)
	}
	if _, err := os.Stat(marker); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("supervisor spawned while flock held: %v", err)
	}
	if err := owner.Close(); err != nil {
		t.Fatalf("release manual flock: %v", err)
	}

	ensured, err = EnsureDaemon(context.Background(), cfg)
	if err != nil {
		t.Fatalf("EnsureDaemon after flock release: %v", err)
	}
	stopEnsuredDaemons(t, []*EnsuredDaemon{ensured})
}

func TestEnsureDaemonDanglingLockSymlinkFailsClean(t *testing.T) {
	dir := shortEnsureTempDir(t)
	socket := filepath.Join(dir, "rpc", "rpc.sock")
	marker := filepath.Join(dir, "spawned")
	script := writeFakeSupervisor(t, fmt.Sprintf("echo spawned > %q\nexit 99", marker))
	cfg := helperEnsureConfig(dir, socket, script, "die")
	cfg.LockTimeout = testAwaitTimeout
	cfg.LockRetry = time.Millisecond
	lockPath := ensureLockPath(cfg)
	if err := os.MkdirAll(filepath.Dir(lockPath), 0o700); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(dir, "missing-lock-target")
	if err := os.Symlink(target, lockPath); err != nil {
		t.Fatal(err)
	}

	started := time.Now()
	ensured, err := EnsureDaemon(context.Background(), cfg)
	if ensured != nil {
		_ = ensured.Close()
		t.Fatal("invalid lock path returned a daemon")
	}
	if elapsed := time.Since(started); elapsed >= cfg.LockTimeout/2 {
		t.Fatalf("EnsureDaemon did not reject dangling lock symlink promptly: %v", elapsed)
	}
	var invalidPath *ErrEnsureLockPathInvalid
	if !errors.As(err, &invalidPath) {
		t.Fatalf("EnsureDaemon error = %T (%v), want *ErrEnsureLockPathInvalid", err, err)
	}
	if invalidPath.Path != lockPath {
		t.Fatalf("invalid lock path = %q, want %q", invalidPath.Path, lockPath)
	}
	gotTarget, readlinkErr := os.Readlink(lockPath)
	if readlinkErr != nil {
		t.Fatalf("read preserved lock symlink: %v", readlinkErr)
	}
	if gotTarget != target {
		t.Fatalf("lock symlink target = %q, want %q", gotTarget, target)
	}
	if _, statErr := os.Stat(marker); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("supervisor spawned with invalid lock path: %v", statErr)
	}
}

func TestEnsureDaemonDeadFlockHolderAutoReleases(t *testing.T) {
	dir := shortEnsureTempDir(t)
	socket := filepath.Join(dir, "rpc", "rpc.sock")
	cfg := helperEnsureConfig(dir, socket, helperSupervisorScript(t), "serve")
	lockPath := ensureLockPath(cfg)
	if err := os.MkdirAll(filepath.Dir(lockPath), 0o700); err != nil {
		t.Fatal(err)
	}

	cmd := exec.Command(os.Args[0], "-test.run=^TestEnsureHelperProcess$")
	cmd.Env = append(os.Environ(),
		ensureHelperModeEnv+"=flock-exit",
		"OMORPC_ENSURE_HELPER_LOCK_PATH="+lockPath,
	)
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("dead flock holder: %v: %s", err, output)
	}
	if !strings.Contains(string(output), "lock held") {
		t.Fatalf("dead holder output = %q, want lock acquisition evidence", output)
	}

	ensured, err := EnsureDaemon(context.Background(), cfg)
	if err != nil {
		t.Fatalf("EnsureDaemon after holder death: %v", err)
	}
	stopEnsuredDaemons(t, []*EnsuredDaemon{ensured})
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
	if err := ensured.StopBounded(6 * time.Second); err != nil {
		t.Fatalf("StopBounded did not complete SIGKILL escalation: %v", err)
	}
	if err := ensured.process.Signal(syscall.Signal(0)); !errors.Is(err, os.ErrProcessDone) {
		t.Fatalf("SIGTERM-ignoring supervisor remains alive after Stop: %v", err)
	}
}

func TestSupervisorCommandDefaultUsesNativeHostChild(t *testing.T) {
	script := writeFakeSupervisor(t, "exit 0")
	_, args, err := supervisorCommand(EnsureConfig{
		AgentDir:   t.TempDir(),
		SocketPath: filepath.Join(t.TempDir(), "rpc.sock"),
		BinaryPath: script,
	})
	if err != nil {
		t.Fatalf("supervisorCommand: %v", err)
	}
	if slices.Contains(args, "--child-command") || slices.Contains(args, "--child-args") {
		t.Fatalf("native supervisor args redundantly override its child launch: %v", args)
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
