//go:build windows

package omorpc

import (
	"errors"
	"fmt"
	"net"
	"os"
	"syscall"
	"testing"
)

func TestSpawnableProbeErrorWindowsWinsockNetworkDown(t *testing.T) {
	err := &net.OpError{
		Op:  "dial",
		Net: "unix",
		Err: &os.SyscallError{Syscall: "connect", Err: syscall.Errno(10050)},
	}
	if !isSpawnableProbeError(err) {
		t.Fatalf("isSpawnableProbeError(%v) = false, want true for Winsock WSAENETDOWN", err)
	}
}

// A dead or never-started daemon leaves the AF_UNIX path answering with
// Winsock WSAECONNREFUSED (10061). Go's Windows syscall.ECONNREFUSED is a
// different constant, so matching only that one made EnsureDaemon abort at
// boot ("probe existing daemon") instead of spawning the daemon.
func TestSpawnableProbeErrorWindowsWinsockConnectionRefused(t *testing.T) {
	err := &net.OpError{
		Op:  "dial",
		Net: "unix",
		Err: &os.SyscallError{Syscall: "connect", Err: syscall.Errno(10061)},
	}
	if errors.Is(err, syscall.ECONNREFUSED) {
		t.Fatal("precondition failed: Winsock 10061 must not match syscall.ECONNREFUSED on Windows")
	}
	if !isSpawnableProbeError(err) {
		t.Fatalf("isSpawnableProbeError(%v) = false, want true for Winsock WSAECONNREFUSED", err)
	}
}

func TestSpawnableProbeErrorWindowsRejectsOtherErrors(t *testing.T) {
	for _, err := range []error{
		errors.New("dial failed"),
		fmt.Errorf("dial unix: connect: %w", syscall.EACCES),
	} {
		if isSpawnableProbeError(err) {
			t.Errorf("isSpawnableProbeError(%v) = true, want false", err)
		}
	}
}
