//go:build darwin || linux

package omorpc

import (
	"errors"
	"fmt"
	"net"
	"runtime"
	"syscall"
	"unsafe"
)

func connectionPeerPID(conn net.Conn) (int, error) {
	syscallConn, ok := conn.(syscall.Conn)
	if !ok {
		return 0, errors.New("connection does not expose a file descriptor")
	}
	raw, err := syscallConn.SyscallConn()
	if err != nil {
		return 0, err
	}
	var pid int32
	var socketErr error
	err = raw.Control(func(fd uintptr) {
		length := uint32(unsafe.Sizeof(pid))
		level, option := uintptr(0), uintptr(2) // SOL_LOCAL, LOCAL_PEERPID on Darwin.
		var credentials [3]int32
		value := unsafe.Pointer(&pid)
		if runtime.GOOS == "linux" {
			level, option = 1, 17 // SOL_SOCKET, SO_PEERCRED.
			length = uint32(unsafe.Sizeof(credentials))
			value = unsafe.Pointer(&credentials[0])
		}
		_, _, errno := syscall.Syscall6(syscall.SYS_GETSOCKOPT, fd, level, option, uintptr(value), uintptr(unsafe.Pointer(&length)), 0)
		if errno != 0 {
			socketErr = errno
			return
		}
		if runtime.GOOS == "linux" {
			pid = credentials[0]
		}
	})
	if err != nil {
		return 0, err
	}
	if socketErr != nil {
		return 0, socketErr
	}
	if pid <= 0 {
		return 0, fmt.Errorf("invalid peer pid %d", pid)
	}
	return int(pid), nil
}

// classifyPeerProvenance resolves a peer PID to process-group membership with
// getpgid(2): a peer whose process group matches the launch group is owned,
// any other live PID is foreign, and an unresolvable PID stays unknown.
func classifyPeerProvenance(pid int, credentialErr error, processGroup int) peerProvenance {
	if credentialErr != nil || pid <= 0 {
		return peerUnknown
	}
	if pid == processGroup {
		return peerOwned
	}
	pgid, err := syscall.Getpgid(pid)
	if err != nil {
		return peerUnknown
	}
	if pgid == processGroup {
		return peerOwned
	}
	return peerForeign
}
