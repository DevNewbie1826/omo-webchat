//go:build darwin || linux

package omorpc_test

import (
	"encoding/json"
	"io"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"strconv"
	"syscall"
	"testing"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc/omorpctest"
)

// This external-package helper shares the test binary with the internal guards
// while importing omorpctest without introducing an omorpc import cycle.
func TestRetireEngineHelper(t *testing.T) {
	path := os.Getenv("OMO_RETIRE_HELPER_SOCKET")
	if path == "" {
		return
	}
	mode := os.Getenv("OMO_RETIRE_HELPER_MODE")
	depth, _ := strconv.Atoi(os.Getenv("OMO_RETIRE_HELPER_DEPTH"))
	term := make(chan os.Signal, 1)
	if mode == "ignore" {
		signal.Ignore(syscall.SIGTERM)
	} else {
		signal.Notify(term, syscall.SIGTERM)
		defer signal.Stop(term)
	}
	pids := []int{os.Getpid()}
	var child *exec.Cmd
	if depth > 0 {
		reader, writer, err := os.Pipe()
		if err != nil {
			t.Fatal(err)
		}
		binary, err := os.Executable()
		if err != nil {
			t.Fatal(err)
		}
		child = exec.Command(binary, "-test.run=^TestRetireEngineHelper$")
		child.Env = append(os.Environ(), "OMO_RETIRE_HELPER_DEPTH="+strconv.Itoa(depth-1), "OMO_RETIRE_HELPER_DESCENDANT=1")
		child.ExtraFiles = []*os.File{writer}
		child.Stderr = os.Stderr
		if err := child.Start(); err != nil {
			t.Fatal(err)
		}
		_ = writer.Close()
		var descendants []int
		if err := json.NewDecoder(reader).Decode(&descendants); err != nil {
			t.Fatal(err)
		}
		_ = reader.Close()
		pids = append(pids, descendants...)
	}
	if os.Getenv("OMO_RETIRE_HELPER_DESCENDANT") == "" {
		if mode == "no-handshake" {
			listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: path, Net: "unix"})
			if err != nil {
				t.Fatal(err)
			}
			listener.SetUnlinkOnClose(false)
			go func() {
				for {
					conn, err := listener.Accept()
					if err != nil {
						return
					}
					go func() {
						defer conn.Close()
						_, _ = io.Copy(io.Discard, conn)
					}()
				}
			}()
			defer listener.Close()
		} else {
			d := omorpctest.NewAt(os.Getenv("OMO_RETIRE_HELPER_DIR"), path)
			if err := d.Start(); err != nil {
				t.Fatal(err)
			}
			// Keep the pathname after exit: the retirement path must unlink it.
			// Do not call d.Stop here, which would unlink automatically.
		}
	}
	// No supervisor or socket tokens are passed in argv. Rewrite the Go-visible
	// title too, after resolving the child executable; identity must ignore it.
	os.Args = []string{"plain-worker"}
	ready := os.NewFile(3, "retire-ready")
	if err := json.NewEncoder(ready).Encode(pids); err != nil {
		t.Fatal(err)
	}
	_ = ready.Close()
	if mode == "ignore" {
		// The parent also owns stdin; EOF provides deterministic teardown if
		// a test fails before signalling the helper.
		_, _ = io.Copy(io.Discard, os.Stdin)
		return
	}
	<-term
	if child != nil {
		// A group TERM reaches every descendant. Reap before exiting so group
		// disappearance is observable without depending on init's reaping.
		_ = child.Wait()
	}
}
