//go:build windows

package omorpc

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

const socketSecretBytes = 32

var cancelSynchronousIO = windows.NewLazySystemDLL("kernel32.dll").NewProc("CancelSynchronousIo")

// Synchronous filesystem operations (including CreateFile and GetSecurityInfo)
// cannot use CancelIoEx on a handle that has not been returned yet. Keep the
// entire acquisition/publication and cleanup on one retained native thread.
// Cancellation repeatedly targets that thread until work has joined: a single
// CancelSynchronousIo has a check-to-syscall race and does not cancel future I/O.
// The thread is not returned to Go's pool until the cancellation callback joins.
func endpointIO(ctx context.Context, work func() error) (resultErr error) {
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
				canceled <- fmt.Errorf("omorpc: CancelSynchronousIo: %w", err)
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

// A narrow native-metadata seam for adversarial owner/ACL tests.
var secretSecurityInfo = windows.GetSecurityInfo

func logicalEndpoint(path string) (string, error) {
	// Raw pipes have no filesystem secret, and drive-relative paths depend on
	// per-process state. Keep the runtime's drive-qualified/UNC contract.
	if !filepath.IsAbs(path) || strings.HasPrefix(strings.ToLower(path), `\\.\`) || strings.HasPrefix(path, `\\?\`) {
		return "", fmt.Errorf("omorpc: RPC endpoint must be a drive-qualified or UNC filesystem path")
	}
	return filepath.Clean(path), nil
}

// pinSecretParents rejects reparse traversal and holds each existing parent
// against rename until the secret handle has been validated/read or published.
func pinSecretParents(ctx context.Context, path string) (func() error, error) {
	var dirs []string
	for dir := filepath.Dir(path); ; dir = filepath.Dir(dir) {
		dirs = append(dirs, dir)
		if filepath.Dir(dir) == dir {
			break
		}
	}
	var handles []windows.Handle
	closeAll := func() error {
		var err error
		for i := len(handles) - 1; i >= 0; i-- {
			err = errors.Join(err, windows.CloseHandle(handles[i]))
		}
		return err
	}
	for i := len(dirs) - 1; i >= 0; i-- {
		if err := ctx.Err(); err != nil {
			return nil, errors.Join(err, closeAll())
		}
		ptr, err := windows.UTF16PtrFromString(dirs[i])
		if err != nil {
			return nil, errors.Join(err, closeAll())
		}
		h, err := windows.CreateFile(ptr, windows.FILE_READ_ATTRIBUTES,
			windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_EXISTING,
			windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
		if err != nil {
			return nil, errors.Join(err, closeAll())
		}
		handles = append(handles, h)
		var info windows.ByHandleFileInformation
		if err := windows.GetFileInformationByHandle(h, &info); err != nil {
			return nil, errors.Join(err, closeAll())
		}
		if info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
			return nil, errors.Join(fmt.Errorf("omorpc: reparse parent: %w", os.ErrPermission), closeAll())
		}
	}
	return closeAll, nil
}

func readEndpointSecret(ctx context.Context, path string) (secret []byte, err error) {
	err = endpointIO(ctx, func() error {
		var readErr error
		secret, readErr = readEndpointSecretSync(ctx, path)
		return readErr
	})
	return secret, err
}

// Called on endpointIO's locked thread, including all handle cleanup.
func readEndpointSecretSync(ctx context.Context, path string) (secret []byte, resultErr error) {
	path, err := logicalEndpoint(path)
	if err != nil {
		return nil, err
	}
	release, err := pinSecretParents(ctx, path)
	if err != nil {
		return nil, err
	}
	defer func() { resultErr = errors.Join(resultErr, release()) }()
	ptr, err := windows.UTF16PtrFromString(path + ".secret")
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	h, err := windows.CreateFile(ptr, windows.GENERIC_READ|windows.READ_CONTROL,
		windows.FILE_SHARE_READ, nil, windows.OPEN_EXISTING,
		windows.FILE_FLAG_OPEN_REPARSE_POINT|windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		return nil, err
	}
	file := os.NewFile(uintptr(h), path+".secret")
	defer func() { resultErr = errors.Join(resultErr, file.Close()) }()
	if err := validateSecretHandle(h); err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	secret, err = io.ReadAll(io.LimitReader(file, socketSecretBytes+1))
	if err != nil {
		return nil, err
	}
	if len(secret) != socketSecretBytes {
		return nil, fmt.Errorf("omorpc: malformed RPC secret: %w", os.ErrPermission)
	}
	return secret, nil
}

func validateSecretHandle(h windows.Handle) error {
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(h, &info); err != nil {
		return err
	}
	if info.FileAttributes&(windows.FILE_ATTRIBUTE_REPARSE_POINT|windows.FILE_ATTRIBUTE_DIRECTORY) != 0 || info.NumberOfLinks != 1 {
		return fmt.Errorf("omorpc: RPC secret must be a regular, unlinked file: %w", os.ErrPermission)
	}
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return err
	}
	sd, err := secretSecurityInfo(h, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return err
	}
	owner, _, err := sd.Owner()
	if err != nil {
		return err
	}
	trusted := func(sid *windows.SID) bool {
		return sid.Equals(user.User.Sid) || sid.IsWellKnown(windows.WinLocalSystemSid) || sid.IsWellKnown(windows.WinBuiltinAdministratorsSid)
	}
	if !trusted(owner) {
		return fmt.Errorf("omorpc: untrusted secret owner: %w", os.ErrPermission)
	}
	acl, _, err := sd.DACL()
	if err != nil {
		return err
	}
	if acl == nil {
		return fmt.Errorf("omorpc: unrestricted secret ACL: %w", os.ErrPermission)
	}
	const sensitive = windows.GENERIC_ALL | windows.GENERIC_READ | windows.GENERIC_WRITE | windows.FILE_READ_DATA | windows.FILE_WRITE_DATA | windows.FILE_APPEND_DATA | windows.WRITE_DAC | windows.WRITE_OWNER | windows.DELETE
	for i := uint32(0); i < uint32(acl.AceCount); i++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if err := windows.GetAce(acl, i, &ace); err != nil {
			return err
		}
		if ace.Header.AceFlags&windows.INHERIT_ONLY_ACE != 0 || ace.Header.AceType == windows.ACCESS_DENIED_ACE_TYPE {
			continue
		}
		if ace.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE {
			return fmt.Errorf("omorpc: unsupported secret ACL: %w", os.ErrPermission)
		}
		// GetAce returns a kernel-validated variable-length ACE; SidStart is the
		// start of its SID, not a Go-owned allocation.
		sid := (*windows.SID)(unsafe.Pointer(&ace.SidStart))
		if ace.Mask&sensitive != 0 && !trusted(sid) {
			return fmt.Errorf("omorpc: secret is accessible to another account: %w", os.ErrPermission)
		}
	}
	return nil
}

// Called only under the endpoint lock. Publish a complete, private secret
// without replacing any existing entry. Keep it after Stop: other daemons or
// clients may still hold this endpoint's credentials.
func prepareEndpoint(ctx context.Context, cfg EnsureConfig) error {
	return endpointIO(ctx, func() error {
		if err := os.MkdirAll(filepath.Dir(cfg.SocketPath), 0700); err != nil {
			return fmt.Errorf("omorpc: create socket directory: %w", err)
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := os.MkdirAll(cfg.StateDir, 0700); err != nil {
			return fmt.Errorf("omorpc: create daemon state directory: %w", err)
		}
		return prepareEndpointSync(ctx, cfg)
	})
}

func prepareEndpointSync(ctx context.Context, cfg EnsureConfig) (resultErr error) {
	if err := ctx.Err(); err != nil {
		return err
	}
	if _, err := readEndpointSecretSync(ctx, cfg.SocketPath); err == nil {
		return os.MkdirAll(filepath.Join(cfg.AgentDir, "rpc-host-daemon"), 0700)
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	release, err := pinSecretParents(ctx, cfg.SocketPath)
	if err != nil {
		return err
	}
	defer func() { resultErr = errors.Join(resultErr, release()) }()
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return err
	}
	sd, err := windows.SecurityDescriptorFromString("O:" + user.User.Sid.String() + "D:P(A;;FA;;;" + user.User.Sid.String() + ")(A;;FA;;;SY)(A;;FA;;;BA)")
	if err != nil {
		return err
	}
	temp := filepath.Join(filepath.Dir(cfg.SocketPath), ".rpc-secret-"+rand.Text())
	ptr, err := windows.UTF16PtrFromString(temp)
	if err != nil {
		return err
	}
	sa := windows.SecurityAttributes{Length: uint32(unsafe.Sizeof(windows.SecurityAttributes{})), SecurityDescriptor: sd}
	if err := ctx.Err(); err != nil {
		return err
	}
	h, err := windows.CreateFile(ptr, windows.GENERIC_WRITE, 0, &sa, windows.CREATE_NEW, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		return err
	}
	file := os.NewFile(uintptr(h), temp)
	secret := make([]byte, socketSecretBytes)
	_, randomErr := rand.Read(secret)
	var writeErr error
	if randomErr == nil {
		_, writeErr = file.Write(secret)
	}
	if err := errors.Join(randomErr, writeErr, file.Close()); err != nil {
		return errors.Join(err, os.Remove(temp))
	}
	target, err := windows.UTF16PtrFromString(cfg.SocketPath + ".secret")
	if err != nil {
		return errors.Join(err, os.Remove(temp))
	}
	if err := ctx.Err(); err != nil {
		return errors.Join(err, os.Remove(temp))
	}
	if err := windows.MoveFileEx(ptr, target, 0); err != nil {
		removeErr := os.Remove(temp)
		if !errors.Is(err, windows.ERROR_ALREADY_EXISTS) && !errors.Is(err, windows.ERROR_FILE_EXISTS) {
			return errors.Join(err, removeErr)
		}
		if removeErr != nil {
			return removeErr
		}
	}
	if _, err := readEndpointSecretSync(ctx, cfg.SocketPath); err != nil {
		return err
	}
	return os.MkdirAll(filepath.Join(cfg.AgentDir, "rpc-host-daemon"), 0700)
}
