package omorpc

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	requiredProtocolVersion = 1
	capMultiSession         = "multi_session"
	capExtensionEvents      = "extension_events"
)

// ErrIncompatibleDaemon reports a reachable RPC host that cannot provide the
// protocol or capabilities required by this multi-session client.
type ErrIncompatibleDaemon struct {
	ProtocolVersion     int
	MissingCapabilities []string
}

// ErrDaemonRuntimeFallback reports failure of both automatic runtime
// selection and the explicit node fallback.
type ErrDaemonRuntimeFallback struct {
	Automatic error
	Node      error
}

func (e *ErrDaemonRuntimeFallback) Error() string {
	return fmt.Sprintf("omorpc: daemon runtime fallback failed: automatic: %v; node: %v", e.Automatic, e.Node)
}

func (e *ErrDaemonRuntimeFallback) Unwrap() []error { return []error{e.Automatic, e.Node} }

// ErrRuntimeFallback is a concise alias for the typed runtime-ladder failure.
type ErrRuntimeFallback = ErrDaemonRuntimeFallback

func (e *ErrIncompatibleDaemon) Error() string {
	parts := make([]string, 0, 2)
	if e.ProtocolVersion != 0 && e.ProtocolVersion != requiredProtocolVersion {
		parts = append(parts, fmt.Sprintf("protocol version %d (want %d)", e.ProtocolVersion, requiredProtocolVersion))
	}
	if len(e.MissingCapabilities) > 0 {
		parts = append(parts, "missing capabilities "+strings.Join(e.MissingCapabilities, ", "))
	}
	if len(parts) == 0 {
		return "omorpc: incompatible daemon"
	}
	return "omorpc: incompatible daemon: " + strings.Join(parts, "; ")
}

// EnsureConfig describes both the endpoint to probe and the supervisor to
// launch when it is absent. ArgsTemplate supports {socket}, {agent-dir},
// {child-command}, and {child-args}; nil selects the native omo supervisor
// invocation documented on EnsureDaemon.
type EnsureConfig struct {
	AgentDir        string
	SocketPath      string
	BinaryPath      string
	ArgsTemplate    []string
	ChildCommand    string
	ChildArgs       []string
	ExpectedVersion string
	WorkingDir      string
	StateDir        string
	Env             []string

	ReadyTimeout time.Duration
	ProbeTimeout time.Duration
	LockTimeout  time.Duration
	LockRetry    time.Duration
}

// EnsuredDaemon is a negotiated client plus ownership metadata. Warning and
// VersionWarning carry the same non-fatal server-version mismatch text;
// VersionWarning is the more explicit field for new callers.
type EnsuredDaemon struct {
	Client         *Client
	Owned          bool
	Warning        string
	VersionWarning string
	ProtocolInfo   *ProtocolInfo

	process *os.Process
	waitCh  <-chan error

	stopOnce sync.Once
	stopDone chan struct{}
	stopErr  error
}

// Close closes the client connection. It deliberately does not terminate an
// owned daemon; use Stop for lifecycle teardown.
func (d *EnsuredDaemon) Close() error {
	if d == nil || d.Client == nil {
		return nil
	}
	return d.Client.Close()
}

// StopBounded tears down the ensured daemon using a lifecycle-owned deadline.
// It is intended for callers whose request or startup context may already be
// canceled when cleanup begins.
func (d *EnsuredDaemon) StopBounded(timeout time.Duration) error {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	return d.Stop(ctx)
}

// Stop closes the client and, when this ensure call spawned the supervisor,
// sends SIGTERM, waits up to three seconds, then falls back to SIGKILL.
func (d *EnsuredDaemon) Stop(ctx context.Context) error {
	if d == nil {
		return nil
	}
	d.stopOnce.Do(func() {
		d.stopDone = make(chan struct{})
		go func() {
			defer close(d.stopDone)
			if d.Client != nil {
				d.stopErr = d.Client.Close()
			}
			if d.Owned && d.process != nil {
				if err := stopOwnedProcess(context.Background(), d.process, d.waitCh); err != nil && d.stopErr == nil {
					d.stopErr = err
				}
			}
		}()
	})
	select {
	case <-d.stopDone:
		return d.stopErr
	case <-ctx.Done():
		return ctx.Err()
	}
}

const (
	daemonSpawnLogLimit = 1 << 20
	daemonStopGrace     = 3 * time.Second
	daemonKillWait      = time.Second
)

var (
	runtimeWinnerCache  sync.Map // resolved supervisor path -> "automatic" or "node"
	ownedProcessSockets sync.Map // supervisor pid -> ownedProcessSocket
)

type ownedProcessSocket struct {
	cfg      EnsureConfig
	identity socketIdentity
}

// EnsureDaemon reuses a compatible daemon at cfg.SocketPath. If no daemon is
// reachable, it serializes startup with an advisory lock, launches the
// supervisor, and waits for a negotiated socket within a bounded deadline.
func EnsureDaemon(ctx context.Context, cfg EnsureConfig) (*EnsuredDaemon, error) {
	cfg, err := normalizeEnsureConfig(cfg)
	if err != nil {
		return nil, err
	}

	if client, dialErr := probeDaemon(ctx, cfg); dialErr == nil {
		return checkedDaemon(client, cfg, false, nil, nil)
	} else if !isSpawnableProbeError(dialErr) {
		return nil, fmt.Errorf("omorpc: probe existing daemon: %w", dialErr)
	}

	lock, err := acquireEnsureLock(ctx, cfg)
	if err != nil {
		return nil, err
	}
	defer releaseEnsureLock(lock)

	// Another process may have completed startup while this caller waited.
	if client, dialErr := probeDaemon(ctx, cfg); dialErr == nil {
		return checkedDaemon(client, cfg, false, nil, nil)
	} else if !isSpawnableProbeError(dialErr) {
		return nil, fmt.Errorf("omorpc: probe daemon after startup lock: %w", dialErr)
	}

	if err := os.MkdirAll(filepath.Dir(cfg.SocketPath), 0o700); err != nil {
		return nil, fmt.Errorf("omorpc: create socket directory: %w", err)
	}
	if err := os.MkdirAll(cfg.StateDir, 0o700); err != nil {
		return nil, fmt.Errorf("omorpc: create daemon state directory: %w", err)
	}
	command, nativeArgs, err := supervisorCommand(cfg)
	if err != nil {
		return nil, err
	}
	automaticArgs := nativeArgs
	if cfg.ArgsTemplate == nil && cfg.ChildCommand == "" {
		automaticCfg := cfg
		automaticCfg.ChildCommand = command
		_, automaticArgs, err = supervisorCommand(automaticCfg)
		if err != nil {
			return nil, err
		}
	}

	if runtimeName, userRuntime := lookupEnv(cfg.Env, "OMO_RUNTIME"); userRuntime {
		args := automaticArgs
		if runtimeName == "node" {
			args = nativeArgs
		}
		result, attemptErr, _ := spawnDaemonAttempt(ctx, cfg, command, args, cfg.Env, "configured", false)
		return result, attemptErr
	}
	if winner, ok := runtimeWinnerCache.Load(command); ok && winner == "node" {
		result, attemptErr, _ := spawnDaemonAttempt(ctx, cfg, command, nativeArgs, setEnv(cfg.Env, "OMO_RUNTIME", "node"), "node", false)
		return result, attemptErr
	}

	result, automaticErr, retryable := spawnDaemonAttempt(ctx, cfg, command, automaticArgs, cfg.Env, "automatic", false)
	if automaticErr == nil {
		runtimeWinnerCache.Store(command, "automatic")
		return result, nil
	}
	if !retryable || ctx.Err() != nil {
		return nil, automaticErr
	}
	result, nodeErr, _ := spawnDaemonAttempt(ctx, cfg, command, nativeArgs, setEnv(cfg.Env, "OMO_RUNTIME", "node"), "node", true)
	if nodeErr == nil {
		runtimeWinnerCache.Store(command, "node")
		return result, nil
	}
	return nil, &ErrDaemonRuntimeFallback{Automatic: automaticErr, Node: nodeErr}
}

func spawnDaemonAttempt(ctx context.Context, cfg EnsureConfig, command string, args, env []string, attempt string, appendLog bool) (*EnsuredDaemon, error, bool) {
	logPath := filepath.Join(cfg.StateDir, "daemon-spawn.log")
	stderr, finishLog, err := openSpawnAttemptLog(logPath, attempt, appendLog)
	if err != nil {
		return nil, fmt.Errorf("omorpc: open daemon spawn log: %w", err), false
	}
	baseline, baselineExists := currentSocketIdentity(cfg.SocketPath)
	cmd := exec.Command(command, args...)
	cmd.Dir = cfg.WorkingDir
	cmd.Env = EnsureExtensionEventsCapability(env)
	cmd.Stdin = nil
	cmd.Stdout = nil
	cmd.Stderr = stderr
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.WaitDelay = daemonKillWait
	if err := cmd.Start(); err != nil {
		return nil, errors.Join(fmt.Errorf("omorpc: start daemon supervisor: %w", err), finishLog()), false
	}
	waitCh := make(chan error, 1)
	go func() {
		waitErr := cmd.Wait()
		waitCh <- errors.Join(waitErr, finishLog())
		close(waitCh)
	}()

	var ownedSocket *socketIdentity
	observeOwnedSocket := func() {
		identity, exists := currentSocketIdentity(cfg.SocketPath)
		if exists && (!baselineExists || identity != baseline) {
			ownedSocket = &identity
		}
	}
	cleanup := func() error {
		observeOwnedSocket()
		if err := stopOwnedProcess(context.Background(), cmd.Process, waitCh); err != nil {
			return err
		}
		return removeOwnedSocket(cfg.SocketPath, ownedSocket)
	}

	readyCtx, cancel := context.WithTimeout(ctx, cfg.ReadyTimeout)
	defer cancel()
	for {
		observeOwnedSocket()
		client, dialErr := probeDaemon(readyCtx, cfg)
		if dialErr == nil {
			result, checkErr := checkedDaemon(client, cfg, true, cmd.Process, waitCh)
			if checkErr != nil {
				if cleanupErr := cleanup(); cleanupErr != nil {
					return nil, errors.Join(checkErr, cleanupErr), false
				}
				return nil, checkErr, true
			}
			if ownedSocket != nil {
				ownedProcessSockets.Store(cmd.Process.Pid, ownedProcessSocket{cfg: cfg, identity: *ownedSocket})
			}
			return result, nil, false
		}

		select {
		case waitErr := <-waitCh:
			if waitErr == nil {
				waitErr = errors.New("supervisor exited successfully before opening the socket")
			}
			attemptErr := fmt.Errorf("omorpc: daemon supervisor exited before readiness: %w", waitErr)
			if cleanupErr := cleanup(); cleanupErr != nil {
				return nil, errors.Join(attemptErr, cleanupErr), false
			}
			return nil, attemptErr, true
		case <-readyCtx.Done():
			attemptErr := fmt.Errorf("omorpc: daemon readiness: %w", readyCtx.Err())
			if cleanupErr := cleanup(); cleanupErr != nil {
				return nil, errors.Join(attemptErr, cleanupErr), false
			}
			return nil, attemptErr, ctx.Err() == nil
		case <-time.After(cfg.LockRetry):
		}
	}
}

type socketIdentity struct {
	device uint64
	inode  uint64
}

func currentSocketIdentity(path string) (socketIdentity, bool) {
	info, err := os.Lstat(path)
	if err != nil || info.Mode()&os.ModeSocket == 0 {
		return socketIdentity{}, false
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return socketIdentity{}, false
	}
	return socketIdentity{device: uint64(stat.Dev), inode: uint64(stat.Ino)}, true
}

// removeOwnedSocket runs while EnsureDaemon holds the endpoint lock. The
// identity comparison prevents cleanup from unlinking an endpoint that
// replaced the one observed during this attempt.
func removeOwnedSocket(path string, owned *socketIdentity) error {
	if owned == nil {
		return nil
	}
	current, exists := currentSocketIdentity(path)
	if !exists || current != *owned {
		return nil
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("omorpc: remove failed daemon socket: %w", err)
	}
	return nil
}

func lookupEnv(env []string, key string) (string, bool) {
	for i := len(env) - 1; i >= 0; i-- {
		name, value, found := strings.Cut(env[i], "=")
		if found && name == key {
			return value, true
		}
	}
	return "", false
}

func setEnv(env []string, key, value string) []string {
	out := make([]string, 0, len(env)+1)
	for _, entry := range env {
		name, _, found := strings.Cut(entry, "=")
		if !found || name != key {
			out = append(out, entry)
		}
	}
	return append(out, key+"="+value)
}

func openSpawnAttemptLog(path, attempt string, appendLog bool) (*os.File, func() error, error) {
	file, err := os.CreateTemp(filepath.Dir(path), ".daemon-spawn-*.log")
	if err != nil {
		return nil, nil, err
	}
	if err := file.Chmod(0o600); err != nil {
		_ = file.Close()
		_ = os.Remove(file.Name())
		return nil, nil, err
	}
	if _, err := fmt.Fprintf(file, "omo-webchat daemon spawn attempt: %s\n", attempt); err != nil {
		_ = file.Close()
		_ = os.Remove(file.Name())
		return nil, nil, err
	}
	tempPath := file.Name()
	finish := func() error {
		closeErr := file.Close()
		defer os.Remove(tempPath)
		source, err := os.Open(tempPath)
		if err != nil {
			return errors.Join(closeErr, err)
		}
		defer source.Close()
		flags := os.O_CREATE | os.O_WRONLY | os.O_TRUNC
		if appendLog {
			flags = os.O_CREATE | os.O_WRONLY | os.O_APPEND
		}
		destination, err := os.OpenFile(path, flags, 0o600)
		if err != nil {
			return errors.Join(closeErr, err)
		}
		_, copyErr := io.Copy(destination, io.LimitReader(source, daemonSpawnLogLimit/2))
		return errors.Join(closeErr, copyErr, destination.Close())
	}
	return file, finish, nil
}

type boundedSpawnLog struct {
	file      *os.File
	remaining int64
}

func newBoundedSpawnLog(path string, limit int64) (*boundedSpawnLog, error) {
	return openBoundedSpawnLog(path, limit, false)
}

func openBoundedSpawnLog(path string, limit int64, appendLog bool) (*boundedSpawnLog, error) {
	flags := os.O_CREATE | os.O_WRONLY | os.O_TRUNC
	remaining := limit
	if appendLog {
		flags = os.O_CREATE | os.O_WRONLY | os.O_APPEND
		if info, err := os.Stat(path); err == nil {
			remaining -= min(info.Size(), limit)
		} else if !errors.Is(err, os.ErrNotExist) {
			return nil, err
		}
	}
	file, err := os.OpenFile(path, flags, 0o600)
	if err != nil {
		return nil, err
	}
	return &boundedSpawnLog{file: file, remaining: remaining}, nil
}

func (w *boundedSpawnLog) Write(p []byte) (int, error) {
	originalLen := len(p)
	if w.remaining == 0 {
		return originalLen, nil
	}
	if int64(len(p)) > w.remaining {
		p = p[:w.remaining]
	}
	n, err := w.file.Write(p)
	w.remaining -= int64(n)
	if err != nil {
		return n, err
	}
	return originalLen, nil
}

func (w *boundedSpawnLog) Close() error { return w.file.Close() }

var _ io.WriteCloser = (*boundedSpawnLog)(nil)

func normalizeEnsureConfig(cfg EnsureConfig) (EnsureConfig, error) {
	if cfg.AgentDir == "" {
		cfg.AgentDir = os.Getenv("OMO_CODING_AGENT_DIR")
		if cfg.AgentDir == "" {
			home, err := os.UserHomeDir()
			if err != nil {
				return cfg, fmt.Errorf("omorpc: resolve home directory: %w", err)
			}
			cfg.AgentDir = filepath.Join(home, ".omo", "agent")
		}
	}
	if cfg.SocketPath == "" {
		cfg.SocketPath = filepath.Join(cfg.AgentDir, "rpc", "rpc.sock")
	}
	if cfg.BinaryPath == "" {
		cfg.BinaryPath = "omo"
	}
	if cfg.ChildArgs == nil {
		cfg.ChildArgs = []string{"--mode", "rpc", "--multi-session"}
	}
	if cfg.WorkingDir == "" {
		cfg.WorkingDir = "."
	}
	if cfg.StateDir == "" {
		cfg.StateDir = filepath.Dir(cfg.SocketPath)
	}
	if cfg.Env == nil {
		cfg.Env = os.Environ()
	}
	if cfg.ReadyTimeout == 0 {
		cfg.ReadyTimeout = 10 * time.Second
	}
	if cfg.ProbeTimeout == 0 {
		cfg.ProbeTimeout = time.Second
	}
	if cfg.LockTimeout == 0 {
		cfg.LockTimeout = 2 * (cfg.ReadyTimeout + daemonStopGrace + daemonKillWait)
	}
	if cfg.LockRetry == 0 {
		cfg.LockRetry = 20 * time.Millisecond
	}
	return cfg, nil
}

func probeDaemon(ctx context.Context, cfg EnsureConfig) (*Client, error) {
	probeCtx, cancel := context.WithTimeout(ctx, cfg.ProbeTimeout)
	defer cancel()
	return Dial(probeCtx, cfg.SocketPath)
}

func checkedDaemon(client *Client, cfg EnsureConfig, owned bool, process *os.Process, waitCh <-chan error) (*EnsuredDaemon, error) {
	info := client.ProtocolInfo()
	missing := make([]string, 0, 2)
	if info == nil || !slices.Contains(info.Capabilities, capMultiSession) {
		missing = append(missing, capMultiSession)
	}
	if info == nil || !slices.Contains(info.Capabilities, capExtensionEvents) {
		missing = append(missing, capExtensionEvents)
	}
	version := 0
	if info != nil {
		version = info.ProtocolVersion
	}
	if info == nil || version != requiredProtocolVersion || len(missing) > 0 {
		_ = client.Close()
		return nil, &ErrIncompatibleDaemon{ProtocolVersion: version, MissingCapabilities: missing}
	}
	warning := ""
	if cfg.ExpectedVersion != "" && info.ServerVersion != cfg.ExpectedVersion {
		warning = fmt.Sprintf("omorpc: daemon version %q differs from expected %q", info.ServerVersion, cfg.ExpectedVersion)
	}
	return &EnsuredDaemon{
		Client: client, Owned: owned, Warning: warning, VersionWarning: warning,
		ProtocolInfo: info, process: process, waitCh: waitCh,
	}, nil
}

func ensureLockPath(cfg EnsureConfig) string {
	socketPath := filepath.Clean(cfg.SocketPath)
	return filepath.Join(filepath.Dir(socketPath), filepath.Base(socketPath)+".ensure.lock")
}

// ErrEnsureLockTimeout reports that daemon startup could not enter its
// endpoint-scoped critical section before the caller or lock deadline expired.
type ErrEnsureLockTimeout struct {
	Cause error
}

func (e *ErrEnsureLockTimeout) Error() string {
	return fmt.Sprintf("omorpc: acquire ensure lock: %v", e.Cause)
}

func (e *ErrEnsureLockTimeout) Unwrap() error { return e.Cause }

// ErrEnsureLockPathInvalid reports that the persistent ensure lock pathname is
// occupied by a symlink. The anomaly must be corrected manually.
type ErrEnsureLockPathInvalid struct {
	Path string
}

func (e *ErrEnsureLockPathInvalid) Error() string {
	return fmt.Sprintf("omorpc: acquire ensure lock: lock path %q is occupied by a symlink and must be corrected manually", e.Path)
}

var (
	errEnsureLockHeld    = errors.New("ensure lock held")
	errEnsureLockSymlink = errors.New("ensure lock is a symlink")
)

func acquireEnsureLock(ctx context.Context, cfg EnsureConfig) (*os.File, error) {
	path := ensureLockPath(cfg)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, fmt.Errorf("omorpc: create ensure lock directory: %w", err)
	}
	lockCtx, cancel := context.WithTimeout(ctx, cfg.LockTimeout)
	defer cancel()
	for {
		if err := lockCtx.Err(); err != nil {
			return nil, &ErrEnsureLockTimeout{Cause: err}
		}

		file, err := openAndFlockEnsureLock(path)
		if err == nil {
			if ctxErr := lockCtx.Err(); ctxErr != nil {
				_ = file.Close()
				return nil, &ErrEnsureLockTimeout{Cause: ctxErr}
			}
			if err := initializeEnsureLock(file); err != nil {
				_ = file.Close()
				return nil, fmt.Errorf("omorpc: initialize ensure lock: %w", err)
			}
			return file, nil
		}
		switch {
		case errors.Is(err, errEnsureLockHeld):
		case errors.Is(err, errEnsureLockSymlink):
			return nil, &ErrEnsureLockPathInvalid{Path: path}
		default:
			return nil, fmt.Errorf("omorpc: acquire ensure lock: %w", err)
		}

		if err := waitEnsureLockRetry(lockCtx, cfg.LockRetry); err != nil {
			return nil, &ErrEnsureLockTimeout{Cause: err}
		}
	}
}

func initializeEnsureLock(file *os.File) error {
	if err := file.Chmod(0o600); err != nil {
		return err
	}
	if err := file.Truncate(0); err != nil {
		return err
	}
	if _, err := file.Seek(0, 0); err != nil {
		return err
	}
	_, err := fmt.Fprintf(file, "%d\n", os.Getpid())
	return err
}

func waitEnsureLockRetry(ctx context.Context, retry time.Duration) error {
	timer := time.NewTimer(retry)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func releaseEnsureLock(file *os.File) {
	if file == nil {
		return
	}
	// Do not unlink the persistent lock file: closing drops the kernel flock,
	// while unlinking would reintroduce pathname races with other contenders.
	_ = file.Close()
}

// EnsureExtensionEventsCapability adds extension_events exactly once to the
// daemon environment. A nil environment must remain nil: in os/exec nil means
// inherit the parent environment, while a non-nil empty slice means no
// environment at all. Callers that need the capability must pass os.Environ().
func EnsureExtensionEventsCapability(env []string) []string {
	if env == nil {
		return nil
	}
	const key = "SENPI_RPC_CLIENT_CAPABILITIES"
	out := make([]string, 0, len(env)+1)
	merged := false
	for _, entry := range env {
		name, value, found := strings.Cut(entry, "=")
		if !found || name != key {
			out = append(out, entry)
			continue
		}
		if merged {
			continue
		}
		merged = true
		has := false
		for _, capability := range strings.Split(value, ",") {
			if strings.TrimSpace(capability) == capExtensionEvents {
				has = true
				break
			}
		}
		switch {
		case has:
			out = append(out, entry)
		case strings.TrimSpace(value) == "":
			out = append(out, key+"="+capExtensionEvents)
		default:
			out = append(out, key+"="+value+","+capExtensionEvents)
		}
	}
	if !merged {
		out = append(out, key+"="+capExtensionEvents)
	}
	return out
}

func isSpawnableProbeError(err error) bool {
	return errors.Is(err, os.ErrNotExist) || errors.Is(err, syscall.ENOENT) ||
		errors.Is(err, syscall.ECONNREFUSED)
}

func supervisorCommand(cfg EnsureConfig) (string, []string, error) {
	binary, err := exec.LookPath(cfg.BinaryPath)
	if err != nil {
		return "", nil, fmt.Errorf("omorpc: resolve supervisor %q: %w", cfg.BinaryPath, err)
	}
	if cfg.ChildCommand != "" {
		cfg.ChildCommand, err = exec.LookPath(cfg.ChildCommand)
		if err != nil {
			return "", nil, fmt.Errorf("omorpc: resolve child command %q: %w", cfg.ChildCommand, err)
		}
	}
	childJSON, err := json.Marshal(cfg.ChildArgs)
	if err != nil {
		return "", nil, fmt.Errorf("omorpc: encode child args: %w", err)
	}
	template := cfg.ArgsTemplate
	if template == nil {
		template = []string{
			"--internal-rpc-host-supervisor",
			"--socket", "{socket}",
			"--agent-dir", "{agent-dir}",
		}
		if cfg.ChildCommand != "" {
			template = append(template,
				"--child-command", "{child-command}",
				"--child-args", "{child-args}",
			)
		}
	}
	replacements := map[string]string{
		"{socket}": cfg.SocketPath, "{agent-dir}": cfg.AgentDir,
		"{child-command}": cfg.ChildCommand, "{child-args}": string(childJSON),
	}
	args := make([]string, len(template))
	for i, arg := range template {
		args[i] = arg
		for token, value := range replacements {
			args[i] = strings.ReplaceAll(args[i], token, value)
		}
	}
	return binary, args, nil
}

func stopOwnedProcess(ctx context.Context, process *os.Process, waitCh <-chan error) (resultErr error) {
	if process == nil {
		return nil
	}
	defer func() {
		if resultErr == nil {
			resultErr = cleanupStoppedProcessEndpoint(ctx, process.Pid)
		}
	}()
	if err := signalProcessGroup(process.Pid, syscall.SIGTERM); err != nil {
		return fmt.Errorf("omorpc: terminate daemon process group: %w", err)
	}
	grace := time.NewTimer(daemonStopGrace)
	defer grace.Stop()
	leaderReaped := false
	for !leaderReaped || processGroupAlive(process.Pid) {
		select {
		case <-waitCh:
			leaderReaped = true
			waitCh = nil
			if !processGroupAlive(process.Pid) {
				return nil
			}
		case <-ctx.Done():
			return ctx.Err()
		case <-grace.C:
			goto kill
		}
	}
	return nil

kill:
	if err := signalProcessGroup(process.Pid, syscall.SIGKILL); err != nil {
		return fmt.Errorf("omorpc: kill daemon process group: %w", err)
	}
	deadline := time.NewTimer(daemonKillWait)
	defer deadline.Stop()
	retry := time.NewTicker(10 * time.Millisecond)
	defer retry.Stop()
	for {
		if leaderReaped && !processGroupAlive(process.Pid) {
			return nil
		}
		select {
		case <-waitCh:
			leaderReaped = true
			waitCh = nil
		case <-ctx.Done():
			return ctx.Err()
		case <-deadline.C:
			return errors.New("omorpc: daemon process group did not exit after SIGKILL")
		case <-retry.C:
		}
	}
}

func cleanupStoppedProcessEndpoint(ctx context.Context, pid int) error {
	value, ok := ownedProcessSockets.LoadAndDelete(pid)
	if !ok {
		return nil
	}
	owned := value.(ownedProcessSocket)
	lock, err := acquireEnsureLock(ctx, owned.cfg)
	if err != nil {
		return fmt.Errorf("omorpc: lock stopped daemon socket cleanup: %w", err)
	}
	defer releaseEnsureLock(lock)
	return removeOwnedSocket(owned.cfg.SocketPath, &owned.identity)
}

func signalProcessGroup(pid int, signal syscall.Signal) error {
	err := syscall.Kill(-pid, signal)
	if err == nil || errors.Is(err, syscall.ESRCH) {
		return nil
	}
	return err
}

func processGroupAlive(pid int) bool {
	err := syscall.Kill(-pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}
