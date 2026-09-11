package fileid

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLstatRetainsIdentityAfterSameMetadataReplacement(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	if err := os.WriteFile(path, []byte("old"), 0600); err != nil {
		t.Fatal(err)
	}
	before, err := Lstat(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(path, path+".old"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("new"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(path, before.ModTime(), before.ModTime()); err != nil {
		t.Fatal(err)
	}
	after, err := Lstat(path)
	if err != nil {
		t.Fatal(err)
	}
	if before.Size() != after.Size() || !before.ModTime().Equal(after.ModTime()) {
		t.Fatal("metadata fixture differs")
	}
	if os.SameFile(before, after) {
		t.Fatal("replacement identity was resolved lazily through the old path")
	}
	again, err := Lstat(path)
	if err != nil || !os.SameFile(after, again) {
		t.Fatalf("unchanged identity error=%v", err)
	}
}
