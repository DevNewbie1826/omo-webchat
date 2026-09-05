//go:build windows

// Package profile contains cleanup barriers shared by the real Windows probes.
package profile

import (
	"context"
	"errors"
	"fmt"
	"golang.org/x/sys/windows"
	"os"
	"runtime"
	"time"
	"unsafe"
)

// RemoveAll waits for exact native directory holders to exit before one removal.
// Discovered holders are never killed. Every native handle is checked on close.
func RemoveAll(dir string) error {
	if err := WaitDirectoryHolders(dir, nil, func(format string, args ...any) { fmt.Printf(format+"\n", args...) }); err != nil {
		return err
	}
	return os.RemoveAll(dir)
}

// WaitDirectoryHolders retains native process handles, confirms directory
// membership, and joins their exit events under one overall acquisition/wait bound.
// observed is used by the real holder fixture to release its explicitly owned
// child only after the native membership confirmation.
func WaitDirectoryHolders(dir string, observed func(uint32), logf func(string, ...any)) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	deadline, _ := ctx.Deadline()
	return directoryIO(ctx, func() (resultErr error) {
		path, err := windows.UTF16PtrFromString(dir)
		if err != nil {
			return err
		}
		h, err := windows.CreateFile(path, windows.FILE_READ_ATTRIBUTES, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
			nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
		if err != nil {
			return err
		}
		defer func() { resultErr = errors.Join(resultErr, windows.CloseHandle(h)) }()
		query := func() ([]uintptr, error) {
			var info struct {
				Count uint32
				IDs   [128]uintptr
			}
			var status windows.IO_STATUS_BLOCK
			const fileProcessIdsUsingFileInformation = 47
			if err := windows.NtQueryInformationFile(h, &status, (*byte)(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info)), fileProcessIdsUsingFileInformation); err != nil {
				return nil, err
			}
			if info.Count > uint32(len(info.IDs)) {
				return nil, fmt.Errorf("directory holder list overflow: %d", info.Count)
			}
			return info.IDs[:info.Count], nil
		}
		ids, err := query()
		if err != nil {
			return err
		}
		type holder struct {
			pid    uintptr
			handle windows.Handle
		}
		var holders []holder
		defer func() {
			for _, holder := range holders {
				if holder.handle != 0 {
					resultErr = errors.Join(resultErr, windows.CloseHandle(holder.handle))
				}
			}
		}()
		for _, pid := range ids {
			if pid == uintptr(os.Getpid()) {
				continue // The query owns h; self-only output proves no application leak.
			}
			p, err := windows.OpenProcess(windows.SYNCHRONIZE|windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
			if errors.Is(err, windows.ERROR_INVALID_PARAMETER) {
				logf("cleanup: directory-holder pid=%d already exited before native handle open", pid)
				continue
			}
			if err != nil {
				return err
			}
			holders = append(holders, holder{pid, p})
		}
		// Confirm membership AFTER retaining the process handles; the first PID
		// snapshot alone is not a safe identity across process exit/PID reuse.
		confirmed, err := query()
		if err != nil {
			return err
		}
		for i, holder := range holders {
			stillHolds := false
			for _, pid := range confirmed {
				stillHolds = stillHolds || pid == holder.pid
			}
			if !stillHolds {
				continue // Native confirmation shows this process released the resource.
			}
			var code uint32
			if err := windows.GetExitCodeProcess(holder.handle, &code); err != nil {
				return err
			}
			logf("cleanup: directory-holder pid=%d native-membership-confirmed=true exit-handle-retained=true", holder.pid)
			if observed != nil {
				observed(uint32(holder.pid))
			}
			remaining := time.Until(deadline)
			if remaining <= 0 {
				return context.DeadlineExceeded
			}
			milliseconds := uint32((remaining + time.Millisecond - 1) / time.Millisecond)
			state, waitErr := windows.WaitForSingleObject(holder.handle, milliseconds)
			closeErr := windows.CloseHandle(holder.handle)
			holders[i].handle = 0
			if err := errors.Join(waitErr, closeErr); err != nil {
				return err
			}
			if state != windows.WAIT_OBJECT_0 {
				return fmt.Errorf("directory-holder pid=%d exit event did not signal: %d: %w", holder.pid, state, context.DeadlineExceeded)
			}
			logf("cleanup: directory-holder pid=%d initial-exit-code=%d process-exit-signaled=true handle-closed=true", holder.pid, code)
		}
		return nil
	})
}

var cancelSynchronousIO = windows.NewLazySystemDLL("kernel32.dll").NewProc("CancelSynchronousIo")

// Synchronous filesystem operations (including CreateFile and GetSecurityInfo)
// cannot use CancelIoEx on a handle that has not been returned yet. Keep the
// entire acquisition/publication and cleanup on one retained native thread.
// Cancellation repeatedly targets that thread until work has joined: a single
// CancelSynchronousIo has a check-to-syscall race and does not cancel future I/O.
// The thread is not returned to Go's pool until the cancellation callback joins.
func directoryIO(ctx context.Context, work func() error) (resultErr error) {
	if err := ctx.Err(); err != nil {
		return err
	}
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	thread, err := windows.OpenThread(windows.THREAD_TERMINATE, false, windows.GetCurrentThreadId())
	if err != nil {
		return err
	}
	finished := make(chan struct{})
	canceled := make(chan error, 1)
	stop := context.AfterFunc(ctx, func() {
		for {
			select {
			case <-finished:
				canceled <- nil
				return
			default:
			}
			ok, _, err := cancelSynchronousIO.Call(uintptr(thread))
			// NOT_FOUND means the thread is between native operations. Retry until
			// joined so cancellation cannot miss the next synchronous syscall.
			if ok == 0 && !errors.Is(err, windows.ERROR_NOT_FOUND) {
				<-finished
				canceled <- fmt.Errorf("profile: CancelSynchronousIo: %w", err)
				return
			}
			runtime.Gosched()
		}
	})
	defer func() {
		close(finished)
		if !stop() {
			resultErr = errors.Join(resultErr, <-canceled)
		}
		resultErr = errors.Join(ctx.Err(), resultErr, windows.CloseHandle(thread))
	}()
	if err := ctx.Err(); err != nil {
		return err
	}
	return work()
}
