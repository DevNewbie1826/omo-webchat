package main

import (
	"context"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc/omorpctest"
)

// The foreground binary's structured listening record is the smoke's startup
// signal. A failed bind must never emit that machine-consumed signal.
func TestServerReadinessSignalRequiresBoundListener(t *testing.T) {
	dir, err := os.MkdirTemp("", "sr")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.RemoveAll(dir); err != nil {
			t.Error(err)
		}
	})
	agent := filepath.Join(dir, "agent")
	rpc := filepath.Join(agent, "rpc")
	if err := os.MkdirAll(rpc, 0700); err != nil {
		t.Fatal(err)
	}
	daemon := omorpctest.NewAt(rpc, filepath.Join(rpc, "rpc.sock"))
	if err := daemon.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(daemon.Stop)
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	port := listener.Addr().(*net.TCPAddr).Port
	binary := filepath.Join(dir, "server")
	if runtime.GOOS == "windows" {
		binary += ".exe"
	}
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	build := exec.CommandContext(ctx, "go", "build", "-o", binary, "./cmd/server")
	build.Dir = filepath.Join("..", "..")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build: %v: %s", err, out)
	}
	cmd := exec.CommandContext(ctx, binary, "--host", "127.0.0.1", "--port", strconv.Itoa(port), "--password", "readiness-test", "--root", dir, "--state-dir", filepath.Join(dir, "state"))
	cmd.Env = isolatedEnv(filepath.Join(dir, "home"), agent)
	output, err := cmd.CombinedOutput()
	if err == nil {
		t.Fatal("server accepted an occupied port")
	}
	if ctx.Err() != nil {
		t.Fatal(ctx.Err())
	}
	if strings.Contains(string(output), "msg=listening") {
		t.Fatal("server emitted readiness before binding its listener")
	}
}
