//go:build windows

// Package smoke_test boots the built server against the authenticated platform
// RPC fixture. The required real-omo counterpart lives in test/windowsprobe.
package smoke_test

import (
	"bytes"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc/omorpctest"
	"github.com/DevNewbie1826/omo-webchat/internal/procexec"
	"golang.org/x/sys/windows"
)

func TestServerSmokeAgainstMockDaemon(t *testing.T) {
	base, err := os.MkdirTemp("", "wsmoke")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.RemoveAll(base); err != nil {
			t.Errorf("remove smoke profile: %v", err)
		}
	})
	home := filepath.Join(base, "home")
	agent := filepath.Join(home, ".omo", "agent")
	rpc := filepath.Join(agent, "rpc")
	if err := os.MkdirAll(rpc, 0700); err != nil {
		t.Fatal(err)
	}
	daemon := omorpctest.NewAt(rpc, filepath.Join(rpc, "rpc.sock"))
	if err := daemon.Start(); err != nil {
		t.Fatalf("listen on platform RPC endpoint: %v", err)
	}
	t.Cleanup(daemon.Stop)
	binary := filepath.Join(base, "omo-webchat.exe")
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve repository root")
	}
	build := exec.Command("go", "build", "-o", binary, "./cmd/server")
	build.Dir = filepath.Clean(filepath.Join(filepath.Dir(file), "..", ".."))
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build server: %v: %s", err, out)
	}
	cmd := exec.Command(binary, "--host", "127.0.0.1", "--port", "0", "--password", "isolated-smoke", "--root", home, "--state-dir", filepath.Join(base, "state"))
	cmd.Env = isolatedEnv(home, agent)
	logs := &reportBuffer{ready: make(chan string, 1)}
	cmd.Stdout = logs
	cmd.Stderr = logs
	tracked, err := procexec.StartTracked(cmd)
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait(); close(done) }()
	var once sync.Once
	var stopErr error
	stop := func() error {
		once.Do(func() {
			stopErr = errors.Join(tracked.TerminateTree(), tracked.WaitTreeGone(10*time.Second), tracked.Close())
			select {
			case err := <-done:
				var exitErr *exec.ExitError
				if err != nil && !errors.As(err, &exitErr) {
					stopErr = errors.Join(stopErr, err)
				}
			case <-time.After(10 * time.Second):
				stopErr = errors.Join(stopErr, errors.New("server leader did not exit after job drain"))
			}
		})
		return stopErr
	}
	t.Cleanup(func() {
		if err := stop(); err != nil {
			t.Error(err)
		}
	})
	var address string
	select {
	case address = <-logs.ready:
	case err := <-done:
		t.Fatalf("server exited before bound-listener event: %v: %s", err, logs)
	case <-time.After(60 * time.Second):
		t.Fatalf("server did not bind: %s", logs)
	}
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get("http://" + address + "/")
	if err != nil {
		t.Fatalf("GET after listener event: %v", err)
	}
	_, readErr := io.Copy(io.Discard, resp.Body)
	if err := errors.Join(readErr, resp.Body.Close()); err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("HTTP status=%d, want 200", resp.StatusCode)
	}
	if err := stop(); err != nil {
		t.Fatal(err)
	}
	conn, err := net.DialTimeout("tcp", address, time.Second)
	if conn != nil {
		conn.Close()
		t.Fatal("port still accepts after tree drain")
	}
	if !errors.Is(err, windows.WSAECONNREFUSED) {
		t.Fatalf("post-stop dial: %v, want connection refused", err)
	}
}

func isolatedEnv(home, agent string) []string {
	env := os.Environ()
	for key, value := range map[string]string{
		"HOME": home, "USERPROFILE": home, "APPDATA": filepath.Join(home, "AppData", "Roaming"),
		"LOCALAPPDATA": filepath.Join(home, "AppData", "Local"), "OMO_CODING_AGENT_DIR": agent, "SENPI_CODING_AGENT_DIR": agent,
		"SENPI_RPC_CLIENT_CAPABILITIES": "extension_events", "OMO_RPC_CLIENT_CAPABILITIES": "extension_events",
	} {
		env = setEnv(env, key, value)
	}
	return env
}

func setEnv(env []string, key, value string) []string {
	out := make([]string, 0, len(env)+1)
	for _, entry := range env {
		name, _, found := strings.Cut(entry, "=")
		if !found || !strings.EqualFold(name, key) {
			out = append(out, entry)
		}
	}
	return append(out, key+"="+value)
}

type reportBuffer struct {
	mu      sync.Mutex
	pending []byte
	tail    []byte
	ready   chan string
	once    sync.Once
}

func (b *reportBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.tail = append(b.tail, p...)
	if len(b.tail) > 16<<10 {
		b.tail = b.tail[len(b.tail)-(16<<10):]
	}
	b.pending = append(b.pending, p...)
	for {
		end := bytes.IndexByte(b.pending, '\n')
		if end < 0 {
			break
		}
		line := string(b.pending[:end])
		b.pending = b.pending[end+1:]
		if !strings.Contains(line, "msg=listening ") {
			continue
		}
		for _, field := range strings.Fields(line) {
			if address, ok := strings.CutPrefix(field, "addr="); ok {
				b.once.Do(func() { b.ready <- strings.Trim(address, `"`) })
			}
		}
	}
	if len(b.pending) > 16<<10 {
		b.pending = nil
	}
	return len(p), nil
}

func (b *reportBuffer) String() string { b.mu.Lock(); defer b.mu.Unlock(); return string(b.tail) }
