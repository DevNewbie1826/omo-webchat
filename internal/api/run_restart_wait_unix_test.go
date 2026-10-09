//go:build unix || darwin || linux

package api

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

func TestEngineRestartBoundsAdmissionWait(t *testing.T) {
	// Given: recovery has entered ensure and holds admission behind a gate.
	daemon := newRetireTestDaemon(t)
	client, err := omorpc.Dial(t.Context(), daemon.SocketPath())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = client.Close() }()
	schedule := newRestartSchedule(t)
	defer schedule.close()
	retired := make(chan struct{})
	lifecycle := recoveryDaemonLifecycle{
		retireUnowned: func(context.Context) error {
			close(retired)
			return omorpc.ErrDaemonNotOwned
		},
	}
	lifecycle.initialize(&omorpc.EnsuredDaemon{Client: client})
	contended := observeAdmission(&lifecycle, "stopCurrent")
	entered := make(chan struct{})
	release := make(chan struct{})
	var releaseOnce sync.Once
	unblock := func() { releaseOnce.Do(func() { close(release) }) }
	defer unblock()
	recovered := make(chan error, 1)
	schedule.start(func() {
		recovered <- lifecycle.ensure(schedule.ctx, func(ctx context.Context) (*omorpc.EnsuredDaemon, error) {
			close(entered)
			return nil, schedule.gate(ctx, release)
		})
	})
	awaitRestartSignal(t, entered, "recovery did not enter admission gate")

	// When: subscribe to HTTP completion before triggering restart.
	done := startBudgetRestartHTTP(t, &lifecycle, client)
	awaitRestartSignal(t, contended, "restart did not contend on held admission")
	responded := observeBudgetRestartHTTP(t, done)
	select {
	case <-retired:
		t.Error("restart retired the endpoint across held recovery admission")
	default:
	}

	// Then: HTTP already responded, but admission/recovery are still intact.
	unblock()
	if err := awaitRestartResult(t, recovered); err != nil {
		t.Fatalf("recovery after HTTP timeout = %v", err)
	}
	awaitRestartSignal(t, retired, "background restart did not enter retirement after recovery")
	if !responded {
		select {
		case got := <-done:
			t.Logf("late response after gate release: HTTP%d elapsed=%s\n%s", got.status, got.elapsed, got.capture)
		case <-time.After(5 * time.Second):
			t.Fatal("HTTP caller did not finish after gate release")
		}
	}
	admitted := make(chan error, 1)
	schedule.start(func() {
		admitted <- lifecycle.ensure(schedule.ctx, func(context.Context) (*omorpc.EnsuredDaemon, error) {
			return nil, nil
		})
	})
	if err := awaitRestartResult(t, admitted); err != nil {
		t.Fatalf("post-retirement barrier admission = %v", err)
	}
	lifecycle.mu.Lock()
	if lifecycle.retirementErr != nil || lifecycle.current == nil || lifecycle.current.Owned {
		t.Error("refused late retirement left inconsistent lifecycle state")
	}
	lifecycle.mu.Unlock()
	t.Log("recovery completed after HTTP response; late no-signal retirement preserved barrier and recovery")
}

func TestEngineRestartBoundsOwnedRetirement(t *testing.T) {
	// Given: a real owned supervisor with a cleanup operation held at a gate.
	cfg, pidPath := ownedRecoveryEnsureConfig(t)
	lifecycle := recoveryDaemonLifecycle{}
	owned, err := omorpc.EnsureDaemon(t.Context(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	if !owned.Owned {
		t.Fatal("supervisor fixture was not owned")
	}
	defer func() { _ = owned.StopBounded(daemonStopTimeout) }()
	schedule := newRestartSchedule(t)
	defer schedule.close()
	lifecycle.initialize(owned)
	pidBytes, err := os.ReadFile(pidPath)
	if err != nil {
		t.Fatal(err)
	}
	var pid int
	if _, err := fmt.Sscanf(string(pidBytes), "%d", &pid); err != nil {
		t.Fatal(err)
	}
	release := make(chan struct{})
	var releaseOnce sync.Once
	unblock := func() { releaseOnce.Do(func() { close(release) }) }
	defer unblock()
	entered := make(chan struct{})
	cleaned := make(chan error, 1)
	var stops atomic.Int32
	oldStop := stopSupervisorDaemon
	stopSupervisorDaemon = func(daemon *omorpc.EnsuredDaemon, ctx context.Context) error {
		stops.Add(1)
		close(entered)
		if err := schedule.gate(ctx, release); err != nil {
			cleaned <- err
			return err
		}
		err := oldStop(daemon, ctx)
		cleaned <- err
		return err
	}
	defer func() { stopSupervisorDaemon = oldStop }()
	contended := observeAdmission(&lifecycle, "ensure")

	// When: the real HTTP caller stops waiting while retirement still owns admission.
	done := startBudgetRestartHTTP(t, &lifecycle, owned.Client)
	awaitRestartSignal(t, entered, "owned retirement did not enter gate")
	recoveryEntered := make(chan struct{})
	recovered := make(chan error, 1)
	schedule.start(func() {
		recovered <- lifecycle.ensure(schedule.ctx, func(context.Context) (*omorpc.EnsuredDaemon, error) {
			close(recoveryEntered)
			if err := syscall.Kill(-pid, 0); !errors.Is(err, syscall.ESRCH) {
				return nil, fmt.Errorf("recovery entered before group %d drained: %v", pid, err)
			}
			if _, err := os.Lstat(cfg.SocketPath); !errors.Is(err, os.ErrNotExist) {
				return nil, fmt.Errorf("recovery entered before endpoint cleanup: %v", err)
			}
			return nil, nil
		})
	})
	awaitRestartSignal(t, contended, "recovery did not contend on owned retirement")
	responded := observeBudgetRestartHTTP(t, done)
	select {
	case <-recoveryEntered:
		t.Error("recovery crossed the retirement barrier before cleanup")
	default:
	}
	if err := syscall.Kill(-pid, 0); err != nil {
		t.Errorf("retirement gate did not preserve live old group: %v", err)
	}

	// Then: after HTTP500, the old group still drains and cleanup admits recovery once.
	unblock()
	if err := awaitRestartResult(t, cleaned); err != nil {
		t.Fatalf("owned retirement cleanup after HTTP response = %v", err)
	}
	if err := awaitRestartResult(t, recovered); err != nil {
		t.Fatal(err)
	}
	if !responded {
		select {
		case got := <-done:
			t.Logf("late response after gate release: HTTP%d elapsed=%s\n%s", got.status, got.elapsed, got.capture)
		case <-time.After(5 * time.Second):
			t.Fatal("HTTP caller did not finish after gate release")
		}
	}
	lifecycle.mu.Lock()
	if stops.Load() != 1 || lifecycle.current != nil || len(lifecycle.generation) != 0 || lifecycle.retirementErr != nil {
		t.Errorf("retirement state: stops=%d current=%v generation=%d error=%v", stops.Load(), lifecycle.current, len(lifecycle.generation), lifecycle.retirementErr)
	}
	lifecycle.mu.Unlock()
	if !lifecycle.barrier.TryLock() {
		t.Fatal("retirement barrier was not released after completed cleanup")
	}
	lifecycle.barrier.Unlock()
	t.Logf("cleanup: old group %d gone, endpoint removed, retirement completed once, barrier released", pid)
}
