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
