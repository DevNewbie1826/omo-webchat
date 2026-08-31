package api

import (
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func TestSearchFilesIn(t *testing.T) {
	root := t.TempDir()
	write := func(rel, content string) {
		full := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("session.go", "x")
	write("main.go", "x")
	write("sub/nested.go", "x")
	write("node_modules/ignored.go", "x")
	write("readme.md", "x")

	got := searchFilesIn(root, "session")
	if len(got) != 1 || got[0].Path != "session.go" {
		t.Fatalf("search session = %+v, want only session.go", got)
	}

	all := searchFilesIn(root, ".go")
	paths := make([]string, 0, len(all))
	for _, r := range all {
		paths = append(paths, r.Path)
		if r.Path == "node_modules/ignored.go" {
			t.Fatalf("ignored directory was not skipped: %v", paths)
		}
	}
	if len(paths) != 3 {
		t.Fatalf(".go results = %v, want 3 (main.go, session.go, sub/nested.go)", paths)
	}
}

func TestRecentFilesIncludesNewestBeyondResultLimit(t *testing.T) {
	root := t.TempDir()
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	writeAt := func(rel string, mtime time.Time) {
		full := filepath.Join(root, rel)
		if err := os.WriteFile(full, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(full, mtime, mtime); err != nil {
			t.Fatal(err)
		}
	}
	for i := range searchMaxResults {
		writeAt(fmt.Sprintf("a-%02d.go", i), base)
	}
	const newest = "z-newest.go"
	writeAt(newest, base.Add(time.Hour))

	got := recentFiles(root)
	if len(got) != searchMaxResults {
		t.Fatalf("len(recentFiles) = %d, want %d", len(got), searchMaxResults)
	}
	if got[0].Path != newest {
		t.Fatalf("recentFiles[0] = %q, want lexical-tail newest file %q; results = %+v", got[0].Path, newest, got)
	}
}

func TestRecentFilesNewestFirst(t *testing.T) {
	root := t.TempDir()
	write := func(rel string) {
		full := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("old.go")
	write("mid.go")
	write("new.go")
	write("node_modules/ignored.go")
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	setMtime := func(rel string, offset time.Duration) {
		if err := os.Chtimes(filepath.Join(root, rel), base.Add(offset), base.Add(offset)); err != nil {
			t.Fatal(err)
		}
	}
	setMtime("old.go", 0)
	setMtime("mid.go", time.Hour)
	setMtime("new.go", 2*time.Hour)

	got := recentFiles(root)
	names := make([]string, 0, len(got))
	for _, r := range got {
		names = append(names, r.Name)
		if r.Name == "ignored.go" {
			t.Fatalf("ignored directory was not skipped: %v", names)
		}
	}
	want := []string{"new.go", "mid.go", "old.go"}
	if !reflect.DeepEqual(names, want) {
		t.Fatalf("recentFiles order = %v, want %v", names, want)
	}
}
