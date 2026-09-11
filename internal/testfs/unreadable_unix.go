//go:build !windows

package testfs

import (
	"os"
	"testing"
)

func MakeUnreadable(t *testing.T, path string) {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Chmod(path, info.Mode().Perm()); err != nil {
			t.Error(err)
		}
	})
	if err := os.Chmod(path, 0); err != nil {
		t.Fatal(err)
	}
}
