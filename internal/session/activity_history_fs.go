package session

import (
	"os"

	"github.com/DevNewbie1826/omo-webchat/internal/fileid"
	"github.com/DevNewbie1826/omo-webchat/internal/fileio"
)

// activityHistoryFS retains legacy path behavior, while external project state
// uses a pinned root for every directory and record operation. A missing store
// still flows through the existing empty-snapshot projection.
type activityHistoryFS struct {
	root   *os.Root
	absent bool
}

func (fs activityHistoryFS) lstat(path string) (os.FileInfo, error) {
	if fs.absent {
		return nil, os.ErrNotExist
	}
	if fs.root != nil {
		return fs.root.Lstat(path)
	}
	return fileid.Lstat(path)
}

func (fs activityHistoryFS) open(path string) (*os.File, error) {
	if fs.absent {
		return nil, os.ErrNotExist
	}
	if fs.root != nil {
		return fileio.OpenRoot(fs.root, path)
	}
	return fileio.Open(path)
}

// Directory enumeration does not need record delete-sharing on Windows.
func (fs activityHistoryFS) openDir(path string) (*os.File, error) {
	if fs.absent {
		return nil, os.ErrNotExist
	}
	if fs.root != nil {
		return fs.root.Open(path)
	}
	return os.Open(path)
}
