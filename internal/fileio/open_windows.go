//go:build windows

package fileio

import (
	"os"
	"runtime"

	"golang.org/x/sys/windows"
)

var reOpenFile = windows.NewLazySystemDLL("kernel32.dll").NewProc("ReOpenFile")

func shareDelete(f *os.File) (*os.File, error) {
	// ReOpenFile refers to the already-open object, including when it was
	// resolved through os.Root. Closing the original releases its delete lock.
	h, _, err := reOpenFile.Call(f.Fd(), windows.GENERIC_READ,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, 0)
	runtime.KeepAlive(f)
	closeErr := f.Close()
	if windows.Handle(h) == windows.InvalidHandle {
		return nil, &os.PathError{Op: "ReOpenFile", Path: f.Name(), Err: err}
	}
	if closeErr != nil {
		windows.CloseHandle(windows.Handle(h))
		return nil, closeErr
	}
	return os.NewFile(h, f.Name()), nil
}
