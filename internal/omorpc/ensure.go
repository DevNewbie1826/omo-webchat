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
	"strconv"
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

// EnsureDaemon reuses a compatible daemon at cfg.SocketPath. If no daemon is
// reachable, it serializes startup with an O_EXCL lock, launches the
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
	defer releaseEnsureLock(lock, ensureLockPath(cfg))

	// Another process may have completed startup while this caller waited.
	if client, dialErr := probeDaemon(ctx, cfg); dialErr == nil {
		return checkedDaemon(client, cfg, false, nil, nil)
	} else if !isSpawnableProbeError(dialErr) {
		return nil, fmt.Errorf("omorpc: probe daemon after startup lock: %w", dialErr)
	}

	if err := os.MkdirAll(filepath.Dir(cfg.SocketPath), 0o700); err != nil {
		return nil, fmt.Errorf("omorpc: create socket directory: %w", err)
	}
	command, args, err := supervisorCommand(cfg)
	if err != nil {
		return nil, err
	}
	cmd := exec.Command(command, args...)
	cmd.Dir = cfg.WorkingDir
	cmd.Env = ensureExtensionEventsCapability(cfg.Env)
	cmd.Stdin = nil
	cmd.Stdout = nil
	cmd.Stderr = nil
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("omorpc: start daemon supervisor: %w", err)
	}
	waitCh := make(chan error, 1)
	go func() { waitCh <- cmd.Wait() }()

	readyCtx, cancel := context.WithTimeout(ctx, cfg.ReadyTimeout)
	defer cancel()
	for {
		client, dialErr := probeDaemon(readyCtx, cfg)
		if dialErr == nil {
			result, checkErr := checkedDaemon(client, cfg, true, cmd.Process, waitCh)
			if checkErr != nil {
				_ = stopOwnedProcess(context.Background(), cmd.Process, waitCh)
				return nil, checkErr
			}
			return result, nil
		}

		select {
		case waitErr := <-waitCh:
			if waitErr == nil {
				waitErr = errors.New("supervisor exited successfully before opening the socket")
			}
			return nil, fmt.Errorf("omorpc: daemon supervisor exited before readiness: %w", waitErr)
		case <-readyCtx.Done():
			_ = stopOwnedProcess(context.Background(), cmd.Process, waitCh)
			return nil, fmt.Errorf("omorpc: daemon readiness: %w", readyCtx.Err())
		case <-time.After(cfg.LockRetry):
		}
	}
}

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
		cfg.LockTimeout = 10 * time.Second
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

func acquireEnsureLock(ctx context.Context, cfg EnsureConfig) (*os.File, error) {
	path := ensureLockPath(cfg)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, fmt.Errorf("omorpc: create ensure lock directory: %w", err)
	}
	lockCtx, cancel := context.WithTimeout(ctx, cfg.LockTimeout)
	defer cancel()
	for {
		file, err := createEnsureLock(path)
		if err == nil {
			return file, nil
		}
		if !errors.Is(err, os.ErrExist) {
			return nil, fmt.Errorf("omorpc: acquire ensure lock: %w", err)
		}
		stale, staleErr := openStaleEnsureLock(path)
		if errors.Is(staleErr, os.ErrNotExist) {
			continue
		}
		if staleErr != nil {
			return nil, fmt.Errorf("omorpc: inspect ensure lock: %w", staleErr)
		}
		if stale != nil {
			if err := removeEnsureLockIfSame(stale, path); err != nil {
				return nil, fmt.Errorf("omorpc: reclaim ensure lock: %w", err)
			}
			continue
		}
		select {
		case <-lockCtx.Done():
			return nil, fmt.Errorf("omorpc: acquire ensure lock: %w", lockCtx.Err())
		case <-time.After(cfg.LockRetry):
		}
	}
}

func createEnsureLock(path string) (*os.File, error) {
	temp, err := os.CreateTemp(filepath.Dir(path), ".ensure-pid-*")
	if err != nil {
		return nil, err
	}
	tempPath := temp.Name()
	defer os.Remove(tempPath)
	if err := temp.Chmod(0o600); err != nil {
		_ = temp.Close()
		return nil, err
	}
	if _, err := fmt.Fprintf(temp, "%d\n", os.Getpid()); err != nil {
		_ = temp.Close()
		return nil, err
	}
	if err := temp.Sync(); err != nil {
		_ = temp.Close()
		return nil, err
	}
	if err := temp.Close(); err != nil {
		return nil, err
	}
	if err := os.Link(tempPath, path); err != nil {
		return nil, err
	}
	return os.Open(path)
}

func releaseEnsureLock(file *os.File, path string) {
	if file == nil {
		return
	}
	_ = removeEnsureLockIfSame(file, path)
}

func openStaleEnsureLock(path string) (*os.File, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	data, err := io.ReadAll(file)
	if err != nil {
		_ = file.Close()
		return nil, err
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil || pid <= 0 {
		return file, nil
	}
	process, err := os.FindProcess(pid)
	if err != nil {
		return file, nil
	}
	if err := process.Signal(syscall.Signal(0)); errors.Is(err, os.ErrProcessDone) || errors.Is(err, syscall.ESRCH) {
		return file, nil
	}
	_ = file.Close()
	return nil, nil
}

func removeEnsureLockIfSame(file *os.File, path string) error {
	owned, statErr := file.Stat()
	current, currentErr := os.Stat(path)
	_ = file.Close()
	if statErr != nil {
		return statErr
	}
	if errors.Is(currentErr, os.ErrNotExist) {
		return nil
	}
	if currentErr != nil {
		return currentErr
	}
	if !os.SameFile(owned, current) {
		return nil
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

func ensureExtensionEventsCapability(env []string) []string {
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
	if cfg.ChildCommand == "" {
		cfg.ChildCommand = binary
	} else {
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
			"--child-command", "{child-command}",
			"--child-args", "{child-args}",
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

func stopOwnedProcess(ctx context.Context, process *os.Process, waitCh <-chan error) error {
	if process == nil {
		return nil
	}
	if err := process.Signal(syscall.SIGTERM); err != nil && !errors.Is(err, os.ErrProcessDone) {
		return fmt.Errorf("omorpc: terminate daemon supervisor: %w", err)
	}
	timer := time.NewTimer(3 * time.Second)
	defer timer.Stop()
	select {
	case <-waitCh:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
	}
	if err := process.Signal(syscall.SIGKILL); err != nil && !errors.Is(err, os.ErrProcessDone) {
		return fmt.Errorf("omorpc: kill daemon supervisor: %w", err)
	}
	select {
	case <-waitCh:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(time.Second):
		return errors.New("omorpc: daemon supervisor did not exit after SIGKILL")
	}
}
