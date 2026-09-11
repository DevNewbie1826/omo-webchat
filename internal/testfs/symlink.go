// Package testfs creates platform-specific filesystem test fixtures.
package testfs

import (
	"errors"
	"os"
	"runtime"
	"syscall"
	"testing"
)

// Symlink skips only when Windows denies the required symlink privilege.
// Runners with Developer Mode or the privilege still exercise the assertion.
func Symlink(t *testing.T, target, link string) {
	t.Helper()
	if err := os.Symlink(target, link); err != nil {
		if runtime.GOOS == "windows" && errors.Is(err, syscall.Errno(1314)) {
			t.Skip("Windows symlink privilege is unavailable")
		}
		t.Fatal(err)
	}
}
