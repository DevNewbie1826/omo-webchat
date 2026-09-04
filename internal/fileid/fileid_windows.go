//go:build windows

package fileid

import (
	"os"
	"syscall"
)

// fileReadAttributes is Win32 FILE_READ_ATTRIBUTES (0x80): metadata access
// sufficient for GetFileInformationByHandle without GENERIC_READ.
const fileReadAttributes = 0x00000080

// FromPath opens path with FILE_READ_ATTRIBUTES and reads identity from
// GetFileInformationByHandle (VolumeSerialNumber, nFileIndex).
// FILE_FLAG_BACKUP_SEMANTICS lets directories open; FILE_FLAG_OPEN_REPARSE_POINT
// matches Lstat (do not follow reparse points). Any file type; open failure
// (including a missing path) returns ok=false.
func FromPath(path string) (Identity, bool) {
	ptr, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return Identity{}, false
	}
	handle, err := syscall.CreateFile(
		ptr,
		fileReadAttributes,
		syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE|syscall.FILE_SHARE_DELETE,
		nil,
		syscall.OPEN_EXISTING,
		syscall.FILE_FLAG_BACKUP_SEMANTICS|syscall.FILE_FLAG_OPEN_REPARSE_POINT,
		0,
	)
	if err != nil {
		return Identity{}, false
	}
	defer syscall.CloseHandle(handle)

	var info syscall.ByHandleFileInformation
	if err := syscall.GetFileInformationByHandle(handle, &info); err != nil {
		return Identity{}, false
	}
	return Identity{
		Device: uint64(info.VolumeSerialNumber),
		Inode:  uint64(info.FileIndexHigh)<<32 | uint64(info.FileIndexLow),
	}, true
}

// FromInfo reports ok=false on Windows: os.FileInfo.Sys() is
// Win32FileAttributeData from FindFirstFile/GetFileAttributesEx, which
// does not include nFileIndex. Callers keep a size+mtime fallback.
func FromInfo(_ os.FileInfo) (Identity, bool) {
	return Identity{}, false
}
