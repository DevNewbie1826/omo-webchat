//go:build windows

package omorpc

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

func TestWindowsEnsureRejectsMalformedSecretWithoutOverwrite(t *testing.T) {
	for _, size := range []int{0, 31, 33} {
		t.Run(string(rune('a'+size)), func(t *testing.T) {
			cfg := pipeEnsureConfig(t)
			original := bytes.Repeat([]byte{0x41}, size)
			if err := os.WriteFile(cfg.SocketPath+".secret", original, 0600); err != nil {
				t.Fatal(err)
			}
			daemon, err := EnsureDaemon(t.Context(), cfg)
			if daemon != nil || !errors.Is(err, os.ErrPermission) {
				t.Fatalf("malformed secret: daemon=%v error=%v", daemon, err)
			}
			after, err := os.ReadFile(cfg.SocketPath + ".secret")
			if err != nil || !bytes.Equal(original, after) {
				t.Fatal("malformed secret was overwritten")
			}
		})
	}
}

func TestWindowsEnsureRejectsSecretDirectoryAndParentJunction(t *testing.T) {
	for _, parent := range []bool{false, true} {
		t.Run(map[bool]string{false: "secret", true: "parent"}[parent], func(t *testing.T) {
			cfg := pipeEnsureConfig(t)
			target := t.TempDir()
			link := cfg.SocketPath + ".secret"
			if parent {
				link = filepath.Join(filepath.Dir(cfg.SocketPath), "junction")
				cfg.SocketPath = filepath.Join(link, "rpc.sock")
			}
			if out, err := exec.Command("cmd", "/c", "mklink", "/J", link, target).CombinedOutput(); err != nil {
				t.Fatalf("create junction: %v: %s", err, out)
			}
			t.Cleanup(func() {
				if err := os.Remove(link); err != nil {
					t.Error(err)
				}
			})
			daemon, err := EnsureDaemon(t.Context(), cfg)
			if daemon != nil || !errors.Is(err, os.ErrPermission) {
				t.Fatalf("reparse secret: daemon=%v error=%v", daemon, err)
			}
			entries, err := os.ReadDir(target)
			if err != nil || len(entries) != 0 {
				t.Fatal("ensure wrote through a reparse point")
			}
		})
	}
}

func TestWindowsEnsureRejectsPublicSecretACL(t *testing.T) {
	cfg := pipeEnsureConfig(t)
	path := cfg.SocketPath + ".secret"
	if err := os.WriteFile(path, bytes.Repeat([]byte{0x41}, 32), 0600); err != nil {
		t.Fatal(err)
	}
	sd, err := windows.SecurityDescriptorFromString("D:P(A;;FA;;;WD)")
	if err != nil {
		t.Fatal(err)
	}
	acl, _, err := sd.DACL()
	if err != nil {
		t.Fatal(err)
	}
	if err := windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, acl, nil); err != nil {
		t.Fatal(err)
	}
	daemon, err := EnsureDaemon(t.Context(), cfg)
	if daemon != nil || !errors.Is(err, os.ErrPermission) {
		t.Fatalf("public secret accepted: %v", err)
	}
}

func TestWindowsCanceledDialDoesNotReadSecret(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	_, err := Dial(ctx, filepath.Join(t.TempDir(), "missing.sock"))
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled Dial: %v", err)
	}
}

func TestWindowsPipeReadDeadlineAndClose(t *testing.T) {
	path := productionPipeFixture(t)
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	conn, err := dialEndpoint(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	// Time is the behavior under test: an already-expired read deadline must
	// fail without relying on scheduling or the server's timeout.
	if err := conn.SetReadDeadline(time.Now().Add(-time.Second)); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Read(make([]byte, 1)); !errors.Is(err, os.ErrDeadlineExceeded) {
		t.Fatalf("read deadline: %v", err)
	}
	if err := conn.SetReadDeadline(time.Time{}); err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{})
	done := make(chan error, 1)
	go func() { close(started); _, err := conn.Read(make([]byte, 1)); done <- err }()
	<-started
	if err := conn.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("blocked read survived Close")
		}
	case <-ctx.Done():
		t.Fatal("Close did not release blocked I/O")
	}
}
