//go:build unix || darwin || linux

package omorpc

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/procexec"
)

func TestStopSupervisorRefusesUnowned(t *testing.T) {
	for name, daemon := range map[string]*EnsuredDaemon{
		"nil daemon":         nil,
		"not owned":          {},
		"missing supervisor": {Owned: true},
	} {
		t.Run(name, func(t *testing.T) {
			if err := daemon.StopSupervisor(t.Context()); !errors.Is(err, ErrDaemonNotOwned) {
				t.Fatalf("StopSupervisor error = %v, want ErrDaemonNotOwned", err)
			}
		})
	}

	cmd := exec.Command("sleep", "60")
	procexec.SetupCommand(cmd)
	if err := cmd.Start(); err != nil {
		t.Fatalf("start unowned process group: %v", err)
	}
	pid := cmd.Process.Pid
	t.Cleanup(func() {
		_ = syscall.Kill(-pid, syscall.SIGKILL)
		_ = cmd.Wait()
	})
	if !procexec.GroupAlive(pid) {
		t.Fatalf("unowned process group %d is not alive after start", pid)
	}

	daemon := &EnsuredDaemon{
		Owned:      false,
		supervisor: &supervisorHandle{process: cmd.Process},
	}
	if err := daemon.StopSupervisor(t.Context()); !errors.Is(err, ErrDaemonNotOwned) {
		t.Fatalf("StopSupervisor error = %v, want ErrDaemonNotOwned", err)
	}
	if !procexec.GroupAlive(pid) {
		t.Fatalf("StopSupervisor killed unowned process group %d", pid)
	}
}

func TestRestartStopSupervisorStopsOwnedGroupWithoutClosingClient(t *testing.T) {
	dir := shortEnsureTempDir(t)
	socket := filepath.Join(dir, "rpc", "rpc.sock")
	cfg := helperEnsureConfig(dir, socket, helperSupervisorScript(t), "serve")

	ensured, err := EnsureDaemon(context.Background(), cfg)
	if err != nil {
		t.Fatalf("EnsureDaemon: %v", err)
	}
	pid := ensured.supervisor.process.Pid
	t.Cleanup(func() {
		_ = ensured.StopBounded(6 * time.Second)
	})

	connectionLost := make(chan struct{}, 1)
	ensured.Client.SetEpochChangeObserver(func(prev, next EpochToken) {
		if prev.epoch != nil && next.epoch == nil {
			connectionLost <- struct{}{}
		}
	})

	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
	defer cancel()
	if err := ensured.StopSupervisor(ctx); err != nil {
		t.Fatalf("StopSupervisor: %v", err)
	}
	if procexec.GroupAlive(pid) {
		t.Fatalf("owned process group %d remains alive after StopSupervisor", pid)
	}
	if _, err := os.Lstat(socket); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("owned socket remains after StopSupervisor: %v", err)
	}
	select {
	case <-connectionLost:
	case <-ctx.Done():
		t.Fatalf("client did not observe supervisor connection loss: %v", ctx.Err())
	}

	ensured.Client.mu.Lock()
	closed := ensured.Client.closed
	ensured.Client.mu.Unlock()
	if closed {
		t.Fatal("StopSupervisor closed the shared client")
	}
	if err := ensured.StopSupervisor(ctx); err != nil {
		t.Fatalf("second StopSupervisor: %v", err)
	}

	successor, err := EnsureDaemon(ctx, cfg)
	if err != nil {
		t.Fatalf("EnsureDaemon successor: %v", err)
	}
	t.Cleanup(func() { _ = successor.StopBounded(6 * time.Second) })
	if err := ensured.Client.EnsureConnected(ctx); err != nil {
		t.Fatalf("shared client fresh dial after StopSupervisor: %v", err)
	}
	response, err := ensured.Client.Call(ctx, ListSessions{})
	if err != nil || response == nil || !response.Success {
		t.Fatalf("shared client call after fresh dial: response=%+v err=%v", response, err)
	}
}

func TestStopSupervisorDropsRuntimeWinnerCache(t *testing.T) {
	dir := shortEnsureTempDir(t)
	socket := filepath.Join(dir, "rpc", "rpc.sock")
	cfg := helperEnsureConfig(dir, socket, helperSupervisorScript(t), "serve")
	command, _, err := supervisorCommand(cfg)
	if err != nil {
		t.Fatalf("supervisorCommand: %v", err)
	}
	t.Cleanup(func() { runtimeWinnerCache.Delete(command) })

	ensured, err := EnsureDaemon(context.Background(), cfg)
	if err != nil {
		t.Fatalf("EnsureDaemon: %v", err)
	}
	t.Cleanup(func() { _ = ensured.StopBounded(6 * time.Second) })
	if _, ok := runtimeWinnerCache.Load(command); !ok {
		t.Fatalf("runtime winner cache missing %q after spawn", command)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
	defer cancel()
	if err := ensured.StopSupervisor(ctx); err != nil {
		t.Fatalf("StopSupervisor: %v", err)
	}
	if winner, ok := runtimeWinnerCache.Load(command); ok {
		t.Fatalf("runtime winner cache still holds %q after StopSupervisor: %v", command, winner)
	}
}
