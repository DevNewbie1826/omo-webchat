//go:build windows

package omorpc

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/Microsoft/go-winio"
	"golang.org/x/sys/windows"
)

// Inject only the token-query result. The native pipe, server PID lookup,
// retained process handle, and observed wire remain real, so either bypassing
// identity validation or writing credentials before it makes this test fail.
func TestWindowsForeignPrincipalRejectedBeforeSecretWrite(t *testing.T) {
	controlCleanupReceipt(t)
	path := filepath.Join(t.TempDir(), "rpc.sock")
	secret := bytes.Repeat([]byte{0x5a}, 32)
	if err := os.WriteFile(path+".secret", secret, 0600); err != nil {
		t.Fatal(err)
	}
	address, err := pipeAddress(path, secret)
	if err != nil {
		t.Fatal(err)
	}
	ln, err := winio.ListenPipe(address, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	received := make(chan int, 1)
	done := make(chan struct{})
	go func() {
		defer close(done)
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		n, _ := io.ReadFull(conn, make([]byte, 32))
		received <- n
	}()
	t.Cleanup(func() {
		ln.Close()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Error("identity fixture did not stop")
		}
	})
	foreign, err := windows.CreateWellKnownSid(windows.WinLocalSystemSid)
	if err != nil {
		t.Fatal(err)
	}
	original := pipeServerUser
	t.Cleanup(func() { pipeServerUser = original })
	pipeServerUser = func(handle windows.Handle) (*windows.Tokenuser, error) {
		observed, err := original(handle)
		if err != nil {
			return nil, err
		}
		user := *observed
		user.User.Sid = foreign
		return &user, nil
	}
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	c, err := Dial(ctx, path)
	if c != nil {
		if closeErr := c.Close(); closeErr != nil {
			t.Error(closeErr)
		}
		t.Error("CONTROL_ASSERT foreign_peer foreign principal accepted")
	}
	select {
	case n := <-received:
		if n != 0 {
			t.Errorf("CONTROL_ASSERT foreign_peer disclosed %d auth bytes before identity validation", n)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if !errors.Is(err, os.ErrPermission) {
		t.Errorf("CONTROL_ASSERT foreign_peer permission rejection missing: %v", err)
	}
}

func TestWindowsForeignSecretOwnerMetadataRejected(t *testing.T) {
	cfg := pipeEnsureConfig(t)
	path := cfg.SocketPath + ".secret"
	before := bytes.Repeat([]byte{0x5b}, 32)
	if err := os.WriteFile(path, before, 0600); err != nil {
		t.Fatal(err)
	}
	// Native security-descriptor parsing supplies an unprivileged foreign owner;
	// no administrator rights or changes to runner accounts are needed.
	foreign, err := windows.SecurityDescriptorFromString("O:BUD:P(A;;FA;;;SY)(A;;FA;;;BA)")
	if err != nil {
		t.Fatal(err)
	}
	original := secretSecurityInfo
	t.Cleanup(func() { secretSecurityInfo = original })
	secretSecurityInfo = func(handle windows.Handle, kind windows.SE_OBJECT_TYPE, info windows.SECURITY_INFORMATION) (*windows.SECURITY_DESCRIPTOR, error) {
		if _, err := original(handle, kind, info); err != nil {
			return nil, err
		}
		return foreign, nil
	}
	daemon, err := EnsureDaemon(t.Context(), cfg)
	if daemon != nil {
		t.Cleanup(func() {
			if err := daemon.StopBounded(5 * time.Second); err != nil {
				t.Error(err)
			}
		})
	}
	if daemon != nil || !errors.Is(err, os.ErrPermission) {
		t.Fatalf("foreign secret owner: daemon=%v error=%v", daemon, err)
	}
	after, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(before, after) {
		t.Fatal("foreign secret changed")
	}
}

func TestWindowsCancelDialAfterPipeAccept(t *testing.T) {
	path := filepath.Join(t.TempDir(), "rpc.sock")
	secret := bytes.Repeat([]byte{0x5c}, 32)
	if err := os.WriteFile(path+".secret", secret, 0600); err != nil {
		t.Fatal(err)
	}
	address, err := pipeAddress(path, secret)
	if err != nil {
		t.Fatal(err)
	}
	ln, err := winio.ListenPipe(address, nil)
	if err != nil {
		t.Fatal(err)
	}
	accepted := make(chan struct{})
	release := make(chan struct{})
	stopped := make(chan struct{})
	go func() {
		defer close(stopped)
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		close(accepted)
		<-release
	}()
	t.Cleanup(func() {
		close(release)
		ln.Close()
		select {
		case <-stopped:
		case <-time.After(5 * time.Second):
			t.Error("blocked pipe fixture did not stop")
		}
	})
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	result := make(chan error, 1)
	go func() {
		c, err := Dial(ctx, path)
		if c != nil {
			err = errors.Join(err, c.Close())
		}
		result <- err
	}()
	select {
	case <-accepted:
	case <-time.After(5 * time.Second):
		t.Fatal("pipe was not accepted")
	}
	cancel()
	select {
	case err := <-result:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("cancel after accept: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("accepted dial did not cancel")
	}
}
