//go:build darwin || linux

package omorpc

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"syscall"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/procexec"
)

const retirementUnlinkWait = 2 * time.Second

type engineProcessInfo struct {
	startTime uint64
	pgid      int
	uid       int
}

// RetireUnownedEngine authenticates the engine serving this ensure endpoint,
// then retires its entire process group even without a supervisor handle.
// Identity comes from the handshaken socket peer, never mutable process argv.
func RetireUnownedEngine(ctx context.Context, cfg EnsureConfig) error {
	cfg, err := normalizeEnsureConfig(cfg)
	if err != nil {
		return err
	}
	return retireUnownedEngine(ctx, cfg, daemonStopGrace, daemonKillWait, inspectEngineProcess)
}

func retireUnownedEngine(ctx context.Context, cfg EnsureConfig, grace, killWait time.Duration, inspect func(int) (engineProcessInfo, error)) error {
	identity, exists := currentSocketIdentity(cfg.SocketPath)
	if !exists {
		return nil
	}
	// The probe must not launch or reconnect to a different peer while identity
	// is being established. Read the PID from its negotiated connection.
	cfg.OnDialNotExist = nil
	client, err := probeDaemon(ctx, cfg)
	if err != nil {
		if isSpawnableProbeError(err) {
			return cleanupRetiredSocket(ctx, cfg, identity)
		}
		return fmt.Errorf("%w: unowned engine handshake: %v", ErrDaemonNotOwned, err)
	}
	defer client.Close()
	after, exists := currentSocketIdentity(cfg.SocketPath)
	if !exists || after != identity {
		return fmt.Errorf("%w: engine socket changed during handshake", ErrDaemonNotOwned)
	}
	client.mu.Lock()
	pid := 0
	if client.current != nil {
		pid, err = connectionPeerPID(client.current.conn)
	}
	client.mu.Unlock()
	if err != nil || pid <= 1 || pid == os.Getpid() {
		return fmt.Errorf("%w: unexpected engine peer pid %d: %v", ErrDaemonNotOwned, pid, err)
	}
	info, err := inspect(pid)
	if err != nil || info.pgid != pid || info.uid != os.Getuid() {
		return fmt.Errorf("%w: engine peer %d is not a same-user group leader: %v", ErrDaemonNotOwned, pid, err)
	}
	_ = client.Close()
	if err := procexec.SignalGroup(pid, syscall.SIGTERM); err != nil {
		return fmt.Errorf("omorpc: terminate unowned engine group %d: %w", pid, err)
	}
	if !waitEngineGroupGone(ctx, pid, grace) {
		// A reused leader PID proves the old group has drained: the kernel
		// cannot reuse a PID while it still names a process group.
		now, err := inspect(pid)
		if err == nil && now.startTime != info.startTime {
			return cleanupRetiredSocket(ctx, cfg, identity)
		}
		if err != nil && !errors.Is(err, syscall.ESRCH) && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("omorpc: recheck unowned engine group %d: %w", pid, err)
		}
		if err == nil && (now.pgid != pid || now.uid != info.uid) {
			return fmt.Errorf("omorpc: unowned engine group %d identity changed before SIGKILL", pid)
		}
		// If the leader exited but descendants remain, the PGID cannot be
		// reused and still identifies the original group.
		if err := procexec.SignalGroup(pid, syscall.SIGKILL); err != nil {
			return fmt.Errorf("omorpc: kill unowned engine group %d: %w", pid, err)
		}
		if !waitEngineGroupGone(ctx, pid, killWait) {
			return fmt.Errorf("omorpc: unowned engine group %d did not exit after SIGKILL", pid)
		}
	}
	return cleanupRetiredSocket(ctx, cfg, identity)
}

func waitEngineGroupGone(ctx context.Context, pid int, limit time.Duration) bool {
	deadline := time.NewTimer(limit)
	defer deadline.Stop()
	tick := time.NewTicker(10 * time.Millisecond)
	defer tick.Stop()
	for {
		if !procexec.GroupAlive(pid) {
			return true
		}
		select {
		case <-ctx.Done():
			return false
		case <-deadline.C:
			return false
		case <-tick.C:
		}
	}
}

func cleanupRetiredSocket(ctx context.Context, cfg EnsureConfig, identity socketIdentity) error {
	cfg.LockTimeout = retirementUnlinkWait
	lock, err := acquireEnsureLock(ctx, cfg)
	if err != nil {
		slog.WarnContext(ctx, "leaving retired engine socket without ensure lock", "socket", cfg.SocketPath, "err", err)
		return nil
	}
	defer lock.Close()
	if err := removeOwnedSocket(cfg.SocketPath, &identity); err != nil {
		return &supervisorStopError{err: err, confirmed: true}
	}
	return nil
}
