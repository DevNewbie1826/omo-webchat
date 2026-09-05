//go:build windows

package omorpc

import (
	"errors"
	"fmt"
	"net"
	"os"
	"sync"

	"golang.org/x/sys/windows"
)

type identifiedPipe struct {
	net.Conn
	mu        sync.Mutex
	process   windows.Handle
	pid       uint32
	identity  socketIdentity
	closeOnce sync.Once
	closeErr  error
}

func identifyPipeServer(conn net.Conn) (*identifiedPipe, error) {
	fd, ok := conn.(interface{ Fd() uintptr })
	if !ok {
		return nil, errors.New("omorpc: pipe handle unavailable")
	}
	var pid uint32
	if err := windows.GetNamedPipeServerProcessId(windows.Handle(fd.Fd()), &pid); err != nil {
		return nil, err
	}
	process, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.SYNCHRONIZE, false, pid)
	if err != nil {
		return nil, err
	}
	fail := func(err error) (*identifiedPipe, error) { return nil, errors.Join(err, windows.CloseHandle(process)) }
	user, err := pipeServerUser(process)
	if err != nil {
		return fail(err)
	}
	current, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return fail(err)
	}
	if !user.User.Sid.Equals(current.User.Sid) {
		return fail(fmt.Errorf("omorpc: pipe server belongs to another account: %w", os.ErrPermission))
	}
	var creation, exit, kernel, elapsed windows.Filetime
	if err := windows.GetProcessTimes(process, &creation, &exit, &kernel, &elapsed); err != nil {
		return fail(err)
	}
	var after uint32
	if err := windows.GetNamedPipeServerProcessId(windows.Handle(fd.Fd()), &after); err != nil {
		return fail(err)
	}
	state, err := windows.WaitForSingleObject(process, 0)
	if err != nil {
		return fail(err)
	}
	if after != pid || state != uint32(windows.WAIT_TIMEOUT) {
		return fail(errors.New("omorpc: pipe server identity changed"))
	}
	return &identifiedPipe{Conn: conn, process: process, pid: pid,
		identity: socketIdentity{Device: uint64(pid), Inode: uint64(creation.HighDateTime)<<32 | uint64(creation.LowDateTime)}}, nil
}

func (p *identifiedPipe) Close() error {
	p.closeOnce.Do(func() {
		p.mu.Lock()
		defer p.mu.Unlock()
		p.closeErr = errors.Join(p.Conn.Close(), windows.CloseHandle(p.process))
		p.process = 0
	})
	return p.closeErr
}

func connectionPeerPID(conn net.Conn) (int, error) {
	p, ok := conn.(*identifiedPipe)
	if !ok {
		return 0, errors.New("omorpc: unauthenticated pipe connection")
	}
	return int(p.pid), nil
}

func connectionPeerProvenance(conn net.Conn, supervisorPID int) peerProvenance {
	p, ok := conn.(*identifiedPipe)
	if !ok {
		return peerUnknown
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.process == 0 {
		return peerUnknown
	}
	tracked, ok := windowsSupervisorDomains.Load(supervisorPID)
	if !ok {
		return peerForeign
	}
	domain, ok := tracked.(interface{ ContainsProcess(uintptr) (bool, error) })
	if !ok {
		return peerUnknown
	}
	owned, err := domain.ContainsProcess(uintptr(p.process))
	if err != nil {
		return peerUnknown
	}
	if owned {
		return peerOwned
	}
	return peerForeign
}

// The syscall boundary is replaceable only by package tests; the connection,
// server PID, retained process handle, and pre-auth rejection remain real.
var pipeServerUser = func(process windows.Handle) (*windows.Tokenuser, error) {
	var token windows.Token
	if err := windows.OpenProcessToken(process, windows.TOKEN_QUERY, &token); err != nil {
		return nil, err
	}
	user, err := token.GetTokenUser()
	return user, errors.Join(err, token.Close())
}
