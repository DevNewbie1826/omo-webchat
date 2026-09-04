//go:build darwin || linux

package fileid

import (
	"os"
	"syscall"
)

// FromPath Lstats path and requires a unix-domain socket (S_IFSOCK /
// os.ModeSocket). Identity is st_dev/st_ino from Stat_t. Missing paths,
// non-sockets, and a Sys() that is not *Stat_t return ok=false.
func FromPath(path string) (Identity, bool) {
	info, err := os.Lstat(path)
	if err != nil || info.Mode()&os.ModeSocket == 0 {
		return Identity{}, false
	}
	return FromInfo(info)
}

// FromInfo extracts st_dev/st_ino from FileInfo.Sys() *syscall.Stat_t.
// ok=false when info is nil or Sys is not Stat_t.
func FromInfo(info os.FileInfo) (Identity, bool) {
	if info == nil {
		return Identity{}, false
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return Identity{}, false
	}
	return Identity{Device: uint64(stat.Dev), Inode: uint64(stat.Ino)}, true
}
