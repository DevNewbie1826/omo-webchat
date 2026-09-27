//go:build !unix

package coldhistory

import "os"

// statIdentity has no portable kernel identity off unix; size and mtime
// still fence staleness.
func statIdentity(os.FileInfo) (device, inode uint64) { return 0, 0 }
