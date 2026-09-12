//go:build darwin || linux

package omorpc

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

// The fake package manager is a real isolated subprocess. It reports its actual
// argv/environment and blocks on a socket event when cancellation is exercised.
func TestUpdatePackageManagerProcess(t *testing.T) {
	if os.Getenv("WEBCHAT_UPDATE_TEST_HELPER") != "1" {
		return
	}
	conn, err := net.Dial("tcp", os.Getenv("WEBCHAT_UPDATE_TEST_ADDRESS"))
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(90)
	}
	defer conn.Close()
	cwd, err := os.Getwd()
	if err != nil {
		os.Exit(91)
	}
	role := os.Getenv("WEBCHAT_UPDATE_TEST_ROLE")
	if role == "" {
		role = "leader"
	}
	var args []string
	if len(os.Args) > 3 {
		args = os.Args[3:]
	}
	report := updateProcessReport{
		Role: role, Pid: os.Getpid(), Args: args, Cwd: cwd, Path: os.Getenv("PATH"),
		BunInstall: os.Getenv("BUN_INSTALL"), BunGlobal: os.Getenv("BUN_INSTALL_GLOBAL_DIR"), BunBin: os.Getenv("BUN_INSTALL_BIN"),
	}
	stdin, err := io.ReadAll(os.Stdin)
	if err != nil || len(stdin) != 0 {
		os.Exit(94)
	}
	for _, entry := range os.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		if strings.HasPrefix(key, "OMO_") || strings.HasPrefix(key, "SENPI_") || key == "NODE_OPTIONS" || key == "BUN_OPTIONS" {
			report.Markers = append(report.Markers, key)
		}
	}
	if err := json.NewEncoder(conn).Encode(report); err != nil {
		os.Exit(92)
	}
	var action string
	if err := json.NewDecoder(conn).Decode(&action); err != nil {
		os.Exit(93)
	}
	if role == "descendant" {
		os.Exit(0)
	}
	if action == "fail" {
		fmt.Fprint(os.Stderr, strings.Repeat("x", 32768)+"\nEUPDATE fixture failure\n")
		os.Exit(23)
	}
	if action == "spawn-descendant" {
		exe, err := os.Executable()
		if err != nil {
			os.Exit(95)
		}
		child := exec.Command(exe, "-test.run=^TestUpdatePackageManagerProcess$", "--")
		child.Env = setEnv(os.Environ(), "WEBCHAT_UPDATE_TEST_ROLE", "descendant")
		if err := child.Start(); err != nil {
			os.Exit(96)
		}
		if err := json.NewDecoder(conn).Decode(&action); err != nil {
			os.Exit(97)
		}
	}
	os.Exit(0)
}

type updateProcessReport struct {
	Role                                     string
	Pid                                      int
	Args, Markers                            []string
	Cwd, Path, BunInstall, BunGlobal, BunBin string
}

type updateProcessEvent struct {
	report updateProcessReport
	conn   net.Conn
	err    error
}

func updateProcessListener(t *testing.T) <-chan updateProcessEvent {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	t.Setenv("WEBCHAT_UPDATE_TEST_HELPER", "1")
	t.Setenv("WEBCHAT_UPDATE_TEST_ADDRESS", ln.Addr().String())
	events := make(chan updateProcessEvent, 2)
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				if !errors.Is(err, net.ErrClosed) {
					events <- updateProcessEvent{err: err}
				}
				return
			}
			_ = conn.SetDeadline(time.Now().Add(10 * time.Second))
			var report updateProcessReport
			err = json.NewDecoder(conn).Decode(&report)
			events <- updateProcessEvent{report: report, conn: conn, err: err}
		}
	}()
	return events
}

func awaitUpdateEvent(t *testing.T, events <-chan updateProcessEvent) updateProcessEvent {
	t.Helper()
	select {
	case event := <-events:
		if event.err != nil {
			t.Fatal(event.err)
		}
		t.Cleanup(func() { event.conn.Close() })
		return event
	case <-time.After(10 * time.Second):
		t.Fatal("package manager did not report startup")
		return updateProcessEvent{}
	}
}

func awaitUpdateResult(t *testing.T, result <-chan error) error {
	t.Helper()
	select {
	case err := <-result:
		return err
	case <-time.After(10 * time.Second):
		t.Fatal("update did not finish")
		return nil
	}
}

type updateProcessTermination struct {
	n   int
	err error
}

func subscribeUpdateTermination(conn net.Conn) <-chan updateProcessTermination {
	terminated := make(chan updateProcessTermination, 1)
	go func() {
		var data [1]byte
		n, err := conn.Read(data[:])
		terminated <- updateProcessTermination{n: n, err: err}
	}()
	return terminated
}

func awaitUpdateTermination(t *testing.T, role string, terminated <-chan updateProcessTermination) {
	t.Helper()
	result := <-terminated
	var netErr net.Error
	if errors.As(result.err, &netErr) && netErr.Timeout() {
		t.Fatalf("%s remained alive until the socket deadline: %v", role, result.err)
	}
	if result.n != 0 || !errors.Is(result.err, io.EOF) {
		t.Fatalf("%s did not close its connection on termination: n=%d err=%v", role, result.n, result.err)
	}
}

func writeUpdateFile(t *testing.T, path, data string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(data), 0700); err != nil {
		t.Fatal(err)
	}
}

func updateInstallFixture(t *testing.T, manager string) (launcher, root, prefix string) {
	t.Helper()
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	prefix = filepath.Join(base, "installation with spaces")
	if manager == "bun" {
		root = filepath.Join(prefix, "install", "global", "node_modules", "omo-ai")
	} else {
		root = filepath.Join(prefix, "lib", "node_modules", "omo-ai")
	}
	entry := filepath.Join(root, "bin", "omo.js")
	writeUpdateFile(t, entry, "#!/bin/sh\nexit 99\n")
	writeUpdateFile(t, filepath.Join(root, "package.json"), `{"name":"omo-ai","version":"1.0.0"}`)
	launcher = filepath.Join(prefix, "bin", "omo")
	if err := os.MkdirAll(filepath.Dir(launcher), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(entry, launcher); err != nil {
		t.Fatal(err)
	}
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	script := "#!/bin/sh\nexec " + shellQuote(exe) + " -test.run=^TestUpdatePackageManagerProcess$ -- \"$@\"\n"
	if manager == "bun" {
		writeUpdateFile(t, filepath.Join(prefix, "bin", "bun"), script)
	} else {
		writeUpdateFile(t, filepath.Join(prefix, "bin", "node"), script)
		writeUpdateFile(t, filepath.Join(prefix, "lib", "node_modules", "npm", "bin", "npm-cli.js"), "// fixture\n")
	}
	// Any accidental PATH package-manager invocation fails, rather than modifying
	// the developer's real installation.
	poison := t.TempDir()
	for _, name := range []string{"omo", "npm", "node", "bun", "senpi"} {
		writeUpdateFile(t, filepath.Join(poison, name), "#!/bin/sh\nexit 98\n")
	}
	t.Setenv("PATH", poison)
	t.Setenv("OMO_BIN", filepath.Join(poison, "omo"))
	t.Setenv("OMO_AGENT_TOOLKIT_BIN", filepath.Join(poison, "omo-agent-toolkit.js"))
	t.Setenv("BUN_INSTALL", poison)
	t.Setenv("BUN_INSTALL_GLOBAL_DIR", poison)
	t.Setenv("BUN_INSTALL_BIN", poison)
	t.Setenv("BUN_INSTALL_GLOBAL_BIN_DIR", poison)
	t.Setenv("OMO_SENPI_PATCH_ROOT", poison)
	t.Setenv("SENPI_BRAND", "unrelated-engine")
	t.Setenv("NODE_OPTIONS", "--require=unrelated-preload")
	t.Setenv("BUN_OPTIONS", "--require=unrelated-preload")
	return
}

func TestUpdateInstallationPackageManagerArgv(t *testing.T) {
	for _, manager := range []string{"npm", "bun"} {
		t.Run(manager, func(t *testing.T) {
			launcher, root, prefix := updateInstallFixture(t, manager)
			events := updateProcessListener(t)
			ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
			defer cancel()
			done := make(chan error, 1)
			go func() { done <- UpdateInstallation(ctx, launcher) }()
			event := awaitUpdateEvent(t, events)
			if len(event.report.Markers) != 0 {
				t.Errorf("installer inherited launch markers/preloads: %v", event.report.Markers)
			}
			var want []string
			if manager == "npm" {
				want = []string{filepath.Join(prefix, "lib", "node_modules", "npm", "bin", "npm-cli.js"), "i", "-g", "--prefix", prefix, "omo-ai@beta"}
			} else {
				want = []string{"add", "--cwd", root, "-g", "omo-ai@beta"}
				if event.report.BunInstall != prefix || event.report.BunGlobal != filepath.Join(prefix, "install", "global") || event.report.BunBin != filepath.Join(prefix, "bin") {
					t.Errorf("wrong Bun target: %+v", event.report)
				}
			}
			if !reflect.DeepEqual(event.report.Args, want) {
				t.Errorf("argv = %q, want %q", event.report.Args, want)
			}
			if !strings.HasPrefix(event.report.Path, filepath.Join(prefix, "bin")+string(os.PathListSeparator)) {
				t.Errorf("runtime PATH = %q", event.report.Path)
			}
			if err := json.NewEncoder(event.conn).Encode("ok"); err != nil {
				t.Fatal(err)
			}
			if err := awaitUpdateResult(t, done); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestUpdateInstallationFailureOutput(t *testing.T) {
	launcher, _, _ := updateInstallFixture(t, "npm")
	events := updateProcessListener(t)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- UpdateInstallation(ctx, launcher) }()
	event := awaitUpdateEvent(t, events)
	if err := json.NewEncoder(event.conn).Encode("fail"); err != nil {
		t.Fatal(err)
	}
	err := awaitUpdateResult(t, done)
	if err == nil || !strings.Contains(err.Error(), "EUPDATE fixture failure") || !strings.Contains(err.Error(), "exit status 23") {
		t.Fatalf("failure = %v", err)
	}
	if len(err.Error()) > 10000 {
		t.Fatalf("unbounded failure: %d bytes", len(err.Error()))
	}
}

func TestUpdateInstallationCancellation(t *testing.T) {
	for _, mode := range []string{"cancel-live-tree", "leader-exits-first"} {
		t.Run(mode, func(t *testing.T) {
			launcher, _, _ := updateInstallFixture(t, "npm")
			events := updateProcessListener(t)
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			done := make(chan error, 1)
			go func() { done <- UpdateInstallation(ctx, launcher) }()

			leader := awaitUpdateEvent(t, events)
			if leader.report.Role != "leader" {
				t.Fatalf("first process role = %q, want leader", leader.report.Role)
			}
			if err := json.NewEncoder(leader.conn).Encode("spawn-descendant"); err != nil {
				t.Fatal(err)
			}
			descendant := awaitUpdateEvent(t, events)
			if descendant.report.Role != "descendant" || descendant.report.Pid == leader.report.Pid {
				t.Fatalf("descendant did not acknowledge liveness: leader=%+v descendant=%+v", leader.report, descendant.report)
			}

			leaderTerminated := subscribeUpdateTermination(leader.conn)
			descendantTerminated := subscribeUpdateTermination(descendant.conn)
			if mode == "cancel-live-tree" {
				cancel()
				if err := awaitUpdateResult(t, done); !errors.Is(err, context.Canceled) {
					t.Fatalf("cancellation = %v", err)
				}
			} else {
				if err := json.NewEncoder(leader.conn).Encode("exit"); err != nil {
					t.Fatal(err)
				}
				if err := awaitUpdateResult(t, done); err != nil {
					t.Fatalf("update after leader exit = %v", err)
				}
			}
			awaitUpdateTermination(t, "leader", leaderTerminated)
			awaitUpdateTermination(t, "descendant", descendantTerminated)
		})
	}
}

func TestUpdateInstallationRejectsUnsupported(t *testing.T) {
	for _, kind := range []string{"custom-command", "custom-omo", "local-package", "missing-node", "wrong-package", "expired"} {
		t.Run(kind, func(t *testing.T) {
			launcher, root, prefix := updateInstallFixture(t, "npm")
			switch kind {
			case "custom-command", "custom-omo":
				launcher = filepath.Join(t.TempDir(), kind)
				if kind == "custom-omo" {
					launcher = filepath.Join(filepath.Dir(launcher), "omo")
				}
				writeUpdateFile(t, launcher, "#!/bin/sh\nexit 0\n")
				// Even a valid ambient launcher must not let a custom command target it.
				t.Setenv("OMO_BIN", filepath.Join(root, "bin", "omo.js"))
				t.Setenv("OMO_AGENT_TOOLKIT_BIN", "")
			case "local-package":
				root = filepath.Join(t.TempDir(), "node_modules", "omo-ai")
				launcher = filepath.Join(root, "bin", "omo.js")
				writeUpdateFile(t, launcher, "#!/bin/sh\nexit 0\n")
				writeUpdateFile(t, filepath.Join(root, "package.json"), `{"name":"omo-ai"}`)
			case "missing-node":
				if err := os.Remove(filepath.Join(prefix, "bin", "node")); err != nil {
					t.Fatal(err)
				}
			case "wrong-package":
				writeUpdateFile(t, filepath.Join(root, "package.json"), `{"name":"other"}`)
			}
			ctx := t.Context()
			if kind == "expired" {
				var cancel context.CancelFunc
				ctx, cancel = context.WithDeadline(ctx, time.Now().Add(-time.Second))
				defer cancel()
			}
			if err := UpdateInstallation(ctx, launcher); err == nil {
				t.Fatal("unsupported update succeeded")
			}
		})
	}
}
