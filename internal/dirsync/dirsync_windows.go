// Package dirsync flushes directory entries so a completed rename survives a crash.
package dirsync

import "os"

// Handle is a no-op on Windows. FlushFileBuffers rejects directory handles with
// ERROR_ACCESS_DENIED, and os.Rename already commits a replacement through
// MoveFileEx, so there is no directory entry left to flush.
func Handle(*os.File) error {
	return nil
}
