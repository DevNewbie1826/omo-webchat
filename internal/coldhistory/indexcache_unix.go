//go:build unix && !darwin && !linux

package coldhistory

import (
	"os"
	"syscall"
	"time"
)

// Platforms without a portable change-time field use a content digest.
func statIdentity(info os.FileInfo) (device, inode uint64, changeTime time.Time) {
	if st, ok := info.Sys().(*syscall.Stat_t); ok {
		return uint64(st.Dev), uint64(st.Ino), time.Time{}
	}
	return 0, 0, time.Time{}
}
