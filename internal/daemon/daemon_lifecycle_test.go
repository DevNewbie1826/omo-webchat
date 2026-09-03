//go:build darwin || linux

package daemon

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/config"
)

const (
	daemonHelperScenarioEnv = "TH_TEST_DAEMON_SCENARIO"
	daemonHelperStateEnv    = "TH_TEST_DAEMON_STATE"
	daemonHelperPIDFile  = "helper.pid"
	daemonProcessTimeout = 15 * time.Second
)

// TestDaemonLifecycleHelper is re-executed as the daemon child. Keeping the
// helper in the package test binary exercises the real descriptor handoff and
// process lifecycle without invoking the server or using the user's state.
func TestDaemonLifecycleHelper(t *testing.T) {
	scenario := os.Getenv(daemonHelperScenarioEnv)
	if scenario == "" {
		return
	}
	stateDir := os.Getenv(daemonHelperStateEnv)
	if stateDir == "" {
		t.Fatal("helper state directory is missing")
	}

	switch scenario {
	case "malformed-descriptors":
		child, err := prepareChild(stateDir)
		if err == nil {
			_ = closeChild(child)
			t.Fatal("prepareChild() succeeded with malformed descriptors")
		}
		if !strings.Contains(err.Error(), "descriptors missing") {
			t.Fatalf("prepareChild() error = %v, want descriptor validation error", err)
		}
		return
	}

	child, err := prepareChild(stateDir)
	if err != nil {
		t.Fatalf("helper prepareChild() error = %v", err)
	}
	defer func() {
		if child.lockFile != nil {
			_ = closeChild(child)
		}
	}()
	if err := os.WriteFile(filepath.Join(stateDir, daemonHelperPIDFile), []byte(fmt.Sprintf("%d\n", os.Getpid())), 0o600); err != nil {
		t.Fatalf("writing helper pid: %v", err)
	}

	switch scenario {
	case "ready-term":
		term := make(chan os.Signal, 1)
		signal.Notify(term, syscall.SIGTERM)
		defer signal.Stop(term)
		if err := childReady(child); err != nil {
			t.Fatalf("childReady() error = %v", err)
		}
		select {
		case got := <-term:
			if got != syscall.SIGTERM {
				t.Fatalf("signal = %v, want SIGTERM", got)
			}
		case <-time.After(daemonProcessTimeout):
			t.Fatal("timed out waiting for SIGTERM")
		}
		if err := RemoveChildPIDFile(stateDir); err != nil {
			t.Fatalf("RemoveChildPIDFile() error = %v", err)
		}
		if err := closeChild(child); err != nil {
			t.Fatalf("closeChild() error = %v", err)
		}
		child.lockFile = nil
	case "exit-before-ready":
		if err := writePIDFile(child.pidPath, os.Getpid()); err != nil {
			t.Fatalf("writing pre-ready pid: %v", err)
		}
	case "readiness-timeout":
		if err := writePIDFile(child.pidPath, os.Getpid()); err != nil {
			t.Fatalf("writing pre-ready pid: %v", err)
		}
		waitForForcedTermination(t)
	case "ignore-term":
		signal.Ignore(syscall.SIGTERM)
		defer signal.Reset(syscall.SIGTERM)
		if err := childReady(child); err != nil {
			t.Fatalf("childReady() error = %v", err)
		}
		waitForForcedTermination(t)
	default:
		t.Fatalf("unknown helper scenario %q", scenario)
	}
}

func waitForForcedTermination(t *testing.T) {
	t.Helper()
	select {}
}

type lifecycleProcess struct {
	process *os.Process
	waited  bool
}

func trackLifecycleProcess(t *testing.T, pid int) *lifecycleProcess {
	t.Helper()
	process, err := os.FindProcess(pid)
	if err != nil {
		t.Fatalf("finding helper process %d: %v", pid, err)
	}
	tracked := &lifecycleProcess{process: process}
	t.Cleanup(func() {
		if tracked.waited {
			return
		}
		_ = tracked.process.Kill()
		tracked.wait(t, true)
	})
	return tracked
}

func (p *lifecycleProcess) wait(t *testing.T, allowSignalExit bool) {
	t.Helper()
	if p.waited {
		return
	}
	done := make(chan error, 1)
	go func() {
		_, err := p.process.Wait()
		done <- err
	}()
	select {
	case err := <-done:
		p.waited = true
		var exitErr *exec.ExitError
		if err != nil && !(allowSignalExit && errors.As(err, &exitErr)) {
			t.Errorf("waiting for helper process: %v", err)
		}
	case <-time.After(daemonProcessTimeout):
		t.Errorf("timed out waiting for helper process %d", p.process.Pid)
	}
}

func helperConfig(stateDir string) *config.Config {
	return &config.Config{Host: "127.0.0.1", Port: 8080, StateDir: stateDir}
}

func startLifecycleHelper(t *testing.T, scenario, stateDir string) (int, string, error) {
	t.Helper()
	t.Setenv(daemonHelperScenarioEnv, scenario)
	t.Setenv(daemonHelperStateEnv, stateDir)
	return start(helperConfig(stateDir), []string{"-test.run=^TestDaemonLifecycleHelper$"})
}

func readHelperPID(t *testing.T, stateDir string) int {
	t.Helper()
	pid, err := readPIDFile(filepath.Join(stateDir, daemonHelperPIDFile))
	if err != nil {
		t.Fatalf("reading helper pid: %v", err)
	}
	return pid
}

func requirePIDFileAbsent(t *testing.T, stateDir string) {
	t.Helper()
	pidPath, _, _, err := daemonPaths(stateDir)
	if err != nil {
		t.Fatalf("daemonPaths() error = %v", err)
	}
	if _, err := os.Stat(pidPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("pid file stat error = %v, want not exist", err)
	}
}

func requireProcessGone(t *testing.T, pid int) {
	t.Helper()
	if err := syscall.Kill(pid, 0); !errors.Is(err, syscall.ESRCH) {
		t.Fatalf("process %d still exists after lifecycle cleanup (kill(0) error = %v)", pid, err)
	}
}

func TestDaemonStartStatusAndGracefulStop(t *testing.T) {
	stateDir := t.TempDir()
	pid, addr, err := startLifecycleHelper(t, "ready-term", stateDir)
	if err != nil {
		t.Fatalf("start() error = %v", err)
	}
	process := trackLifecycleProcess(t, pid)
	if addr != "127.0.0.1:8080" {
		t.Fatalf("start() address = %q, want 127.0.0.1:8080", addr)
	}
	if helperPID := readHelperPID(t, stateDir); helperPID != pid {
		t.Fatalf("helper pid = %d, start pid = %d", helperPID, pid)
	}
	statusPID, err := status(stateDir)
	if err != nil {
		t.Fatalf("status() error = %v", err)
	}
	if statusPID != pid {
		t.Fatalf("status() pid = %d, want %d", statusPID, pid)
	}
	stoppedPID, err := stop(stateDir)
	if err != nil {
		t.Fatalf("stop() error = %v", err)
	}
	if stoppedPID != pid {
		t.Fatalf("stop() pid = %d, want %d", stoppedPID, pid)
	}
	process.wait(t, false)
	requirePIDFileAbsent(t, stateDir)
	requireProcessGone(t, pid)
	if _, err := status(stateDir); !errors.Is(err, ErrNotRunning) {
		t.Fatalf("status() after stop error = %v, want ErrNotRunning", err)
	}
}

func TestDaemonChildExitBeforeReadyCleansUp(t *testing.T) {
	stateDir := t.TempDir()
	_, _, err := startLifecycleHelper(t, "exit-before-ready", stateDir)
	if err == nil || !strings.Contains(err.Error(), "failed to start") {
		t.Fatalf("start() error = %v, want failed-start error", err)
	}
	pid := readHelperPID(t, stateDir)
	requirePIDFileAbsent(t, stateDir)
	requireProcessGone(t, pid)
	lockPath := filepath.Join(stateDir, lockFileName)
	lockFile, held, lockErr := lockAcquire(lockPath)
	if lockErr != nil {
		t.Fatalf("lockAcquire() after failed start error = %v", lockErr)
	}
	if held {
		t.Fatal("daemon lock remains held after child exited before readiness")
	}
	_ = lockFile.Close()
}

func TestDaemonReadinessTimeoutCleansUp(t *testing.T) {
	readinessTimeout = 50 * time.Millisecond
	t.Cleanup(func() { readinessTimeout = startTimeout })
	stateDir := t.TempDir()
	// Parent-side PID: under heavy parallelism (race builds) the parent can
	// time out and reap the child before the child ever schedules, so the
	// helper PID file may never exist. start() returns the PID it spawned.
	pid, _, err := startLifecycleHelper(t, "readiness-timeout", stateDir)
	if err == nil || !strings.Contains(err.Error(), "failed to start") {
		t.Fatalf("start() error = %v, want failed-start error", err)
	}
	requirePIDFileAbsent(t, stateDir)
	requireProcessGone(t, pid)
	lockFile, held, lockErr := lockAcquire(filepath.Join(stateDir, lockFileName))
	if lockErr != nil {
		t.Fatalf("lockAcquire() after readiness timeout error = %v", lockErr)
	}
	if held {
		t.Fatal("daemon lock remains held after readiness timeout cleanup")
	}
	_ = lockFile.Close()
}

func TestDaemonStalePIDCleanup(t *testing.T) {
	for _, operation := range []struct {
		name string
		run  func(string) (int, error)
	}{
		{name: "status", run: status},
		{name: "stop", run: stop},
	} {
		t.Run(operation.name, func(t *testing.T) {
			stateDir := t.TempDir()
			pidPath, _, _, err := daemonPaths(stateDir)
			if err != nil {
				t.Fatalf("daemonPaths() error = %v", err)
			}
			if err := writePIDFile(pidPath, 99999999); err != nil {
				t.Fatalf("writePIDFile() error = %v", err)
			}
			if _, err := operation.run(stateDir); !errors.Is(err, ErrNotRunning) {
				t.Fatalf("%s() error = %v, want ErrNotRunning", operation.name, err)
			}
			requirePIDFileAbsent(t, stateDir)
		})
	}
}

func TestPrepareChildRejectsMalformedDescriptors(t *testing.T) {
	tests := []struct {
		name       string
		extraFiles func(*testing.T) []*os.File
	}{
		{name: "missing"},
		{
			name: "lock-is-pipe",
			extraFiles: func(t *testing.T) []*os.File {
				lockReader, lockWriter, err := os.Pipe()
				if err != nil {
					t.Fatalf("creating fake lock pipe: %v", err)
				}
				readyReader, readyWriter, err := os.Pipe()
				if err != nil {
					_ = lockReader.Close()
					_ = lockWriter.Close()
					t.Fatalf("creating readiness pipe: %v", err)
				}
				t.Cleanup(func() {
					_ = lockReader.Close()
					_ = lockWriter.Close()
					_ = readyReader.Close()
					_ = readyWriter.Close()
				})
				return []*os.File{lockReader, readyWriter}
			},
		},
		{
			name: "ready-is-regular-file",
			extraFiles: func(t *testing.T) []*os.File {
				lockFile, err := os.CreateTemp(t.TempDir(), "lock")
				if err != nil {
					t.Fatalf("creating fake lock file: %v", err)
				}
				readyFile, err := os.CreateTemp(t.TempDir(), "ready")
				if err != nil {
					_ = lockFile.Close()
					t.Fatalf("creating fake ready file: %v", err)
				}
				t.Cleanup(func() {
					_ = lockFile.Close()
					_ = readyFile.Close()
				})
				return []*os.File{lockFile, readyFile}
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			stateDir := t.TempDir()
			cmd := exec.Command(os.Args[0], "-test.run=^TestDaemonLifecycleHelper$")
			cmd.Env = append(os.Environ(), daemonHelperScenarioEnv+"=malformed-descriptors", daemonHelperStateEnv+"="+stateDir)
			if test.extraFiles != nil {
				cmd.ExtraFiles = test.extraFiles(t)
			}
			if output, err := cmd.CombinedOutput(); err != nil {
				t.Fatalf("malformed descriptor helper error = %v, output = %s", err, output)
			}
			requirePIDFileAbsent(t, stateDir)
		})
	}
}

func TestDaemonStopFallsBackToSIGKILL(t *testing.T) {
	stateDir := t.TempDir()
	pid, _, err := startLifecycleHelper(t, "ignore-term", stateDir)
	if err != nil {
		t.Fatalf("start() error = %v", err)
	}
	process := trackLifecycleProcess(t, pid)
	stoppedPID, err := stop(stateDir)
	if err != nil {
		t.Fatalf("stop() error = %v", err)
	}
	if stoppedPID != pid {
		t.Fatalf("stop() pid = %d, want %d", stoppedPID, pid)
	}
	process.wait(t, true)
	requirePIDFileAbsent(t, stateDir)
	requireProcessGone(t, pid)
}
