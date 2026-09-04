package session

import (
	"errors"
	"os"
	"syscall"
)

// isAbsentPathError reports a missing path (ENOENT / os.ErrNotExist) or a
// non-directory path prefix (ENOTDIR from lstat(2)/open(2)). syscall.ENOTDIR
// is also defined on Windows as ERROR_PATH_NOT_FOUND.
func isAbsentPathError(err error) bool {
	return errors.Is(err, os.ErrNotExist) || errors.Is(err, syscall.ENOTDIR)
}
