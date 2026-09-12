//go:build unix || darwin || linux

package api

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"slices"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/config"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc/omorpctest"
)

func useMockEnsure(t *testing.T) {
	t.Helper()
	daemon := omorpctest.New(t.TempDir())
	if err := daemon.Start(); err != nil {
		t.Fatal(err)
	}
	old := ensureDaemon
	ensureDaemon = func(ctx context.Context, _ omorpc.EnsureConfig) (*omorpc.EnsuredDaemon, error) {
		client, err := omorpc.Dial(ctx, daemon.SocketPath())
		if err != nil {
			return nil, err
		}
		return &omorpc.EnsuredDaemon{Client: client}, nil
	}
	t.Cleanup(func() { ensureDaemon = old; daemon.Stop() })
}

func TestRunSignalsReadyAndShutsDown(t *testing.T) {
	useMockEnsure(t)
	t.Setenv("HOME", t.TempDir())
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ready := make(chan struct{})
	result := make(chan error, 1)
	cfg := &config.Config{
		Host:     "127.0.0.1",
		Port:     0,
		Password: "x",
		Root:     t.TempDir(),
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	go func() {
		result <- Run(ctx, cfg, logger, func() error {
			close(ready)
			return nil
		})
	}()

	select {
	case <-ready:
	case <-time.After(2 * time.Second):
		t.Fatal("Run() did not invoke onReady")
	}
	cancel()
	select {
	case err := <-result:
		if err != nil {
			t.Fatalf("Run() error = %v, want nil", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Run() did not stop after context cancellation")
	}
}

func TestRunDaemonFailureIsFatal(t *testing.T) {
	t.Setenv("PATH", "/run-test-path")
	t.Setenv("OMO_MEMORY_HOME", "/run-test-memory")
	old := ensureDaemon
	var ensureCfg omorpc.EnsureConfig
	ensureDaemon = func(_ context.Context, cfg omorpc.EnsureConfig) (*omorpc.EnsuredDaemon, error) {
		ensureCfg = cfg
		return nil, errors.New("offline")
	}
	t.Cleanup(func() { ensureDaemon = old })
	root := t.TempDir()
	err := Run(t.Context(), &config.Config{Root: root}, slog.New(slog.NewTextHandler(io.Discard, nil)), nil)
	if err == nil || !strings.Contains(err.Error(), "starting required omo daemon") {
		t.Fatalf("Run error = %v", err)
	}
	if !slices.Contains(ensureCfg.Env, "PATH=/run-test-path") {
		t.Fatalf("daemon environment does not inherit PATH: %v", ensureCfg.Env)
	}
	if !slices.Contains(ensureCfg.Env, "OMO_MEMORY_HOME=/run-test-memory") {
		t.Fatalf("daemon environment does not inherit OMO_MEMORY_HOME: %v", ensureCfg.Env)
	}
	if ensureCfg.WorkingDir != root {
		t.Fatalf("daemon working directory = %q, want project root %q", ensureCfg.WorkingDir, root)
	}
}

func TestRunOwnedDaemonHelper(t *testing.T) {
	dir := os.Getenv("OMO_API_RUN_HELPER_DIR")
	if dir == "" {
		return
	}
	if os.Getenv("OMO_API_RUN_DESCENDANT_CHILD") == "1" {
		signal.Ignore(syscall.SIGTERM)
		ready := os.NewFile(3, "descendant-ready")
		if _, err := ready.Write([]byte{1}); err != nil {
			os.Exit(91)
		}
		_ = ready.Close()
		select {}
	}
	if os.Getenv("OMO_API_RUN_DESCENDANT") == "1" {
		reader, writer, err := os.Pipe()
		if err != nil {
			t.Fatal(err)
		}
		child := exec.Command(os.Args[0], "-test.run=^TestRunOwnedDaemonHelper$")
		child.Env = append(os.Environ(), "OMO_API_RUN_DESCENDANT_CHILD=1")
		child.ExtraFiles = []*os.File{writer}
		if err := child.Start(); err != nil {
			t.Fatal(err)
		}
		_ = writer.Close()
		var acknowledged [1]byte
		if _, err := io.ReadFull(reader, acknowledged[:]); err != nil {
			t.Fatal(err)
		}
		_ = reader.Close()
	}
	if err := os.WriteFile(filepath.Join(dir, "pid"), []byte(fmt.Sprintf("%d", os.Getpid())), 0o600); err != nil {
		t.Fatal(err)
	}
	d := omorpctest.New(dir)
	if err := d.Start(); err != nil {
		t.Fatal(err)
	}
	select {}
}

func TestRunStartupFailureStopsOwnedDaemon(t *testing.T) {
	dir, err := os.MkdirTemp("", "api-run-owned-*")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	script := filepath.Join(dir, "supervisor.sh")
	contents := "#!/bin/sh\nexec \"$OMO_API_RUN_TEST_BINARY\" -test.run='^TestRunOwnedDaemonHelper$'\n"
	if err := os.WriteFile(script, []byte(contents), 0o700); err != nil {
		t.Fatal(err)
	}
	old := ensureDaemon
	ensureDaemon = func(ctx context.Context, _ omorpc.EnsureConfig) (*omorpc.EnsuredDaemon, error) {
		return omorpc.EnsureDaemon(ctx, omorpc.EnsureConfig{
			AgentDir: dir, SocketPath: filepath.Join(dir, "d.sock"), BinaryPath: script,
			ReadyTimeout: 5 * time.Second, ProbeTimeout: 100 * time.Millisecond,
			Env: append(os.Environ(), "OMO_API_RUN_HELPER_DIR="+dir, "OMO_API_RUN_TEST_BINARY="+os.Args[0]),
		})
	}
	t.Cleanup(func() { ensureDaemon = old })
	stateDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(stateDir, "state-v2.json"), []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	err = Run(context.Background(), &config.Config{Root: t.TempDir(), StateDir: stateDir}, slog.New(slog.NewTextHandler(io.Discard, nil)), nil)
	if err == nil || !strings.Contains(err.Error(), "opening cursor store") {
		t.Fatalf("Run error = %v, want cursor store failure", err)
	}
	pidBytes, err := os.ReadFile(filepath.Join(dir, "pid"))
	if err != nil {
		t.Fatalf("read helper pid: %v", err)
	}
	var pid int
	if _, err := fmt.Sscanf(string(pidBytes), "%d", &pid); err != nil {
		t.Fatalf("parse helper pid: %v", err)
	}
	process, err := os.FindProcess(pid)
	if err != nil {
		t.Fatal(err)
	}
	if err := process.Signal(syscall.Signal(0)); !errors.Is(err, os.ErrProcessDone) {
		t.Fatalf("owned supervisor process %d remains after startup failure: %v", pid, err)
	}
}

func ownedRecoveryEnsureConfig(t *testing.T) (omorpc.EnsureConfig, string) {
	t.Helper()
	dir, err := os.MkdirTemp("", "api-run-recovery-*")
	if err != nil {
		t.Fatal(err)
	}
	pidPath := filepath.Join(dir, "pid")
	t.Cleanup(func() {
		if pidBytes, err := os.ReadFile(pidPath); err == nil {
			var pid int
			if _, err := fmt.Sscanf(string(pidBytes), "%d", &pid); err == nil {
				_ = syscall.Kill(-pid, syscall.SIGKILL)
			}
		}
		_ = os.RemoveAll(dir)
	})
	script := filepath.Join(dir, "supervisor.sh")
	contents := "#!/bin/sh\nexec \"$OMO_API_RUN_TEST_BINARY\" -test.run='^TestRunOwnedDaemonHelper$'\n"
	if err := os.WriteFile(script, []byte(contents), 0o700); err != nil {
		t.Fatal(err)
	}
	return omorpc.EnsureConfig{
		AgentDir: dir, SocketPath: filepath.Join(dir, "d.sock"), BinaryPath: script,
		ReadyTimeout: 5 * time.Second, ProbeTimeout: 100 * time.Millisecond,
		Env: append(os.Environ(), "OMO_API_RUN_HELPER_DIR="+dir, "OMO_API_RUN_TEST_BINARY="+os.Args[0]),
	}, pidPath
}

func assertOwnedRecoveryStopped(t *testing.T, pidPath string) {
	t.Helper()
	pidBytes, err := os.ReadFile(pidPath)
	if err != nil {
		t.Fatalf("read recovery helper pid: %v", err)
	}
	var pid int
	if _, err := fmt.Sscanf(string(pidBytes), "%d", &pid); err != nil {
		t.Fatalf("parse recovery helper pid: %v", err)
	}
	process, err := os.FindProcess(pid)
	if err != nil {
		t.Fatal(err)
	}
	if err := process.Signal(syscall.Signal(0)); !errors.Is(err, os.ErrProcessDone) {
		t.Fatalf("owned recovery process %d remains after shutdown: %v", pid, err)
	}
}

func newRunTestDaemon(t *testing.T) *omorpctest.Daemon {
	t.Helper()
	dir, err := os.MkdirTemp("", "api-run-daemon-*")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	daemon := omorpctest.New(dir)
	if err := daemon.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(daemon.Stop)
	return daemon
}

func TestRunStopsOwnedRecoveryDaemon(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	startup := newRunTestDaemon(t)
	recoveryCfg, pidPath := ownedRecoveryEnsureConfig(t)

	old := ensureDaemon
	var calls atomic.Int32
	configured := make(chan omorpc.EnsureConfig, 1)
	ensureDaemon = func(ctx context.Context, cfg omorpc.EnsureConfig) (*omorpc.EnsuredDaemon, error) {
		if calls.Add(1) == 1 {
			configured <- cfg
			client, err := omorpc.Dial(ctx, startup.SocketPath())
			return &omorpc.EnsuredDaemon{Client: client}, err
		}
		daemon, err := omorpc.EnsureDaemon(ctx, recoveryCfg)
		if err == nil && !daemon.Owned {
			return nil, errors.New("recovery ensure did not own spawned daemon")
		}
		return daemon, err
	}
	t.Cleanup(func() { ensureDaemon = old })

	ctx, cancel := context.WithCancel(context.Background())
	ready := make(chan struct{})
	result := make(chan error, 1)
	go func() {
		result <- Run(ctx, &config.Config{Host: "127.0.0.1", Port: 0, Root: t.TempDir(), StateDir: t.TempDir()}, slog.New(slog.NewTextHandler(io.Discard, nil)), func() error {
			close(ready)
			return nil
		})
	}()
	select {
	case <-ready:
	case <-time.After(5 * time.Second):
		t.Fatal("Run() did not become ready")
	}
	ensureCfg := <-configured
	if ensureCfg.OnDialNotExist == nil {
		t.Fatal("Run() did not configure reconnect recovery")
	}
	if err := ensureCfg.OnDialNotExist(t.Context()); err != nil {
		t.Fatalf("recovery ensure: %v", err)
	}
	cancel()
	select {
	case err := <-result:
		if err != nil {
			t.Fatalf("Run() error = %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Run() did not stop")
	}
	assertOwnedRecoveryStopped(t, pidPath)
}

func TestRunStopsOwnedRecoveryThatCompletesDuringTeardown(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	startup := newRunTestDaemon(t)
	recoveryCfg, pidPath := ownedRecoveryEnsureConfig(t)

	old := ensureDaemon
	var calls atomic.Int32
	configured := make(chan omorpc.EnsureConfig, 1)
	recoverySpawned := make(chan struct{})
	releaseRecovery := make(chan struct{})
	ensureDaemon = func(ctx context.Context, cfg omorpc.EnsureConfig) (*omorpc.EnsuredDaemon, error) {
		if calls.Add(1) == 1 {
			configured <- cfg
			client, err := omorpc.Dial(ctx, startup.SocketPath())
			return &omorpc.EnsuredDaemon{Client: client}, err
		}
		daemon, err := omorpc.EnsureDaemon(ctx, recoveryCfg)
		if err != nil {
			return nil, err
		}
		if !daemon.Owned {
			return nil, errors.New("recovery ensure did not own spawned daemon")
		}
		close(recoverySpawned)
		<-releaseRecovery
		return daemon, nil
	}
	t.Cleanup(func() { ensureDaemon = old })

	ctx, cancel := context.WithCancel(context.Background())
	ready := make(chan struct{})
	result := make(chan error, 1)
	go func() {
		result <- Run(ctx, &config.Config{Host: "127.0.0.1", Port: 0, Root: t.TempDir(), StateDir: t.TempDir()}, slog.New(slog.NewTextHandler(io.Discard, nil)), func() error {
			close(ready)
			return nil
		})
	}()
	select {
	case <-ready:
	case <-time.After(5 * time.Second):
		t.Fatal("Run() did not become ready")
	}
	ensureCfg := <-configured
	hookResult := make(chan error, 1)
	go func() { hookResult <- ensureCfg.OnDialNotExist(t.Context()) }()
	select {
	case <-recoverySpawned:
	case <-time.After(5 * time.Second):
		t.Fatal("recovery daemon was not spawned")
	}
	cancel()
	select {
	case err := <-result:
		if err != nil {
			t.Fatalf("Run() error = %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Run() did not stop while recovery ensure was in flight")
	}
	close(releaseRecovery)
	select {
	case err := <-hookResult:
		if err != nil {
			t.Fatalf("late recovery ensure: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("late recovery ensure did not finish")
	}
	assertOwnedRecoveryStopped(t, pidPath)
}

func TestRecoveryDaemonLifecycleDoesNotStopAdoptedDaemon(t *testing.T) {
	daemon := newRunTestDaemon(t)
	client, err := omorpc.Dial(t.Context(), daemon.SocketPath())
	if err != nil {
		t.Fatal(err)
	}
	lifecycle := recoveryDaemonLifecycle{logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	lifecycle.retain(&omorpc.EnsuredDaemon{Client: client})
	lifecycle.stop()

	probe, err := omorpc.Dial(t.Context(), daemon.SocketPath())
	if err != nil {
		t.Fatalf("adopted recovery daemon was stopped: %v", err)
	}
	_ = probe.Close()
}

func TestEngineRestartSerializesRecoveryUntilOwnedGroupIsGone(t *testing.T) {
	recoveryCfg, pidPath := ownedRecoveryEnsureConfig(t)
	recoveryCfg.Env = append(recoveryCfg.Env, "OMO_API_RUN_DESCENDANT=1")
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	lifecycle := recoveryDaemonLifecycle{logger: logger}
	spawnBoundary := make(chan error, 2)
	var ensureCalls atomic.Int32
	recoveryCfg.OnDialNotExist = func(ctx context.Context) error {
		return lifecycle.ensure(ctx, func(ctx context.Context) (*omorpc.EnsuredDaemon, error) {
			ensureCalls.Add(1)
			pidBytes, err := os.ReadFile(pidPath)
			if err != nil {
				spawnBoundary <- fmt.Errorf("read retiring pid: %w", err)
			} else {
				var pid int
				_, scanErr := fmt.Sscanf(string(pidBytes), "%d", &pid)
				if scanErr != nil {
					spawnBoundary <- fmt.Errorf("parse retiring pid: %w", scanErr)
				} else if err := syscall.Kill(-pid, syscall.Signal(0)); !errors.Is(err, syscall.ESRCH) {
					spawnBoundary <- fmt.Errorf("successor ensure reached while retiring group %d is alive: %v", pid, err)
				} else if _, err := os.Lstat(recoveryCfg.SocketPath); !errors.Is(err, os.ErrNotExist) {
					spawnBoundary <- fmt.Errorf("successor ensure reached before endpoint cleanup: %v", err)
				} else {
					spawnBoundary <- nil
				}
			}
			return omorpc.EnsureDaemon(ctx, recoveryCfg)
		})
	}

	initial, err := omorpc.EnsureDaemon(t.Context(), recoveryCfg)
	if err != nil {
		t.Fatalf("initial EnsureDaemon: %v", err)
	}
	if !initial.Owned {
		t.Fatal("initial daemon is not owned")
	}
	lifecycle.initialize(initial)
	t.Cleanup(func() {
		lifecycle.stop()
		_ = initial.StopBounded(daemonStopTimeout)
	})
	if response, err := initial.Client.Call(t.Context(), omorpc.OpenSession{CWD: t.TempDir()}); err != nil || response == nil || !response.Success {
		t.Fatalf("subscribe chat before restart: response=%+v err=%v", response, err)
	}
	oldEpoch, oldEvents := initial.Client.CurrentEpoch()

	type restartResult struct {
		before string
		after  string
		err    error
	}
	done := make(chan restartResult, 1)
	go func() {
		before, after, err := engineRestarter(&lifecycle, initial.Client)(t.Context())
		done <- restartResult{before: before, after: after, err: err}
	}()
	select {
	case err := <-spawnBoundary:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("successor ensure never reached the post-reap boundary")
	}
	select {
	case got := <-done:
		t.Fatalf("restart completed before successor startup and negotiation: %+v", got)
	default:
	}
	select {
	case got := <-done:
		if got.err != nil {
			t.Fatalf("restart: %v", got.err)
		}
		if got.before == "" || got.after == "" {
			t.Fatalf("restart versions = (%q, %q), want negotiated values", got.before, got.after)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("restart did not complete after successor startup")
	}
	select {
	case _, ok := <-oldEvents:
		if ok {
			t.Fatal("retiring subscribed epoch delivered an event instead of closing")
		}
	default:
		t.Fatal("retiring subscribed epoch was not fenced before restart success")
	}
	if initial.Client.EpochCurrent(oldEpoch) {
		t.Fatal("restart reported success on the retiring epoch")
	}
	if got := ensureCalls.Load(); got != 1 {
		t.Fatalf("successor ensure calls = %d, want exactly 1", got)
	}
	lifecycle.mu.Lock()
	survivors := len(lifecycle.generation)
	lifecycle.mu.Unlock()
	if survivors != 1 {
		t.Fatalf("owned successor generation = %d, want exactly 1", survivors)
	}
	response, err := initial.Client.Call(t.Context(), omorpc.ListSessions{})
	if err != nil || response == nil || !response.Success {
		t.Fatalf("shared client RPC after restart: response=%+v err=%v", response, err)
	}
}

func TestEngineRestartJoinsRecoveryAndRefusesItsForeignPublication(t *testing.T) {
	daemon := newRunTestDaemon(t)
	client, err := omorpc.Dial(t.Context(), daemon.SocketPath())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close() })
	lifecycle := recoveryDaemonLifecycle{logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	lifecycle.initialize(&omorpc.EnsuredDaemon{Owned: true})
	ensureEntered := make(chan struct{})
	releaseEnsure := make(chan struct{})
	ensureDone := make(chan error, 1)
	go func() {
		ensureDone <- lifecycle.ensure(t.Context(), func(context.Context) (*omorpc.EnsuredDaemon, error) {
			close(ensureEntered)
			<-releaseEnsure
			foreign, err := omorpc.Dial(t.Context(), daemon.SocketPath())
			return &omorpc.EnsuredDaemon{Client: foreign}, err
		})
	}()
	<-ensureEntered
	restarted := make(chan error, 1)
	go func() {
		_, _, err := engineRestarter(&lifecycle, client)(t.Context())
		restarted <- err
	}()
	select {
	case err := <-restarted:
		t.Fatalf("restart did not join recovery already in progress: %v", err)
	default:
	}
	close(releaseEnsure)
	if err := <-ensureDone; err != nil {
		t.Fatalf("recovery ensure: %v", err)
	}
	if err := <-restarted; !errors.Is(err, omorpc.ErrDaemonNotOwned) {
		t.Fatalf("restart after foreign publication = %v, want ErrDaemonNotOwned", err)
	}
}

func TestRecoveryRetainCannotPublishAcrossRestartSnapshotBoundary(t *testing.T) {
	lifecycle := recoveryDaemonLifecycle{logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	lifecycle.initialize(&omorpc.EnsuredDaemon{Owned: true})
	lifecycle.barrier.Lock()
	published := make(chan struct{})
	go func() {
		lifecycle.retain(&omorpc.EnsuredDaemon{})
		close(published)
	}()
	select {
	case <-published:
		t.Fatal("retain crossed a held restart snapshot boundary")
	default:
	}
	lifecycle.mu.Lock()
	if lifecycle.current == nil || !lifecycle.current.Owned {
		t.Fatal("blocked retain changed current ownership")
	}
	lifecycle.mu.Unlock()
	lifecycle.barrier.Unlock()
	select {
	case <-published:
	case <-time.After(time.Second):
		t.Fatal("retain did not publish after restart boundary released")
	}
	if lifecycle.currentOwned() {
		t.Fatal("foreign retain was accepted through stale ownership")
	}
}

func TestRunReturnsReadyError(t *testing.T) {
	useMockEnsure(t)
	t.Setenv("HOME", t.TempDir())
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	cfg := &config.Config{
		Host:     "127.0.0.1",
		Port:     0,
		Password: "x",
		Root:     t.TempDir(),
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	want := errors.New("boom")
	err := Run(ctx, cfg, logger, func() error { return want })
	if !errors.Is(err, want) {
		t.Fatalf("Run() error = %v, want wrapped %v", err, want)
	}
}
