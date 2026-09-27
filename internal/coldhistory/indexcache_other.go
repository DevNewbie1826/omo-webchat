//go:build !unix

package coldhistory

import (
	"os"
	"time"
)

// Non-Unix files use a content digest instead of kernel change time.
func statIdentity(os.FileInfo) (device, inode uint64, changeTime time.Time) {
	return 0, 0, time.Time{}
}
