package fileio

import (
	"io"
	"os"
	"path/filepath"
	"testing"
)

func TestOpenSnapshotPermitsRename(t *testing.T) {
	for _, confined := range []bool{false, true} {
		name := "path"
		if confined {
			name = "root"
		}
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			path := filepath.Join(dir, "history.jsonl")
			if err := os.WriteFile(path, []byte("original"), 0600); err != nil {
				t.Fatal(err)
			}
			var f *os.File
			var err error
			if confined {
				root, openErr := os.OpenRoot(dir)
				if openErr != nil {
					t.Fatal(openErr)
				}
				defer root.Close()
				f, err = OpenRoot(root, "history.jsonl")
			} else {
				f, err = Open(path)
			}
			if err != nil {
				t.Fatal(err)
			}
			defer f.Close()
			if err := os.Rename(path, path+".old"); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path, []byte("replacement"), 0600); err != nil {
				t.Fatal(err)
			}
			got, err := io.ReadAll(f)
			if err != nil || string(got) != "original" {
				t.Fatalf("snapshot=%q error=%v", got, err)
			}
		})
	}
}

func TestOpenRootRejectsEscape(t *testing.T) {
	root, err := os.OpenRoot(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	if f, err := OpenRoot(root, "../outside"); err == nil {
		f.Close()
		t.Fatal("root escape accepted")
	}
}
