package coldhistory

import (
	"os"
	"syscall"
	"time"
)

func statIdentity(info os.FileInfo) (device, inode uint64, changeTime time.Time) {
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, 0, time.Time{}
	}
	return uint64(st.Dev), uint64(st.Ino), time.Unix(st.Ctim.Sec, st.Ctim.Nsec)
}
