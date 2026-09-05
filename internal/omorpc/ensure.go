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
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/fileid"
	"github.com/DevNewbie1826/omo-webchat/internal/procexec"
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
	OnDialNotExist  func(ctx context.Context) error

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

	supervisor   *supervisorHandle
	waitCh       <-chan error
	childWrapper string

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
// tears down its platform process domain within the lifecycle timeouts.
func (d *EnsuredDaemon) Stop(ctx context.Context) error {
	if d == nil {
		return nil
	}
	d.stopOnce.Do(func() {
		d.stopDone = make(chan struct{})
		go func() {
			defer close(d.stopDone)
			defer func() {
				if d.childWrapper != "" {
					_ = os.Remove(d.childWrapper)
				}
			}()
			if d.Client != nil {
				d.stopErr = d.Client.Close()
			}
			if d.Owned && d.supervisor != nil {
				if err := stopOwnedSupervisor(context.Background(), d.supervisor, d.waitCh); err != nil && d.stopErr == nil {
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
	cfg        EnsureConfig
	provenance *endpointProvenance
}

type launcherBrandProfile struct {
	Name           string              `json:"name"`
	Command        string              `json:"command"`
	DisplayVersion string              `json:"displayVersion"`
	ConfigDir      string              `json:"configDir"`
	FlatLayout     bool                `json:"flatLayout"`
	EnvPrefix      string              `json:"envPrefix"`
	UserAgent      string              `json:"userAgent"`
	Originator     string              `json:"originator"`
	Update         launcherBrandUpdate `json:"update"`
}

type launcherBrandUpdate struct {
	PackageName  string `json:"packageName"`
	DistTag      string `json:"distTag"`
	Command      string `json:"command"`
	ChangelogURL string `json:"changelogUrl"`
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
	if err := prepareEndpoint(cfg); err != nil {
		return nil, fmt.Errorf("omorpc: prepare endpoint: %w", err)
	}
	command, nativeArgs, err := supervisorCommand(cfg)
	if err != nil {
		return nil, err
	}
	nodeArgs, nodeEnv, childAdapter, err := nodeFallbackContext(cfg, command, nativeArgs)
	if err != nil {
		return nil, err
	}
	automaticArgs := nativeArgs
	if cfg.ArgsTemplate == nil && cfg.ChildCommand == "" {
		if childAdapter != "" {
			// Both runtime attempts use the same direct-native adapter and child
			// arguments. Only the attempt environment selects the runtime.
			automaticArgs = nodeArgs
		} else {
			automaticCfg := cfg
			automaticCfg.ChildCommand = command
			_, automaticArgs, err = supervisorCommand(automaticCfg)
			if err != nil {
				return nil, err
			}
		}
	}
	keptAdapter := ""
	defer func() {
		if childAdapter != "" && childAdapter != keptAdapter {
			_ = os.Remove(childAdapter)
		}
	}()
	if runtimeName, userRuntime := lookupEnv(cfg.Env, "OMO_RUNTIME"); userRuntime {
		args, env := automaticArgs, cfg.Env
		if runtimeName == "node" {
			args, env = nodeArgs, nodeEnv
		}
		result, attemptErr, _ := spawnDaemonAttempt(ctx, cfg, command, args, env, "configured", false)
		if attemptErr == nil && result.Owned {
			keptAdapter = childAdapter
			result.childWrapper = childAdapter
		}
		return result, attemptErr
	}
	if winner, ok := runtimeWinnerCache.Load(command); ok && winner == "node" {
		result, attemptErr, _ := spawnDaemonAttempt(ctx, cfg, command, nodeArgs, nodeEnv, "node", false)
		if attemptErr == nil && result.Owned {
			keptAdapter = childAdapter
			result.childWrapper = childAdapter
		}
		return result, attemptErr
	}

	result, automaticErr, retryable := spawnDaemonAttempt(ctx, cfg, command, automaticArgs, cfg.Env, "automatic", false)
	if automaticErr == nil {
		runtimeWinnerCache.Store(command, "automatic")
		if result.Owned {
			keptAdapter = childAdapter
			result.childWrapper = childAdapter
		}
		return result, nil
	}
	if !retryable || ctx.Err() != nil {
		return nil, automaticErr
	}
	result, nodeErr, _ := spawnDaemonAttempt(ctx, cfg, command, nodeArgs, nodeEnv, "node", true)
	if nodeErr == nil {
		runtimeWinnerCache.Store(command, "node")
		if result.Owned {
			keptAdapter = childAdapter
			result.childWrapper = childAdapter
		}
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
	provenance := newEndpointProvenance(cfg.SocketPath)
	cmd := exec.Command(command, args...)
	cmd.Dir = cfg.WorkingDir
	cmd.Env = EnsureExtensionEventsCapability(env)
	cmd.Stdin = nil
	cmd.Stdout = nil
	cmd.Stderr = stderr
	procexec.SetupCommand(cmd)
	cmd.WaitDelay = daemonKillWait
	supervisor, err := startSupervisor(cmd)
	if err != nil {
		return nil, errors.Join(fmt.Errorf("omorpc: start daemon supervisor: %w", err), finishLog()), false
	}
	waitCh := make(chan error, 1)
	go func() {
		waitErr := cmd.Wait()
		waitErr = errors.Join(waitErr, finishLog())
		waitCh <- finishSupervisorWait(supervisor, waitErr)
		close(waitCh)
	}()

	cleanup := func() error {
		if err := stopOwnedSupervisor(context.Background(), supervisor, waitCh); err != nil {
			return err
		}
		return provenance.cleanupAfterReap(cfg.ProbeTimeout)
	}

	readyCtx, cancel := context.WithTimeout(ctx, cfg.ReadyTimeout)
	defer cancel()
	for {
		// A raw peer check can acknowledge a launch-owned endpoint even when
		// protocol negotiation fails. Only a positively identified out-of-group
		// peer can permanently protect an endpoint from this attempt's cleanup.
		identity, stable, peer, _ := authenticateSocketPath(readyCtx, cfg.SocketPath, supervisor.process.Pid)
		provenance.observe(identity, stable, peer)

		client, identity, stable, peer, dialErr := probeAuthenticatedDaemon(readyCtx, cfg, supervisor.process.Pid)
		if dialErr == nil && client != nil {
			provenance.observe(identity, stable, peer)
			// Unverified peers never provide launch-ownership evidence.
			if !stable || (peer == peerUnknown && !peerUnknownAccepted()) {
				_ = client.Close()
			} else {
				owned := provenance.owns(identity)
				result, checkErr := checkedDaemon(client, cfg, owned, supervisor, waitCh)
				if checkErr != nil {
					if cleanupErr := cleanup(); cleanupErr != nil {
						return nil, errors.Join(checkErr, cleanupErr), false
					}
					return nil, checkErr, true
				}
				if !owned {
					if stopErr := stopOwnedSupervisor(context.Background(), supervisor, waitCh); stopErr != nil {
						_ = client.Close()
						return nil, stopErr, false
					}
					if cleanupErr := provenance.cleanupAfterReap(cfg.ProbeTimeout); cleanupErr != nil {
						_ = client.Close()
						return nil, cleanupErr, false
					}
					result.supervisor = nil
					result.waitCh = nil
					return result, nil, false
				}
				ownedProcessSockets.Store(supervisor.process.Pid, ownedProcessSocket{cfg: cfg, provenance: provenance})
				return result, nil, false
			}
		} else if client != nil {
			_ = client.Close()
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

// socketIdentity aliases the fileid kernel identity pair so endpoint
// bookkeeping reads identically on every platform while keeping its local name.
type socketIdentity = fileid.Identity

type peerProvenance uint8

const (
	peerUnknown peerProvenance = iota
	peerOwned
	peerForeign
)

type endpointProvenance struct {
	path           string
	baseline       socketIdentity
	baselineExists bool
	peers          map[socketIdentity]peerProvenance
}

func newEndpointProvenance(path string) *endpointProvenance {
	baseline, exists := currentSocketIdentity(path)
	return &endpointProvenance{
		path: path, baseline: baseline, baselineExists: exists,
		peers: make(map[socketIdentity]peerProvenance),
	}
}

func (p *endpointProvenance) observe(identity socketIdentity, stable bool, peer peerProvenance) {
	// The unknown gate mirrors peerUnknownAccepted: see the decision in
	// spawnDaemonAttempt for the platform credential availability.
	if identity == (socketIdentity{}) || !stable || (peer == peerUnknown && !peerUnknownAccepted()) {
		return
	}
	if peer == peerForeign {
		p.peers[identity] = peerForeign
		return
	}
	if (!p.baselineExists || identity != p.baseline) && p.peers[identity] != peerForeign {
		p.peers[identity] = peerOwned
	}
}

func (p *endpointProvenance) provenance(identity socketIdentity) peerProvenance {
	return p.peers[identity]
}

func (p *endpointProvenance) owns(identity socketIdentity) bool {
	return p.provenance(identity) == peerOwned
}

func clientPeerProvenance(client *Client, processGroup int) peerProvenance {
	client.mu.Lock()
	defer client.mu.Unlock()
	if client.current == nil {
		return peerUnknown
	}
	return connectionPeerProvenance(client.current.conn, processGroup)
}

// authenticateSocketPath binds process-group authentication to one pathname
// inode. Ownership is recorded only when the connected peer and both pathname
// observations agree; an unrelated listener can never lend its inode to a
// producer from our supervisor's process group.
func authenticateSocketPath(ctx context.Context, path string, processGroup int) (socketIdentity, bool, peerProvenance, error) {
	return authenticateSocketPathWithPeerPID(ctx, path, processGroup, connectionPeerPID)
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

func openSpawnAttemptLog(path, attempt string, appendLog bool) (io.WriteCloser, func() error, error) {
	file, err := os.CreateTemp(filepath.Dir(path), ".daemon-spawn-*.log")
	if err != nil {
		return nil, nil, err
	}
	if err := file.Chmod(0o600); err != nil {
		_ = file.Close()
		_ = os.Remove(file.Name())
		return nil, nil, err
	}
	capture := &boundedSpawnLog{file: file, remaining: daemonSpawnLogLimit / 2}
	if _, err := fmt.Fprintf(capture, "omo-webchat daemon spawn attempt: %s\n", attempt); err != nil {
		_ = capture.Close()
		_ = os.Remove(file.Name())
		return nil, nil, err
	}
	tempPath := file.Name()
	finish := func() error {
		closeErr := capture.Close()
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
		_, copyErr := io.Copy(destination, source)
		return errors.Join(closeErr, copyErr, destination.Close())
	}
	return capture, finish, nil
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
	return DialWithConfig(probeCtx, cfg.SocketPath, Config{OnDialNotExist: cfg.OnDialNotExist})
}

func checkedDaemon(client *Client, cfg EnsureConfig, owned bool, supervisor *supervisorHandle, waitCh <-chan error) (*EnsuredDaemon, error) {
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
		ProtocolInfo: info, supervisor: supervisor, waitCh: waitCh,
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

// EnsureExtensionEventsCapability adds extension_events exactly once to both
// capability variables. Branded hosts prefer OMO_RPC_CLIENT_CAPABILITIES when
// it is present, while an unbranded native host reads the SENPI spelling.
func EnsureExtensionEventsCapability(env []string) []string {
	if env == nil {
		return nil
	}
	for _, key := range []string{"SENPI_RPC_CLIENT_CAPABILITIES", "OMO_RPC_CLIENT_CAPABILITIES"} {
		value, _ := lookupEnv(env, key)
		seen := make(map[string]struct{})
		capabilities := make([]string, 0, len(strings.Split(value, ","))+1)
		for _, capability := range strings.Split(value, ",") {
			capability = strings.TrimSpace(capability)
			if capability == "" {
				continue
			}
			if _, exists := seen[capability]; exists {
				continue
			}
			seen[capability] = struct{}{}
			capabilities = append(capabilities, capability)
		}
		if _, exists := seen[capExtensionEvents]; !exists {
			capabilities = append(capabilities, capExtensionEvents)
		}
		env = setEnv(env, key, strings.Join(capabilities, ","))
	}
	return env
}

// nodeFallbackContext preserves the native host while restoring launcher
// context after the supervisor's environment scrub. Live probing of the
// launcher's child environment established that SENPI_BRAND is the complete
// JSON profile below, rather than a plain display name.
func nodeFallbackContext(cfg EnsureConfig, command string, nativeArgs []string) ([]string, []string, string, error) {
	env := setEnv(cfg.Env, "OMO_RUNTIME", "node")
	env = EnsureExtensionEventsCapability(setEnv(env, "SENPI_RUNTIME", "node"))
	installation, recognized, err := resolveLauncherInstallation(command, env)
	if err != nil {
		return nil, nil, "", fmt.Errorf("omorpc: resolve node fallback launcher context: %w", err)
	}
	if !recognized {
		return nativeArgs, env, "", nil
	}
	extension, err := launcherExtensionFromRoot(installation.root)
	if err != nil {
		return nil, nil, "", fmt.Errorf("omorpc: resolve node fallback launcher context: %w", err)
	}
	profile, nativeCommand, err := launcherNativeContextFromRoot(installation.root)
	if err != nil {
		return nil, nil, "", fmt.Errorf("omorpc: resolve node fallback native context: %w", err)
	}
	wrapper, err := writeNativeChildWrapper(cfg, nativeCommand, profile, env)
	if err != nil {
		return nil, nil, "", fmt.Errorf("omorpc: write node fallback child wrapper: %w", err)
	}
	wrappedCfg := cfg
	wrappedCfg.ChildCommand = wrapper
	wrappedCfg.ChildArgs = append(slices.Clone(cfg.ChildArgs), "--extension", extension)
	_, args, err := supervisorCommand(wrappedCfg)
	if err != nil {
		_ = os.Remove(wrapper)
		return nil, nil, "", err
	}
	return args, env, wrapper, nil
}

type launcherInstallation struct {
	entry string
	root  string
}

// resolveLauncherInstallation selects one authoritative entry before any
// installation artifacts are derived. Command markers and resolved npm-style
// symlinks outrank ambient paths, which are only compatibility fallbacks.
func resolveLauncherInstallation(command string, env []string) (launcherInstallation, bool, error) {
	recognized := filepath.Base(command) == "omo"
	entry := ""
	if data, err := os.ReadFile(command); err == nil {
		for _, line := range strings.Split(string(data), "\n") {
			if value, ok := strings.CutPrefix(line, "# entry: "); ok {
				entry = strings.TrimSpace(value)
				recognized = true
				break
			}
		}
	}
	if entry == "" {
		if resolved, err := filepath.EvalSymlinks(command); err == nil && filepath.Base(resolved) == "omo.js" {
			entry = resolved
			recognized = true
		}
	}
	if !recognized {
		return launcherInstallation{}, false, nil
	}
	if entry == "" {
		for _, key := range []string{"OMO_AGENT_TOOLKIT_BIN", "OMO_BIN"} {
			if value, ok := lookupEnv(env, key); ok && value != "" {
				entry = value
				break
			}
		}
	}
	if entry == "" {
		return launcherInstallation{}, true, errors.New("launcher entry is unavailable")
	}
	if filepath.Base(entry) == "omo-agent-toolkit.js" {
		entry = filepath.Join(filepath.Dir(entry), "omo.js")
	}
	return launcherInstallation{entry: entry, root: filepath.Dir(filepath.Dir(entry))}, true, nil
}

func launcherExtension(command string, env []string) (string, bool, error) {
	installation, recognized, err := resolveLauncherInstallation(command, env)
	if err != nil || !recognized {
		return "", recognized, err
	}
	extension, err := launcherExtensionFromRoot(installation.root)
	return extension, true, err
}

func launcherExtensionFromRoot(root string) (string, error) {
	extension := filepath.Join(root, "plugin")
	info, err := os.Stat(extension)
	if err != nil {
		return "", err
	}
	if !info.IsDir() {
		return "", fmt.Errorf("%s is not a directory", extension)
	}
	return extension, nil
}

func launcherNativeContext(command string, env []string) (string, string, error) {
	installation, recognized, err := resolveLauncherInstallation(command, env)
	if err != nil {
		return "", "", err
	}
	if !recognized {
		return "", "", errors.New("launcher installation is unavailable")
	}
	return launcherNativeContextFromRoot(installation.root)
}

func launcherNativeContextFromRoot(root string) (string, string, error) {
	var manifest struct {
		Version string `json:"version"`
	}
	data, err := os.ReadFile(filepath.Join(root, "package.json"))
	if err != nil {
		return "", "", err
	}
	if err := json.Unmarshal(data, &manifest); err != nil {
		return "", "", err
	}
	profile := launcherBrandProfile{
		Name: "OmO", Command: "omo", DisplayVersion: manifest.Version,
		ConfigDir: ".omo", FlatLayout: false, EnvPrefix: "OMO",
		UserAgent: "omo", Originator: "omo",
		Update: launcherBrandUpdate{
			PackageName: "omo-ai", DistTag: "beta",
			Command:      launcherUpdateCommand(root),
			ChangelogURL: "https://github.com/code-yeongyu/oh-my-openagent/releases",
		},
	}
	encoded, err := json.Marshal(profile)
	if err != nil {
		return "", "", err
	}
	profileJSON := string(encoded)
	if err := validateLauncherBrandProfile(profileJSON); err != nil {
		return "", "", err
	}
	native, err := launcherNativeCommandFromRoot(root)
	return profileJSON, native, err
}

func validateLauncherBrandProfile(encoded string) error {
	var profile launcherBrandProfile
	if err := json.Unmarshal([]byte(encoded), &profile); err != nil {
		return err
	}
	values := []string{
		profile.Name, profile.Command, profile.DisplayVersion, profile.ConfigDir,
		profile.EnvPrefix, profile.UserAgent, profile.Originator,
		profile.Update.PackageName, profile.Update.DistTag,
		profile.Update.Command, profile.Update.ChangelogURL,
	}
	if slices.Contains(values, "") {
		return errors.New("brand profile is incomplete")
	}
	return nil
}

func launcherUpdateCommand(root string) string {
	normalized := filepath.ToSlash(filepath.Clean(root))
	if strings.HasSuffix(normalized, "/install/global/node_modules/omo-ai") {
		return fmt.Sprintf("bun add --cwd %s -g omo-ai@beta", shellQuote(root))
	}
	return "npm i -g omo-ai@beta"
}

func launcherNativeCommand(command string, env []string) (string, error) {
	installation, recognized, err := resolveLauncherInstallation(command, env)
	if err != nil {
		return "", err
	}
	if !recognized {
		return "", errors.New("launcher installation is unavailable")
	}
	return launcherNativeCommandFromRoot(installation.root)
}

func launcherNativeCommandFromRoot(root string) (string, error) {
	for dir := root; ; dir = filepath.Dir(dir) {
		candidate := filepath.Join(dir, "node_modules", "@code-yeongyu", "senpi", "dist", "cli.js")
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() && info.Mode()&0o111 != 0 {
			return candidate, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
	}
	return "", errors.New("native host executable is unavailable")
}

func writeNativeChildWrapper(cfg EnsureConfig, nativeCommand, profile string, env []string) (string, error) {
	file, err := os.CreateTemp(cfg.StateDir, ".daemon-child-*.sh")
	if err != nil {
		return "", err
	}
	path := file.Name()
	cleanup := func(err error) (string, error) {
		_ = file.Close()
		_ = os.Remove(path)
		return "", err
	}
	senpiCapabilities, _ := lookupEnv(env, "SENPI_RPC_CLIENT_CAPABILITIES")
	omoCapabilities, _ := lookupEnv(env, "OMO_RPC_CLIENT_CAPABILITIES")
	if err := validateLauncherBrandProfile(profile); err != nil {
		return cleanup(fmt.Errorf("validate child brand profile: %w", err))
	}
	// The adapter must remain transparent to the supervisor: exec preserves
	// direct-parent watchdog semantics, and the explicit redirection carries
	// the supervisor-owned descriptor into the native host as fd 3.
	script := fmt.Sprintf(`#!/bin/sh
export SENPI_BRAND=%s
export SENPI_RPC_CLIENT_CAPABILITIES=%s
export OMO_RPC_CLIENT_CAPABILITIES=%s
if [ "${OMO_RUNTIME-}" != node ] && [ "${SENPI_RUNTIME-}" = bun ]; then
  exec bun %s "$@" 3>&3
fi
export SENPI_RUNTIME=node
exec %s "$@" 3>&3
`, shellQuote(profile), shellQuote(senpiCapabilities), shellQuote(omoCapabilities), shellQuote(nativeCommand), shellQuote(nativeCommand))
	if _, err := io.WriteString(file, script); err != nil {
		return cleanup(err)
	}
	if err := file.Chmod(0o700); err != nil {
		return cleanup(err)
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(path)
		return "", err
	}
	return path, nil
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
}

func supervisorCommand(cfg EnsureConfig) (string, []string, error) {
	binary, err := resolveOmoBinary(cfg.BinaryPath)
	if err != nil {
		return "", nil, err
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

func stopOwnedSupervisor(ctx context.Context, supervisor *supervisorHandle, waitCh <-chan error) (resultErr error) {
	if supervisor == nil || supervisor.process == nil {
		return nil
	}
	defer func() {
		if resultErr == nil {
			resultErr = cleanupStoppedProcessEndpoint(ctx, supervisor.process.Pid)
		}
	}()
	return terminateSupervisor(ctx, supervisor, waitCh, daemonStopGrace, daemonKillWait)
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
	return owned.provenance.cleanupAfterReap(owned.cfg.ProbeTimeout)
}
