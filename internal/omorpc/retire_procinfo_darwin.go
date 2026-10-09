package omorpc

import (
	"syscall"

	"golang.org/x/sys/unix"
)

func inspectEngineProcess(pid int) (engineProcessInfo, error) {
	proc, err := unix.SysctlKinfoProc("kern.proc.pid", pid)
	if err != nil {
		return engineProcessInfo{}, err
	}
	if proc.Proc.P_pid != int32(pid) {
		return engineProcessInfo{}, syscall.ESRCH
	}
	pgid, err := syscall.Getpgid(pid)
	if err != nil {
		return engineProcessInfo{}, err
	}
	start := proc.Proc.P_starttime
	return engineProcessInfo{
		startTime: uint64(start.Sec)*1_000_000 + uint64(start.Usec),
		pgid:      pgid,
		uid:       int(proc.Eproc.Ucred.Uid),
	}, nil
}
