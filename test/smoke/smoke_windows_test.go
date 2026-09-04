//go:build windows

// Package smoke_test boots the real cmd/server binary against the exported
// mock omo RPC daemon on a Windows runner. api.Run requires a live omo RPC
// daemon before it opens its HTTP listener, and no real omo daemon can host
// its RPC socket on Windows yet, so the smoke provides its own: the daemon
// runs in this test process, listening on AF_UNIX at the exact pathname the
// server's ensure step resolves. A pass is therefore also live evidence that
// Go can LISTEN on an AF_UNIX socket on Windows.
package smoke_test

import (
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc/omorpctest"
	"github.com/DevNewbie1826/omo-webchat/internal/procexec"
)

const (
	readyWait  = 60 * time.Second
	exitWait   = 10 * time.Second
	stopWait   = 15 * time.Second
	pollStep   = 50 * time.Millisecond
	smokePwd   = "devsmoke123"
	reportTail = 16 << 10
)

// TestServerSmokeAgainstMockDaemon builds cmd/server, starts it against the
// mock daemon, waits for HTTP 200 on the login page, kills the process tree,
// and asserts the tree is gone and the port refuses connections afterwards.
func TestServerSmokeAgainstMockDaemon(t *testing.T) {
	repo := repositoryRoot(t)

	// Short prefix and shallow nesting keep the AF_UNIX socket path under the
	// sockaddr sun_path limit (108 bytes on Windows): live probing for
	// test/windowsprobe showed the default os.TempDir() prefix plus the test
	// name leaves too little headroom.
	base, err := os.MkdirTemp("", "wsmoke")
	if err != nil {
		t.Fatal(err)
	}
	// Win32 handle close after TerminateProcess is not synchronous, so the
	// final remove retries until the budget expires instead of failing on a
	// transient sharing violation.
	t.Cleanup(func() { _ = removeAllDeadline(base, exitWait) })

	home := filepath.Join(base, "home")
	agentDir := filepath.Join(home, ".omo", "agent")
	rpcDir := filepath.Join(agentDir, "rpc")
	root := filepath.Join(home, "root")
	stateDir := filepath.Join(base, "state")
	for _, dir := range []string{rpcDir, root, stateDir} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}

	// EnsureDaemon probes the socket first and only launches a supervisor when
	// the probe misses a spawnable endpoint, so the mock must occupy the exact
	// pathname api.Run resolves: normalizeEnsureConfig maps OMO_CODING_AGENT_DIR
	// to <agentDir>/rpc/rpc.sock.
	daemon := omorpctest.NewAt(rpcDir, filepath.Join(rpcDir, "rpc.sock"))
	if err := daemon.Start(); err != nil {
		t.Fatalf("mock omo daemon cannot listen on AF_UNIX %s: %v — Go cannot listen on AF_UNIX on this runner; this failure is the evidence", daemon.SocketPath(), err)
	}
	t.Cleanup(daemon.Stop)

	binary := filepath.Join(base, "omo-webchat.exe")
	build := exec.Command("go", "build", "-o", binary, "./cmd/server")
	build.Dir = repo
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build server: %v\n%s", err, output)
	}

	port := freeLoopbackPort(t)
	address := net.JoinHostPort("127.0.0.1", strconv.Itoa(port))
	cmd := exec.Command(binary,
		"--host", "127.0.0.1",
		"--port", strconv.Itoa(port),
		"--password", smokePwd,
		"--root", root,
		"--state-dir", stateDir,
	)
	cmd.Env = isolatedEnv(home, agentDir)
	logs := &reportBuffer{}
	cmd.Stdout = logs
	cmd.Stderr = logs

	// StartTracked places the server in a KILL_ON_JOB_CLOSE Job Object, so the
	// whole tree is a kernel-owned domain: TerminateTree reaches every
	// descendant, and closing the job handle reaps survivors even if this test
	// process dies first (internal/procexec doc.go).
	tracked, err := procexec.StartTracked(cmd)
	if err != nil {
		t.Fatalf("start server: %v", err)
	}
	t.Cleanup(func() {
		_ = tracked.TerminateTree()
		_ = tracked.Close()
	})
	waitCh := make(chan error, 1)
	go func() { waitCh <- cmd.Wait() }()

	client := &http.Client{Timeout: time.Second}
	var status int
	deadline := time.Now().Add(readyWait)
	for {
		select {
		case err := <-waitCh:
			t.Fatalf("server exited before HTTP 200: %v\n%s", err, logs)
		default:
		}
		resp, err := client.Get("http://" + address + "/")
		if err == nil {
			_, _ = io.Copy(io.Discard, resp.Body)
			status = resp.StatusCode
			_ = resp.Body.Close()
			if status == http.StatusOK {
				break
			}
		} else {
			status = 0
		}
		if !time.Now().Before(deadline) {
			t.Fatalf("server did not return HTTP 200 within deadline (last status=%d)\n%s", status, logs)
		}
		time.Sleep(pollStep)
	}

	if err := tracked.TerminateTree(); err != nil {
		t.Fatalf("terminate server tree: %v", err)
	}
	// The production teardown path (omorpc terminateSupervisor) drains the job
	// domain with WaitTreeGone after TerminateJobObject because that Win32
	// call only initiates termination. The server tree is leader-only, but
	// calling it here exercises the same TerminateTree -> WaitTreeGone order
	// end-to-end against a real job object.
	if err := tracked.WaitTreeGone(exitWait); err != nil {
		t.Fatalf("server tree did not drain after terminate: %v", err)
	}
	select {
	case <-waitCh:
	case <-time.After(exitWait):
		t.Fatal("server leader did not exit after tree terminate")
	}

	// The kernel view of "gone": GroupAlive opens the recorded pid and polls
	// the process object's signaled state with a zero-timeout wait, which is
	// authoritative where exit codes are not (STILL_ACTIVE pseudo code); a pid
	// with no process behind it fails the open. Poll until the pid is gone.
	deadline = time.Now().Add(exitWait)
	for procexec.GroupAlive(tracked.Pid()) {
		if !time.Now().Before(deadline) {
			t.Fatalf("server process %d still alive after tree terminate", tracked.Pid())
		}
		time.Sleep(pollStep)
	}
	if err := cmd.Process.Kill(); !errors.Is(err, os.ErrProcessDone) {
		t.Fatalf("second kill of server process = %v, want os.ErrProcessDone", err)
	}

	// Shutdown hygiene: the port must refuse new connections afterwards.
	deadline = time.Now().Add(stopWait)
	for {
		conn, err := net.DialTimeout("tcp", address, 250*time.Millisecond)
		if err != nil {
			break
		}
		_ = conn.Close()
		if !time.Now().Before(deadline) {
			t.Fatalf("port %d still accepting connections after stop", port)
		}
		time.Sleep(pollStep)
	}
}

func repositoryRoot(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve test source path")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(file), "..", ".."))
}

func freeLoopbackPort(t *testing.T) int {
	t.Helper()
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	return port
}

// isolatedEnv points every home the server can consult at the temp tree:
// HOME is POSIX getpwuid/getenv, USERPROFILE is Win32
// GetUserProfileDirectoryW, APPDATA/LOCALAPPDATA back os.UserConfigDir and
// friends. OMO_/SENPI_ CODING_AGENT_DIR are the agent-dir overrides
// normalizeEnsureConfig and session.CodingAgentDir resolve; the capability
// variables match EnsureExtensionEventsCapability.
func isolatedEnv(home, agent string) []string {
	env := os.Environ()
	env = setEnv(env, "HOME", home)
	env = setEnv(env, "USERPROFILE", home)
	env = setEnv(env, "APPDATA", filepath.Join(home, "AppData", "Roaming"))
	env = setEnv(env, "LOCALAPPDATA", filepath.Join(home, "AppData", "Local"))
	env = setEnv(env, "OMO_CODING_AGENT_DIR", agent)
	env = setEnv(env, "SENPI_CODING_AGENT_DIR", agent)
	env = setEnv(env, "SENPI_RPC_CLIENT_CAPABILITIES", "extension_events")
	env = setEnv(env, "OMO_RPC_CLIENT_CAPABILITIES", "extension_events")
	return env
}

// setEnv replaces case-insensitively: Windows environment variable names are
// matched without case by CreateProcess.
func setEnv(env []string, key, value string) []string {
	out := make([]string, 0, len(env)+1)
	for _, kv := range env {
		if name, _, found := strings.Cut(kv, "="); found && strings.EqualFold(name, key) {
			continue
		}
		out = append(out, kv)
	}
	return append(out, key+"="+value)
}

func removeAllDeadline(path string, budget time.Duration) error {
	deadline := time.Now().Add(budget)
	var err error
	for {
		err = os.RemoveAll(path)
		if err == nil || !time.Now().Before(deadline) {
			return err
		}
		time.Sleep(pollStep)
	}
}

// reportBuffer captures server output for failure reports, capped so a
// pathological failure cannot balloon the test log.
type reportBuffer struct {
	mu   sync.Mutex
	buf  []byte
	caps bool
}

func (b *reportBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if len(b.buf) < reportTail {
		b.buf = append(b.buf, p...)
		if len(b.buf) > reportTail {
			b.buf = b.buf[:reportTail]
			b.caps = true
		}
	}
	return len(p), nil
}

func (b *reportBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.caps {
		return string(b.buf) + "\n... (output truncated)"
	}
	return string(b.buf)
}
