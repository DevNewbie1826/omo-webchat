//go:build windows

package transport

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

func TestSecretRotationWaitsForSnapshotReader(t *testing.T) {
	path := filepath.Join(t.TempDir(), "d.sock.secret")
	if err := os.WriteFile(path, bytes.Repeat([]byte{1}, 32), 0600); err != nil {
		t.Fatal(err)
	}
	ptr, err := windows.UTF16PtrFromString(path)
	if err != nil {
		t.Fatal(err)
	}
	h, err := windows.CreateFile(ptr, windows.GENERIC_READ, windows.FILE_SHARE_READ, nil, windows.OPEN_EXISTING, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	closed := false
	defer func() {
		if !closed {
			windows.CloseHandle(h)
		}
	}()
	next := bytes.Repeat([]byte{2}, 32)
	done := make(chan error, 1)
	go func() { done <- writeSecret(path, next) }()
	select {
	case err := <-done:
		t.Fatalf("rotation completed while reader held snapshot: %v", err)
	case <-time.After(25 * time.Millisecond):
	}
	if err := windows.CloseHandle(h); err != nil {
		t.Fatal(err)
	}
	closed = true
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("rotation did not complete after reader closed")
	}
	got, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(got, next) {
		t.Fatalf("new secret=%x error=%v", got, err)
	}
}
