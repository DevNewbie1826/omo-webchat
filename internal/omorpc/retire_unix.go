//go:build darwin || linux

package omorpc

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const (
	unownedEngineStopGrace = 15 * time.Second
	unownedEngineKillWait  = 5 * time.Second
)

// SocketPathFor resolves the endpoint EnsureDaemon would use for cfg.
func SocketPathFor(cfg EnsureConfig) (string, error) {
	cfg, err := normalizeEnsureConfig(cfg)
	if err != nil {
		return "", err
	}
	return cfg.SocketPath, nil
}

// RetireUnownedEngine stops the engine listening at socketPath when this
// server holds no supervisor handle for it: an engine that survived a killed
// server, was adopted from another launcher, or whose handle was lost after a
// failed restart. The listener is identified by its socket peer PID and must
// look like an omo engine; a missing or refusing endpoint needs no stop.
func RetireUnownedEngine(ctx context.Context, socketPath string) error {
	identity, exists := currentSocketIdentity(socketPath)
	if !exists {
		return nil
	}
	dialCtx, cancel := context.WithTimeout(ctx, time.Second)
	var dialer net.Dialer
	conn, err := dialer.DialContext(dialCtx, "unix", socketPath)
	cancel()
	if err != nil {
		if isSpawnableProbeError(err) {
			return removeOwnedSocket(socketPath, &identity)
		}
		return fmt.Errorf("omorpc: probe unowned engine: %w", err)
	}
	pid, err := connectionPeerPID(conn)
	_ = conn.Close()
	if err != nil {
		return fmt.Errorf("%w: identify engine process: %v", ErrDaemonNotOwned, err)
	}
	if pid <= 1 || pid == os.Getpid() {
		return fmt.Errorf("%w: unexpected engine peer pid %d", ErrDaemonNotOwned, pid)
	}
	if !looksLikeEngine(pid) {
		return fmt.Errorf("%w: socket peer pid %d is not an omo engine", ErrDaemonNotOwned, pid)
	}
	if err := syscall.Kill(pid, syscall.SIGTERM); err != nil && !errors.Is(err, syscall.ESRCH) {
		return fmt.Errorf("omorpc: stop unowned engine %d: %w", pid, err)
	}
	if !waitProcessExit(ctx, pid, unownedEngineStopGrace) {
		target := pid
		if pgid, err := syscall.Getpgid(pid); err == nil && pgid == pid {
			target = -pid
		}
		_ = syscall.Kill(target, syscall.SIGKILL)
		if !waitProcessExit(ctx, pid, unownedEngineKillWait) {
			return fmt.Errorf("omorpc: unowned engine %d did not exit", pid)
		}
	}
	return removeOwnedSocket(socketPath, &identity)
}

func looksLikeEngine(pid int) bool {
	out, err := exec.Command("ps", "-o", "command=", "-p", strconv.Itoa(pid)).Output()
	if err != nil {
		return false
	}
	command := strings.ToLower(string(out))
	return strings.Contains(command, "omo") || strings.Contains(command, "senpi")
}

func waitProcessExit(ctx context.Context, pid int, limit time.Duration) bool {
	deadline := time.Now().Add(limit)
	for {
		var status syscall.WaitStatus
		if reaped, _ := syscall.Wait4(pid, &status, syscall.WNOHANG, nil); reaped == pid {
			return true
		}
		if err := syscall.Kill(pid, 0); errors.Is(err, syscall.ESRCH) {
			return true
		}
		if time.Now().After(deadline) || ctx.Err() != nil {
			return false
		}
		time.Sleep(100 * time.Millisecond)
	}
}
