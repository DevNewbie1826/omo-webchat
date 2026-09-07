//go:build !windows

// Package dirsync flushes directory entries so a completed rename survives a crash.
package dirsync

import "os"

// Handle fsyncs an open directory handle.
func Handle(dir *os.File) error {
	return dir.Sync()
}
