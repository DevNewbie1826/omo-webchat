//go:build unix

package coldhistory

import (
	"os"
	"syscall"
)

// statIdentity extracts the kernel file identity. A zero pair still leaves
// size and mtime to fence staleness.
func statIdentity(info os.FileInfo) (device, inode uint64) {
	if st, ok := info.Sys().(*syscall.Stat_t); ok {
		return uint64(st.Dev), uint64(st.Ino)
	}
	return 0, 0
}
