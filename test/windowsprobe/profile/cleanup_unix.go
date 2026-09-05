//go:build unix

package profile

import "os"

// RemoveAll preserves the Unix probe's existing cleanup behavior.
func RemoveAll(dir string) error { return os.RemoveAll(dir) }
