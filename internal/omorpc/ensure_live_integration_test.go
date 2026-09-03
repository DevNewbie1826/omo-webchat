package omorpc

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestNodeFallbackMatchesLauncherExtensionCommands(t *testing.T) {
	binary, err := exec.LookPath("omo")
	if err != nil {
		t.Skip("omo launcher is not installed")
	}
	if _, recognized, err := launcherExtension(binary, os.Environ()); err != nil || !recognized {
		t.Skipf("omo launcher context is unavailable: recognized=%v err=%v", recognized, err)
	}

	agentDir := os.Getenv("OMO_CODING_AGENT_DIR")
	if agentDir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			t.Fatal(err)
		}
		agentDir = filepath.Join(home, ".omo", "agent")
	}
	workDir := t.TempDir()
	env := setEnv(os.Environ(), "OMO_RUNTIME", "node")
	env = setEnv(env, "OMO_CODING_AGENT_DIR", agentDir)
	env = setEnv(env, "SENPI_CODING_AGENT_DIR", agentDir)
	env = setEnv(env, "OMO_RPC_CLIENT_CAPABILITIES", "custom_only")
	env = EnsureExtensionEventsCapability(env)

	automaticSocket := filepath.Join(shortEnsureTempDir(t), "automatic.sock")
	automatic, automaticSupervisorPID := startLauncherHost(t, binary, automaticSocket, workDir, env)
	automaticCommands := extensionCommandNames(t, automatic, workDir)
	automaticBrand := nativeDescendantBrand(t, automaticSupervisorPID)
	if err := automatic.Close(); err != nil {
		t.Errorf("close launcher client: %v", err)
	}

	fallbackSocket := filepath.Join(shortEnsureTempDir(t), "fallback.sock")
	fallback, err := EnsureDaemon(context.Background(), EnsureConfig{
		AgentDir:     agentDir,
		SocketPath:   fallbackSocket,
		BinaryPath:   binary,
		WorkingDir:   workDir,
		StateDir:     filepath.Dir(fallbackSocket),
		Env:          env,
		ReadyTimeout: 15 * time.Second,
	})
	if err != nil {
		t.Fatalf("start node fallback host: %v", err)
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := fallback.Stop(ctx); err != nil {
			t.Errorf("stop node fallback host: %v", err)
		}
	}()
	fallbackCommands := extensionCommandNames(t, fallback.Client, workDir)
	fallbackBrand := nativeDescendantBrand(t, fallback.process.Pid)

	if len(automaticCommands) == 0 {
		t.Fatal("launcher session exposed no packaged extension commands")
	}
	if !slices.Equal(fallbackCommands, automaticCommands) {
		t.Fatalf("node fallback extension commands = %v, launcher = %v", fallbackCommands, automaticCommands)
	}
	if fallbackBrand != automaticBrand || fallbackBrand != "OmO" {
		t.Fatalf("node fallback native child brand = %q, launcher native child = %q, want OmO", fallbackBrand, automaticBrand)
	}
}

func TestRealSupervisorFailureRemovesAcknowledgedSocket(t *testing.T) {
	binary, err := exec.LookPath("omo")
	if err != nil {
		t.Skip("omo launcher is not installed")
	}
	if _, recognized, err := launcherExtension(binary, os.Environ()); err != nil || !recognized {
		t.Skipf("omo launcher context is unavailable: recognized=%v err=%v", recognized, err)
	}

	dir := shortEnsureTempDir(t)
	socket := filepath.Join(dir, "failed.sock")
	child := writeFakeSupervisor(t, `
listen=
previous=
for argument in "$@"; do
  if [ "$previous" = "--listen" ]; then listen=${argument#unix://}; break; fi
  previous=$argument
done
export OMORPC_ENSURE_HELPER_SOCKET="$listen"
exec "$OMORPC_ENSURE_TEST_BINARY" -test.run='^TestEnsureHelperProcess$'
`)
	cfg, err := normalizeEnsureConfig(EnsureConfig{
		AgentDir: dir, SocketPath: socket, BinaryPath: binary, StateDir: dir,
		ReadyTimeout: 15 * time.Second, ProbeTimeout: time.Second,
		Env: append(os.Environ(),
			ensureHelperModeEnv+"=supervised-drop",
			"OMORPC_ENSURE_TEST_BINARY="+os.Args[0],
		),
	})
	if err != nil {
		t.Fatal(err)
	}
	wrapper, err := writeNativeChildWrapper(cfg, child, `{"name":"OmO"}`, EnsureExtensionEventsCapability(cfg.Env))
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(wrapper)
	wrapped := cfg
	wrapped.ChildCommand = wrapper
	wrapped.ChildArgs = nil
	command, args, err := supervisorCommand(wrapped)
	if err != nil {
		t.Fatal(err)
	}
	if daemon, err, _ := spawnDaemonAttempt(context.Background(), cfg, command, args, cfg.Env, "real-producer-failure", false); err == nil || daemon != nil {
		t.Fatalf("real supervisor failure = daemon:%v err:%v", daemon, err)
	}
	if _, exists := currentSocketIdentity(socket); exists {
		t.Fatal("failed real supervisor left its acknowledged socket behind")
	}
}

func startLauncherHost(t *testing.T, binary, socket, workDir string, env []string) (*Client, int) {
	t.Helper()
	cmd := exec.Command(binary, "--mode", "rpc", "--multi-session", "--listen", "unix://"+socket)
	cmd.Dir = workDir
	cmd.Env = env
	stderr, err := cmd.StderrPipe()
	if err != nil {
		t.Fatalf("launcher stderr pipe: %v", err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatalf("start launcher host: %v", err)
	}
	waitCh := make(chan error, 1)
	go func() { waitCh <- cmd.Wait() }()
	t.Cleanup(func() {
		_ = cmd.Process.Signal(syscall.SIGTERM)
		select {
		case <-waitCh:
		case <-time.After(5 * time.Second):
			_ = cmd.Process.Kill()
			<-waitCh
		}
	})

	ready := make(chan error, 1)
	go func() {
		scanner := bufio.NewScanner(stderr)
		for scanner.Scan() {
			if strings.Contains(scanner.Text(), "rpc listening on") {
				ready <- nil
				return
			}
		}
		if err := scanner.Err(); err != nil {
			ready <- err
			return
		}
		ready <- io.EOF
	}()
	select {
	case err := <-ready:
		if err != nil {
			t.Fatalf("launcher host readiness: %v", err)
		}
	case err := <-waitCh:
		t.Fatalf("launcher host exited before readiness: %v", err)
	case <-time.After(15 * time.Second):
		t.Fatal("launcher host readiness timed out")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	client, err := Dial(ctx, socket)
	if err != nil {
		t.Fatalf("dial launcher host: %v", err)
	}
	return client, cmd.Process.Pid
}

func nativeDescendantBrand(t *testing.T, supervisorPID int) string {
	t.Helper()
	output, err := exec.Command("ps", "-axo", "pid=,ppid=,comm=").Output()
	if err != nil {
		t.Fatalf("list supervisor descendants: %v", err)
	}
	type process struct {
		pid, ppid int
		brand     string
	}
	var processes []process
	for _, line := range strings.Split(string(output), "\n") {
		var current process
		if _, err := fmt.Sscan(line, &current.pid, &current.ppid, &current.brand); err == nil {
			processes = append(processes, current)
		}
	}
	descendants := map[int]int{supervisorPID: 0}
	brand, brandDepth := "", -1
	for changed := true; changed; {
		changed = false
		for _, current := range processes {
			parentDepth, ok := descendants[current.ppid]
			if !ok {
				continue
			}
			depth := parentDepth + 1
			if previous, exists := descendants[current.pid]; exists && previous >= depth {
				continue
			}
			descendants[current.pid] = depth
			changed = true
			if (strings.EqualFold(current.brand, "omo") || strings.EqualFold(current.brand, "senpi")) && depth > brandDepth {
				brand, brandDepth = current.brand, depth
			}
		}
	}
	if brand == "" {
		t.Fatalf("supervisor %d has no branded native descendant: %s", supervisorPID, output)
	}
	return brand
}

func extensionCommandNames(t *testing.T, client *Client, cwd string) []string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	open, err := client.Call(ctx, OpenSession{CWD: cwd})
	if err != nil || open == nil || !open.Success {
		t.Fatalf("open real session: response=%+v err=%v", open, err)
	}
	var opened OpenSessionData
	if err := json.Unmarshal(open.Data, &opened); err != nil {
		t.Fatalf("decode real session: %v", err)
	}
	commands, err := client.Call(ctx, GetCommands{SessionID: opened.SessionID})
	if err != nil || commands == nil || !commands.Success {
		t.Fatalf("get real session commands: response=%+v err=%v", commands, err)
	}
	var data struct {
		Commands []struct {
			Name       string `json:"name"`
			Source     string `json:"source"`
			SourceInfo struct {
				Source string `json:"source"`
			} `json:"sourceInfo"`
		} `json:"commands"`
	}
	if err := json.Unmarshal(commands.Data, &data); err != nil {
		t.Fatalf("decode real session commands: %v", err)
	}
	var names []string
	for _, command := range data.Commands {
		if command.Source == "extension" && command.SourceInfo.Source == "cli" {
			names = append(names, command.Name)
		}
	}
	slices.Sort(names)
	return names
}
