package api

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
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
	d := omorpctest.New(dir)
	if err := d.Start(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "pid"), []byte(fmt.Sprintf("%d", os.Getpid())), 0o600); err != nil {
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
