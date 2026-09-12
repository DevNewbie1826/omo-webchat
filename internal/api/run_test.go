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
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/config"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc/omorpctest"
	"github.com/DevNewbie1826/omo-webchat/internal/session"
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
		if err := os.WriteFile(filepath.Join(os.Getenv("OMO_API_RUN_HELPER_DIR"), "descendant-pid"), []byte(fmt.Sprintf("%d", os.Getpid())), 0o600); err != nil {
			os.Exit(92)
		}
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

type restartTestChat struct{ id, cwd string }

func (c restartTestChat) ChatID() string { return c.id }
func (c restartTestChat) CWD() string    { return c.cwd }

type restartTestStore struct {
	mu      sync.Mutex
	cursors map[string]session.Cursor
}

func (s *restartTestStore) CursorForOpen(ctx context.Context, chatID string) (session.Cursor, error) {
	return s.CursorFor(ctx, chatID)
}
func (s *restartTestStore) CursorFor(_ context.Context, chatID string) (session.Cursor, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.cursors[chatID], nil
}
func (s *restartTestStore) SaveCursor(_ context.Context, chatID string, cursor session.Cursor) error {
	s.mu.Lock()
	s.cursors[chatID] = cursor
	s.mu.Unlock()
	return nil
}
func (s *restartTestStore) UpdateIdentity(_ context.Context, chatID, path, durableID string) error {
	s.mu.Lock()
	cursor := s.cursors[chatID]
	cursor.SessionFile, cursor.DurableSessionID = path, durableID
	s.cursors[chatID] = cursor
	s.mu.Unlock()
	return nil
}
func (s *restartTestStore) UpdateName(_ context.Context, chatID, name, source string) error {
	s.mu.Lock()
	cursor := s.cursors[chatID]
	cursor.Name, cursor.NameSource = name, source
	s.cursors[chatID] = cursor
	s.mu.Unlock()
	return nil
}

type restartTestSubscriber struct{ frames chan session.Frame }

func (s *restartTestSubscriber) Deliver(frame session.Frame) { s.frames <- frame }
func (*restartTestSubscriber) Cancel() error                 { return nil }

func awaitRestartSignal(t *testing.T, signal <-chan struct{}, message string) {
	t.Helper()
	select {
	case <-signal:
	case <-time.After(10 * time.Second):
		t.Fatal(message)
	}
}

func TestEngineRestartSerializesProductionRecoveryUntilOwnedGroupIsGone(t *testing.T) {
	recoveryCfg, pidPath := ownedRecoveryEnsureConfig(t)
	recoveryCfg.Env = append(recoveryCfg.Env, "OMO_API_RUN_DESCENDANT=1")
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	lifecycle := recoveryDaemonLifecycle{logger: logger}
	recoveryAttempted := make(chan struct{})
	spawnBoundary := make(chan error, 1)
	releaseStartup := make(chan struct{})
	var releaseStartupOnce sync.Once
	t.Cleanup(func() { releaseStartupOnce.Do(func() { close(releaseStartup) }) })
	var ensureCalls atomic.Int32
	recoveryCfg.OnDialNotExist = func(ctx context.Context) error {
		select {
		case <-recoveryAttempted:
		default:
			close(recoveryAttempted)
		}
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
			<-releaseStartup
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

	store := &restartTestStore{cursors: make(map[string]session.Cursor)}
	manager := session.NewManager(session.Config{Client: initial.Client, Store: store})
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = manager.CloseAll(ctx)
	})
	subscriber := &restartTestSubscriber{frames: make(chan session.Frame, 32)}
	_, _, detach, err := manager.Acquire(t.Context(), restartTestChat{id: "restart", cwd: t.TempDir()}, subscriber)
	if err != nil {
		t.Fatalf("subscribe chat before restart: %v", err)
	}
	defer detach()
	oldEpoch, oldEvents := initial.Client.CurrentEpoch()

	oldStop := stopSupervisorDaemon
	retirementEntered := make(chan struct{})
	releaseRetirement := make(chan struct{})
	var retirementOnce sync.Once
	stopSupervisorDaemon = func(daemon *omorpc.EnsuredDaemon, ctx context.Context) error {
		retirementOnce.Do(func() {
			close(retirementEntered)
			<-releaseRetirement
		})
		return oldStop(daemon, ctx)
	}
	t.Cleanup(func() {
		stopSupervisorDaemon = oldStop
		select {
		case <-releaseRetirement:
		default:
			close(releaseRetirement)
		}
	})

	type restartResult struct {
		before, after string
		err           error
	}
	done := make(chan restartResult, 1)
	restartAttempted := make(chan struct{})
	go func() {
		close(restartAttempted)
		before, after, err := engineRestarter(&lifecycle, initial.Client)(t.Context())
		done <- restartResult{before: before, after: after, err: err}
	}()
	awaitRestartSignal(t, restartAttempted, "restart did not attempt retirement")
	awaitRestartSignal(t, retirementEntered, "restart did not enter supervisor retirement")

	pidBytes, err := os.ReadFile(pidPath)
	if err != nil {
		t.Fatalf("read retiring pid: %v", err)
	}
	var pid int
	if _, err := fmt.Sscanf(string(pidBytes), "%d", &pid); err != nil {
		t.Fatalf("parse retiring pid: %v", err)
	}
	if err := os.Remove(recoveryCfg.SocketPath); err != nil {
		t.Fatalf("unlink retiring endpoint: %v", err)
	}
	if _, err := os.Lstat(recoveryCfg.SocketPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("retiring endpoint unlink was not acknowledged: %v", err)
	}
	descendantBytes, err := os.ReadFile(filepath.Join(filepath.Dir(pidPath), "descendant-pid"))
	if err != nil {
		t.Fatalf("read descendant pid: %v", err)
	}
	var descendantPID int
	if _, err := fmt.Sscanf(string(descendantBytes), "%d", &descendantPID); err != nil {
		t.Fatalf("parse descendant pid: %v", err)
	}
	if err := syscall.Kill(descendantPID, syscall.Signal(0)); err != nil {
		t.Fatalf("descendant was not live after endpoint unlink: %v", err)
	}
	initial.Client.FenceEpoch(oldEpoch)
	select {
	case _, ok := <-oldEvents:
		if ok {
			t.Fatal("retiring epoch delivered an event instead of closing")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("shared client did not acknowledge retiring socket close")
	}
	awaitRestartSignal(t, recoveryAttempted, "production recovery did not compete with held retirement")
	close(releaseRetirement)

	select {
	case err := <-spawnBoundary:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("successor ensure never reached the post-retirement boundary")
	}
	select {
	case got := <-done:
		t.Fatalf("restart completed before gated successor startup and negotiation: %+v", got)
	default:
	}
	releaseStartupOnce.Do(func() { close(releaseStartup) })
	select {
	case got := <-done:
		if got.err != nil {
			t.Fatalf("restart: %v", got.err)
		}
		if got.before == "" || got.after == "" {
			t.Fatalf("restart versions = (%q, %q), want negotiated values", got.before, got.after)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("restart did not complete after successor negotiation")
	}
	if initial.Client.EpochCurrent(oldEpoch) {
		t.Fatal("restart reported success on the retiring epoch")
	}
	if got := ensureCalls.Load(); got != 1 {
		t.Fatalf("successor ensure calls = %d, want exactly 1", got)
	}
}

func TestEngineRestartSupersedesRecoveryFlightThatPublishedRetiredDaemon(t *testing.T) {
	recoveryCfg, _ := ownedRecoveryEnsureConfig(t)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	lifecycle := recoveryDaemonLifecycle{logger: logger}
	published := make(chan struct{})
	freshSpawn := make(chan struct{})
	releaseFreshSpawn := make(chan struct{})
	var releaseFreshOnce sync.Once
	t.Cleanup(func() { releaseFreshOnce.Do(func() { close(releaseFreshSpawn) }) })
	var hookCalls atomic.Int32
	recoveryCfg.OnDialNotExist = func(ctx context.Context) error {
		call := hookCalls.Add(1)
		err := lifecycle.ensure(ctx, func(ctx context.Context) (*omorpc.EnsuredDaemon, error) {
			if call > 1 {
				close(freshSpawn)
				<-releaseFreshSpawn
			}
			return omorpc.EnsureDaemon(ctx, recoveryCfg)
		})
		if call == 1 {
			close(published)
			<-ctx.Done()
		}
		return err
	}
	initial, err := omorpc.EnsureDaemon(t.Context(), recoveryCfg)
	if err != nil {
		t.Fatalf("initial EnsureDaemon: %v", err)
	}
	lifecycle.initialize(initial)
	t.Cleanup(func() {
		lifecycle.stop()
		_ = initial.StopBounded(daemonStopTimeout)
	})
	if err := initial.StopSupervisor(t.Context()); err != nil {
		t.Fatalf("prepare missing endpoint: %v", err)
	}
	recoveryDone := make(chan error, 1)
	go func() { recoveryDone <- initial.Client.EnsureConnected(t.Context()) }()
	awaitRestartSignal(t, published, "reconnect flight did not publish its owned recovery daemon")

	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, _, err := engineRestarter(&lifecycle, initial.Client)(ctx)
		done <- err
	}()
	awaitRestartSignal(t, freshSpawn, "retirement did not create a fresh reconnect spawn opportunity")
	select {
	case err := <-done:
		t.Fatalf("restart completed before fresh successor startup: %v", err)
	default:
	}
	releaseFreshOnce.Do(func() { close(releaseFreshSpawn) })
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("restart on negotiated fresh successor: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("restart timed out after fresh successor negotiation")
	}
	if got := hookCalls.Load(); got != 2 {
		t.Fatalf("reconnect hook calls = %d, want spent flight plus one fresh flight", got)
	}
	select {
	case <-recoveryDone:
	case <-time.After(5 * time.Second):
		t.Fatal("superseded reconnect flight did not finish")
	}
}

func TestRecoverySpawnRejectedAfterUnconfirmedRetirement(t *testing.T) {
	lifecycle := recoveryDaemonLifecycle{logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	lifecycle.initialize(&omorpc.EnsuredDaemon{Owned: true})
	stopEntered := make(chan struct{})
	releaseStop := make(chan struct{})
	wantErr := errors.New("retirement unconfirmed")
	oldStop := stopSupervisorDaemon
	stopSupervisorDaemon = func(*omorpc.EnsuredDaemon, context.Context) error {
		close(stopEntered)
		<-releaseStop
		return wantErr
	}
	t.Cleanup(func() {
		stopSupervisorDaemon = oldStop
		select {
		case <-releaseStop:
		default:
			close(releaseStop)
		}
	})

	restartDone := make(chan error, 1)
	go func() {
		_, err := lifecycle.stopCurrent(t.Context(), nil)
		restartDone <- err
	}()
	awaitRestartSignal(t, stopEntered, "retirement did not reach the failure gate")
	ensureAttempted := make(chan struct{})
	spawnEntered := make(chan struct{})
	ensureDone := make(chan error, 1)
	go func() {
		close(ensureAttempted)
		ensureDone <- lifecycle.ensure(t.Context(), func(context.Context) (*omorpc.EnsuredDaemon, error) {
			close(spawnEntered)
			return nil, nil
		})
	}()
	awaitRestartSignal(t, ensureAttempted, "queued recovery did not attempt admission")
	close(releaseStop)
	if err := <-restartDone; !errors.Is(err, wantErr) {
		t.Fatalf("retirement error = %v, want %v", err, wantErr)
	}
	if err := <-ensureDone; !errors.Is(err, wantErr) {
		t.Fatalf("recovery admission error = %v, want preserved retirement error", err)
	}
	select {
	case <-spawnEntered:
		t.Fatal("recovery invoked spawn after an unconfirmed retirement")
	default:
	}
}

func TestEngineRestartJoinsRecoveryAndRefusesItsForeignPublication(t *testing.T) {
	ownedCfg, _ := ownedRecoveryEnsureConfig(t)
	owned, err := omorpc.EnsureDaemon(t.Context(), ownedCfg)
	if err != nil {
		t.Fatalf("owned daemon: %v", err)
	}
	foreignDaemon := newRunTestDaemon(t)
	lifecycle := recoveryDaemonLifecycle{logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	lifecycle.initialize(owned)
	t.Cleanup(func() { _ = owned.StopBounded(daemonStopTimeout) })
	ensureEntered := make(chan struct{})
	releaseEnsure := make(chan struct{})
	ensureDone := make(chan error, 1)
	go func() {
		ensureDone <- lifecycle.ensure(t.Context(), func(context.Context) (*omorpc.EnsuredDaemon, error) {
			close(ensureEntered)
			<-releaseEnsure
			foreign, err := omorpc.Dial(t.Context(), foreignDaemon.SocketPath())
			return &omorpc.EnsuredDaemon{Client: foreign}, err
		})
	}()
	awaitRestartSignal(t, ensureEntered, "recovery ensure did not enter")
	oldStop := stopSupervisorDaemon
	originalStopEntered := make(chan struct{}, 1)
	stopSupervisorDaemon = func(daemon *omorpc.EnsuredDaemon, ctx context.Context) error {
		originalStopEntered <- struct{}{}
		return oldStop(daemon, ctx)
	}
	t.Cleanup(func() { stopSupervisorDaemon = oldStop })
	restartAttempted := make(chan struct{})
	restarted := make(chan error, 1)
	go func() {
		close(restartAttempted)
		_, _, err := engineRestarter(&lifecycle, owned.Client)(t.Context())
		restarted <- err
	}()
	awaitRestartSignal(t, restartAttempted, "restart did not attempt the held lifecycle barrier")
	close(releaseEnsure)
	select {
	case err := <-ensureDone:
		if err != nil {
			t.Fatalf("recovery ensure: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("recovery ensure did not finish")
	}
	select {
	case err := <-restarted:
		if !errors.Is(err, omorpc.ErrDaemonNotOwned) {
			t.Fatalf("restart after foreign publication = %v, want ErrDaemonNotOwned", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("restart did not finish after foreign publication")
	}
	select {
	case <-originalStopEntered:
		t.Fatal("restart accessed the original owned handle before joining foreign publication")
	default:
	}
}

func TestRecoveryRetainCannotPublishAcrossRestartSnapshotBoundary(t *testing.T) {
	lifecycle := recoveryDaemonLifecycle{logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	lifecycle.initialize(&omorpc.EnsuredDaemon{Owned: true})
	lifecycle.barrier.Lock()
	retainAttempted := make(chan struct{})
	published := make(chan struct{})
	go func() {
		close(retainAttempted)
		lifecycle.retain(&omorpc.EnsuredDaemon{})
		close(published)
	}()
	awaitRestartSignal(t, retainAttempted, "retain did not attempt the held lifecycle barrier")
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
	case <-time.After(5 * time.Second):
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
