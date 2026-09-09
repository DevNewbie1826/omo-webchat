package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc/omorpctest/transport"
)

func TestFixtureSubprocess(t *testing.T) {
	root := os.Getenv("NATIVE_FIXTURE_TEST_ROOT")
	if root == "" {
		return
	}
	flag.CommandLine = flag.NewFlagSet("nativefixture", flag.ContinueOnError)
	os.Args = []string{"nativefixture", "--root", root}
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	os.Exit(0)
}

func TestPrivateEOFStopsNativeEndpoint(t *testing.T) {
	// Keep Unix socket names below sockaddr_un's native path limit.
	root, err := os.MkdirTemp("", "nf-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.RemoveAll(root); err != nil {
			t.Error(err)
		}
	})
	cmd := exec.Command(os.Args[0], "-test.run=^TestFixtureSubprocess$")
	cmd.Env = append(os.Environ(), "NATIVE_FIXTURE_TEST_ROOT="+root)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	joined := make(chan error, 1)
	go func() { joined <- cmd.Wait() }()
	exited := false
	defer func() {
		_ = stdin.Close()
		if !exited {
			_ = cmd.Process.Kill()
			select {
			case <-joined:
			case <-time.After(10 * time.Second):
				t.Error("fixture did not join")
			}
		}
	}()
	type readyRecord struct {
		Event  string  `json:"event"`
		Assets []asset `json:"assets"`
	}
	var ready readyRecord
	decoded := make(chan error, 1)
	go func() { decoded <- json.NewDecoder(stdout).Decode(&ready) }()
	select {
	case err := <-decoded:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("fixture readiness deadline")
	}
	if ready.Event != "fixture-ready" || len(ready.Assets) == 0 {
		t.Fatalf("invalid readiness: %+v", ready)
	}
	endpoint := filepath.Join(root, "agent", "rpc", "rpc.sock")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, err := transport.Dial(ctx, endpoint)
	if err != nil {
		t.Fatalf("ready endpoint unavailable: %v", err)
	}
	if err := conn.Close(); err != nil {
		t.Fatal(err)
	}
	if err := stdin.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-joined:
		exited = true
		if err != nil {
			t.Fatalf("EOF stop: %v: %s", err, stderr.String())
		}
	case <-time.After(10 * time.Second):
		t.Fatal("EOF did not stop fixture")
	}
	conn, err = transport.Dial(ctx, endpoint)
	if err == nil {
		conn.Close()
		t.Fatal("fixture endpoint survived process join")
	}
}
