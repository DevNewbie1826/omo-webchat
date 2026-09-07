package dirsync

import (
	"os"
	"testing"
)

// TestHandleSucceedsOnDirectory pins the cross-platform contract: flushing a
// directory handle after an atomic rename must not fail. On Windows a real
// FlushFileBuffers call would report ERROR_ACCESS_DENIED, which previously
// turned every state write into a persistence error.
func TestHandleSucceedsOnDirectory(t *testing.T) {
	dir := t.TempDir()
	d, err := os.Open(dir)
	if err != nil {
		t.Fatalf("open temp dir: %v", err)
	}
	defer d.Close()

	if err := Handle(d); err != nil {
		t.Fatalf("Handle(%s) = %v, want nil", dir, err)
	}
}
