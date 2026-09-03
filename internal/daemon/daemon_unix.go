//go:build darwin || linux

package daemon

import (
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/config"
)

const (
	// Startup may include two 10-second provider readiness attempts plus
	// teardown between them before the HTTP listener can report ready.
	startTimeout     = 30 * time.Second
	stopTimeout      = 5 * time.Second
	killTimeout      = 2 * time.Second
	childLockFD      = 3
	childReadyPipeFD = 4
)

var readinessTimeout = startTimeout

func start(cfg *config.Config, args []string) (int, string, error) {
	pidPath, logPath, lockPath, err := daemonPaths(cfg.StateDir)
	if err != nil {
		return 0, "", err
	}
	// The store default creates itself on demand; an explicit state dir may
	// not exist yet, so ensure the lock file's directory before opening it.
	if err := os.MkdirAll(filepath.Dir(lockPath), 0o700); err != nil {
		return 0, "", fmt.Errorf("creating state directory: %w", err)
	}
	lockFile, err := openLockFile(lockPath)
	if err != nil {
		return 0, "", err
	}
	if err := syscall.Flock(int(lockFile.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = lockFile.Close()
		if isLockHeld(err) {
			pid, _ := readPIDFile(pidPath)
			if pid > 0 {
				return 0, "", fmt.Errorf("already running (pid %d)", pid)
			}
			return 0, "", errors.New("already running (starting up)")
		}
		return 0, "", fmt.Errorf("locking daemon state: %w", err)
	}
	defer func() { _ = lockFile.Close() }()

	if err := removePIDFile(pidPath); err != nil {
		return 0, "", err
	}
	logFile, err := os.OpenFile(logPath, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o600)
	if err != nil {
		return 0, "", fmt.Errorf("opening daemon log file: %w", err)
	}
	defer func() { _ = logFile.Close() }()
	stdin, err := os.Open(os.DevNull)
	if err != nil {
		return 0, "", fmt.Errorf("opening %s: %w", os.DevNull, err)
	}
	defer func() { _ = stdin.Close() }()
	readyReader, readyWriter, err := os.Pipe()
	if err != nil {
		return 0, "", fmt.Errorf("creating daemon readiness pipe: %w", err)
	}
	defer func() { _ = readyReader.Close() }()

	executable, err := os.Executable()
	if err != nil {
		_ = readyWriter.Close()
		return 0, "", fmt.Errorf("resolving executable: %w", err)
	}
	cmd := exec.Command(executable, args...)
	cmd.Env = append(os.Environ(), "TH_DAEMON_CHILD=1")
	cmd.Stdin = stdin
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	cmd.ExtraFiles = []*os.File{lockFile, readyWriter}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		_ = readyWriter.Close()
		return 0, "", fmt.Errorf("starting daemon child: %w", err)
	}
	_ = readyWriter.Close()

	if err := waitForReady(readyReader); err != nil {
		killAndWait(cmd.Process)
		// The deferred lockFile close keeps the lock held through this cleanup,
		// so no successor can interleave its pid file write.
		if removeErr := removePIDFileIfOwned(pidPath, cmd.Process.Pid); removeErr != nil {
			return 0, "", removeErr
		}
		return 0, "", fmt.Errorf("daemon failed to start; see %s", logPath)
	}
	return cmd.Process.Pid, net.JoinHostPort(cfg.Host, fmt.Sprint(cfg.Port)), nil
}

func stop(stateDir string) (int, error) {
	// Residual: if the daemon dies and a new start wins the lock within one
	// poll interval, the SIGKILL fallback below can target a recycled PID.
	// Eliminating this needs a separate lifecycle-operation lock; accepted for
	// a single-user local daemon (see .omo/ulw-loop/evidence/code-review-round3.md R3-2).
	pidPath, _, lockPath, err := daemonPaths(stateDir)
	if err != nil {
		return 0, err
	}
	lockFile, held, err := lockAcquire(lockPath)
	if err != nil {
		return 0, err
	}
	if !held {
		defer func() { _ = lockFile.Close() }()
		if err := removePIDFile(pidPath); err != nil {
			return 0, err
		}
		return 0, ErrNotRunning
	}
	pid, err := readPIDFile(pidPath)
	if err != nil {
		return 0, fmt.Errorf("reading daemon pid: %w", err)
	}
	if err := syscall.Kill(pid, syscall.SIGTERM); err != nil && !errors.Is(err, syscall.ESRCH) {
		return 0, fmt.Errorf("sending SIGTERM to pid %d: %w", pid, err)
	}
	lockFile, err = waitForLockFree(lockPath, stopTimeout)
	if errors.Is(err, errLockReleaseTimeout) {
		if killErr := syscall.Kill(pid, syscall.SIGKILL); killErr != nil && !errors.Is(killErr, syscall.ESRCH) {
			return 0, fmt.Errorf("sending SIGKILL to pid %d: %w", pid, killErr)
		}
		lockFile, err = waitForLockFree(lockPath, killTimeout)
	}
	if err != nil {
		return 0, err
	}
	defer func() { _ = lockFile.Close() }()
	if err := removePIDFileIfOwned(pidPath, pid); err != nil {
		return 0, err
	}
	return pid, nil
}

func status(stateDir string) (int, error) {
	pidPath, _, lockPath, err := daemonPaths(stateDir)
	if err != nil {
		return 0, err
	}
	lockFile, held, err := lockAcquire(lockPath)
	if err != nil {
		return 0, err
	}
	if !held {
		defer func() { _ = lockFile.Close() }()
		if err := removePIDFile(pidPath); err != nil {
			return 0, err
		}
		return 0, ErrNotRunning
	}
	pid, err := readPIDFile(pidPath)
	if err != nil {
		return 0, nil
	}
	return pid, nil
}

func prepareChild(stateDir string) (*Child, error) {
	pidPath, _, _, err := daemonPaths(stateDir)
	if err != nil {
		return nil, err
	}
	lockFile := os.NewFile(childLockFD, "daemon-lock")
	readyWriter := os.NewFile(childReadyPipeFD, "daemon-ready")
	if lockFile == nil || readyWriter == nil || !validChildDescriptors(lockFile, readyWriter) {
		if lockFile != nil {
			_ = lockFile.Close()
		}
		if readyWriter != nil {
			_ = readyWriter.Close()
		}
		return nil, errors.New("daemon lock/pipe descriptors missing")
	}
	// The daemon must hold the lock for its whole life but never hand it to
	// the processes it spawns: an inherited lock fd survives the daemon inside
	// descendant processes, and then --stop reports not running while --daemon reports
	// "already running (starting up)" with no recovery path.
	if err := setCloseOnExec(lockFile); err != nil {
		_ = lockFile.Close()
		_ = readyWriter.Close()
		return nil, fmt.Errorf("marking daemon lock close-on-exec: %w", err)
	}
	return &Child{lockFile: lockFile, readyWriter: readyWriter, pidPath: pidPath}, nil
}

func setCloseOnExec(file *os.File) error {
	_, _, errno := syscall.Syscall(syscall.SYS_FCNTL, file.Fd(), syscall.F_SETFD, syscall.FD_CLOEXEC)
	if errno != 0 {
		return errno
	}
	return nil
}

func validChildDescriptors(lockFile, readyWriter *os.File) bool {
	// Type checks only; a caller who forges TH_DAEMON_CHILD plus its own fds
	// could serve without the lock, which grants nothing beyond foreground
	// serving (accepted residual, code-review-round3.md R3-1).
	lockInfo, lockErr := lockFile.Stat()
	readyInfo, readyErr := readyWriter.Stat()
	return lockErr == nil && readyErr == nil && lockInfo.Mode().IsRegular() && readyInfo.Mode()&os.ModeNamedPipe != 0
}

func childReady(child *Child) error {
	if err := writePIDFile(child.pidPath, os.Getpid()); err != nil {
		return err
	}
	if _, err := child.readyWriter.Write([]byte{1}); err != nil {
		_ = child.readyWriter.Close()
		return fmt.Errorf("signaling daemon readiness: %w", err)
	}
	if err := child.readyWriter.Close(); err != nil {
		return fmt.Errorf("closing daemon readiness pipe: %w", err)
	}
	child.readyWriter = nil
	return nil
}

func closeChild(child *Child) error {
	return child.lockFile.Close()
}

func waitForReady(ready *os.File) error {
	if err := ready.SetReadDeadline(time.Now().Add(readinessTimeout)); err != nil {
		return fmt.Errorf("setting readiness deadline: %w", err)
	}
	var signal [1]byte
	n, err := ready.Read(signal[:])
	if n == 1 {
		return nil
	}
	if err != nil {
		return fmt.Errorf("waiting for daemon readiness: %w", err)
	}
	return errors.New("daemon readiness pipe closed without a signal")
}

func killAndWait(process *os.Process) {
	_ = process.Kill()
	_, _ = process.Wait()
}
