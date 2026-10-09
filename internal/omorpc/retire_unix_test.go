//go:build darwin || linux

package omorpc

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"syscall"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/procexec"
)

func shortSocketPath(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "retire-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	return filepath.Join(dir, "rpc.sock")
}

func TestRetireUnownedEngineIgnoresMissingEndpoint(t *testing.T) {
	if err := RetireUnownedEngine(t.Context(), EnsureConfig{SocketPath: shortSocketPath(t)}); err != nil {
		t.Fatalf("missing endpoint = %v, want nil", err)
	}
}

func TestRetireUnownedEngineRemovesStaleSocket(t *testing.T) {
	path := shortSocketPath(t)
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: path, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	listener.SetUnlinkOnClose(false)
	_ = listener.Close()

	if err := RetireUnownedEngine(t.Context(), EnsureConfig{SocketPath: path}); err != nil {
		t.Fatalf("stale socket = %v, want nil", err)
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("stale socket still present: %v", err)
	}
}

func TestRetireUnownedEngineRefusesNonEnginePeer(t *testing.T) {
	path := shortSocketPath(t)
	listener, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			_ = conn.Close()
		}
	}()

	if err := RetireUnownedEngine(t.Context(), EnsureConfig{SocketPath: path}); !errors.Is(err, ErrDaemonNotOwned) {
		t.Fatalf("non-engine peer = %v, want ErrDaemonNotOwned", err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("refused peer socket must stay: %v", err)
	}
}

type retireHelper struct {
	cfg  EnsureConfig
	pid  int
	pids []int
	done <-chan struct{}
}

func startRetireHelper(t *testing.T, mode string, leader bool, depth int) retireHelper {
	t.Helper()
	path := shortSocketPath(t)
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	defer writer.Close()
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(binary, "-test.run=^TestRetireEngineHelper$")
	cmd.Args[0] = "plain-worker"
	cmd.Env = append(os.Environ(),
		"OMO_RETIRE_HELPER_SOCKET="+path,
		"OMO_RETIRE_HELPER_DIR="+filepath.Dir(path),
		"OMO_RETIRE_HELPER_MODE="+mode,
		"OMO_RETIRE_HELPER_DEPTH="+strconv.Itoa(depth),
	)
	cmd.ExtraFiles = []*os.File{writer}
	cmd.Stderr = os.Stderr
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	if leader {
		procexec.SetupCommand(cmd)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	_ = writer.Close()
	done := make(chan struct{})
	go func() { _ = cmd.Wait(); close(done) }()
	t.Cleanup(func() {
		if leader {
			_ = procexec.SignalGroup(cmd.Process.Pid, syscall.SIGKILL)
		} else {
			_ = cmd.Process.Kill()
		}
		_ = stdin.Close()
		select {
		case <-done:
		case <-time.After(3 * time.Second):
			t.Error("retire helper cleanup did not reap leader")
		}
		if leader && !waitEngineGroupGone(context.Background(), cmd.Process.Pid, 3*time.Second) {
			t.Error("retire helper cleanup left a process group")
		}
	})
	if err := reader.SetReadDeadline(time.Now().Add(5 * time.Second)); err != nil {
		t.Fatal(err)
	}
	var pids []int
	if err := json.NewDecoder(reader).Decode(&pids); err != nil {
		t.Fatalf("helper readiness: %v", err)
	}
	cfg, err := normalizeEnsureConfig(EnsureConfig{AgentDir: filepath.Dir(path), SocketPath: path, ProbeTimeout: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("ready peer=%d descendants=%v mode=%s groupLeader=%v argv=plain-worker (no supervisor/socket flags)", cmd.Process.Pid, pids, mode, leader)
	return retireHelper{cfg: cfg, pid: cmd.Process.Pid, pids: pids, done: done}
}

func assertRetireHelperAlive(t *testing.T, h retireHelper) {
	t.Helper()
	select {
	case <-h.done:
		t.Fatal("refused or identity-replaced peer was killed")
	default:
	}
	if err := syscall.Kill(h.pid, 0); err != nil {
		t.Fatalf("peer must remain alive: %v", err)
	}
}

func TestRetireUnownedEngineRetiresWholeGroup(t *testing.T) {
	h := startRetireHelper(t, "group", true, 2)
	if len(h.pids) != 3 {
		t.Fatalf("group precondition: want leader, child and grandchild, got %v", h.pids)
	}
	for _, pid := range h.pids {
		pgid, err := syscall.Getpgid(pid)
		if err != nil || pgid != h.pid {
			t.Fatalf("descendant %d group = %d, %v; want %d", pid, pgid, err, h.pid)
		}
	}
	err := retireUnownedEngine(t.Context(), h.cfg, 100*time.Millisecond, time.Second, inspectEngineProcess)
	if err != nil || procexec.GroupAlive(h.pid) {
		t.Fatalf("whole group must be confirmed gone: error=%v alive=%v", err, procexec.GroupAlive(h.pid))
	}
	if _, err := os.Stat(h.cfg.SocketPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("retired group socket must be removed: %v", err)
	}
}

func TestRetireUnownedEngineRefusesChildWithoutHandshake(t *testing.T) {
	h := startRetireHelper(t, "no-handshake", true, 0)
	err := retireUnownedEngine(t.Context(), h.cfg, 100*time.Millisecond, time.Second, inspectEngineProcess)
	if !errors.Is(err, ErrDaemonNotOwned) {
		t.Fatalf("listener without handshake = %v, want ErrDaemonNotOwned", err)
	}
	assertRetireHelperAlive(t, h)
}

func TestRetireUnownedEngineRefusesNonLeaderChild(t *testing.T) {
	h := startRetireHelper(t, "engine", false, 0)
	pgid, err := syscall.Getpgid(h.pid)
	if err != nil || pgid == h.pid {
		t.Fatalf("nonleader precondition pgid=%d: %v", pgid, err)
	}
	err = retireUnownedEngine(t.Context(), h.cfg, 100*time.Millisecond, time.Second, inspectEngineProcess)
	if !errors.Is(err, ErrDaemonNotOwned) {
		t.Fatalf("handshaken nonleader = %v, want ErrDaemonNotOwned", err)
	}
	assertRetireHelperAlive(t, h)
}

func TestRetireUnownedEngineIgnoresArgv(t *testing.T) {
	h := startRetireHelper(t, "engine", true, 0)
	if err := RetireUnownedEngine(t.Context(), h.cfg); err != nil {
		t.Fatalf("engine without supervisor argv must retire: %v", err)
	}
	if procexec.GroupAlive(h.pid) {
		t.Fatal("argv-independent engine group remains alive")
	}
}

func TestRetireUnownedEngineEscalatesIgnoringLeader(t *testing.T) {
	h := startRetireHelper(t, "ignore", true, 0)
	if err := retireUnownedEngine(t.Context(), h.cfg, 100*time.Millisecond, time.Second, inspectEngineProcess); err != nil {
		t.Fatalf("SIGTERM-ignoring engine must be killed: %v", err)
	}
	if procexec.GroupAlive(h.pid) {
		t.Fatal("SIGTERM-ignoring engine group remains alive")
	}
}

func TestRetireUnownedEngineRechecksStartTime(t *testing.T) {
	h := startRetireHelper(t, "ignore", true, 0)
	reads := 0
	inspect := func(pid int) (engineProcessInfo, error) {
		info, err := inspectEngineProcess(pid)
		reads++
		if reads > 1 {
			info.startTime++
		}
		return info, err
	}
	err := retireUnownedEngine(t.Context(), h.cfg, 100*time.Millisecond, time.Second, inspect)
	if !RetirementConfirmed(err) {
		t.Fatalf("reused leader means original group confirmed gone: %v", err)
	}
	if !procexec.GroupAlive(h.pid) {
		t.Fatal("identity-replaced leader received SIGKILL")
	}
	assertRetireHelperAlive(t, h)
	if reads != 2 {
		t.Fatalf("identity reads = %d, want before SIGTERM and before SIGKILL", reads)
	}
	client, err := Dial(t.Context(), h.cfg.SocketPath)
	if err != nil {
		t.Fatalf("identity-replaced peer must still serve handshake: %v", err)
	}
	_ = client.Close()
	t.Log("changed start time confirmed retirement without delivering SIGKILL")
}
