package adoptcopy

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

const header = `{"type":"session","id":"durable-session-1","version":3,"timestamp":"2026-09-02T00:00:00Z","cwd":"/tmp/work"}`

func TestAdoptPublishesVerifiedCopyAndIsIdempotent(t *testing.T) {
	source := writeSession(t, header+"\n"+`{"type":"message","id":"root","parentId":null,"text":"hello"}`+"\n")
	destination := filepath.Join(t.TempDir(), "adopted")
	original, err := os.ReadFile(source)
	if err != nil {
		t.Fatal(err)
	}

	first, err := Adopt(context.Background(), source, destination)
	if err != nil {
		t.Fatal(err)
	}
	if !first.Created || first.SessionID != "durable-session-1" {
		t.Fatalf("first result = %+v", first)
	}
	if first.Path != filepath.Join(destination, DestinationName(first.SessionID)) {
		t.Fatalf("path = %q", first.Path)
	}
	published, err := os.ReadFile(first.Path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(published, original) {
		t.Fatal("published bytes differ from source")
	}
	if first.SHA256 != sha256.Sum256(original) {
		t.Fatalf("hash = %x", first.SHA256)
	}

	second, err := Adopt(context.Background(), source, destination)
	if err != nil {
		t.Fatal(err)
	}
	if second.Created || second.Path != first.Path || second.SHA256 != first.SHA256 {
		t.Fatalf("second result = %+v, first = %+v", second, first)
	}
	assertOnlyPublishedFile(t, destination, first.Path)
}

func TestAdoptToleratesTornFinalLine(t *testing.T) {
	contents := header + "\n" +
		`{"type":"message","id":"root","parentId":null}` + "\n" +
		`{"type":"message","id":"torn"`
	source := writeSession(t, contents)

	result, err := Adopt(context.Background(), source, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(result.Path)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != contents {
		t.Fatalf("published copy = %q, want exact torn source", got)
	}
}

func TestAdoptRejectsOversizedSource(t *testing.T) {
	source := writeSession(t, header+"\n")
	if err := os.Truncate(source, MaxSourceBytes+1); err != nil {
		t.Fatal(err)
	}
	destination := t.TempDir()

	_, err := Adopt(context.Background(), source, destination)
	assertTypedError(t, err, KindTooLarge, ErrTooLarge)
	var adoptionErr *Error
	if !errors.As(err, &adoptionErr) || adoptionErr.Size != MaxSourceBytes+1 || adoptionErr.Limit != MaxSourceBytes {
		t.Fatalf("size error = %+v", adoptionErr)
	}
	assertDirectoryEmpty(t, destination)
}

func TestAdoptRejectsMutationDuringCopyWithoutPublishing(t *testing.T) {
	padding := strings.Repeat("a", 192<<10)
	source := writeSession(t, header+"\n"+
		fmt.Sprintf(`{"type":"message","id":"root","parentId":null,"padding":%q}`, padding)+"\n")
	destination := t.TempDir()
	chunkCopied := make(chan struct{})
	resumeCopy := make(chan struct{})
	var once sync.Once
	hooks := copyHooks{afterChunk: func(int64) {
		once.Do(func() {
			close(chunkCopied)
			<-resumeCopy
		})
	}}

	type outcome struct {
		result Result
		err    error
	}
	done := make(chan outcome, 1)
	go func() {
		result, err := adopt(context.Background(), source, destination, hooks)
		done <- outcome{result: result, err: err}
	}()

	<-chunkCopied
	file, err := os.OpenFile(source, os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	// Change bytes already copied while preserving a valid JSONL graph and size.
	if _, err := file.WriteAt([]byte("b"), int64(len(header)+1+64)); err != nil {
		file.Close()
		t.Fatal(err)
	}
	if err := file.Sync(); err != nil {
		file.Close()
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	close(resumeCopy)

	out := <-done
	assertTypedError(t, out.err, KindHashMismatch, ErrHashMismatch)
	if _, err := os.Stat(filepath.Join(destination, DestinationName("durable-session-1"))); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("published path stat error = %v, want not exist", err)
	}
	assertDirectoryEmpty(t, destination)
}

func TestConcurrentAdoptionsConverge(t *testing.T) {
	source := writeSession(t, header+"\n"+`{"type":"message","id":"root","parentId":null}`+"\n")
	destination := t.TempDir()
	const workers = 12
	start := make(chan struct{})
	results := make(chan struct {
		result Result
		err    error
	}, workers)

	for i := 0; i < workers; i++ {
		go func() {
			<-start
			result, err := Adopt(context.Background(), source, destination)
			results <- struct {
				result Result
				err    error
			}{result, err}
		}()
	}
	close(start)

	created := 0
	var path string
	for i := 0; i < workers; i++ {
		out := <-results
		if out.err != nil {
			t.Fatal(out.err)
		}
		if path == "" {
			path = out.result.Path
		}
		if out.result.Path != path {
			t.Fatalf("paths differ: %q and %q", path, out.result.Path)
		}
		if out.result.Created {
			created++
		}
	}
	if created != 1 {
		t.Fatalf("created results = %d, want 1", created)
	}
	assertOnlyPublishedFile(t, destination, path)
}

func TestAdoptRejectsDifferentSourceDestinationCollision(t *testing.T) {
	firstSource := writeNamedSession(t, "first.jsonl", header+"\n"+`{"type":"message","id":"root","parentId":null,"text":"first"}`+"\n")
	secondSource := writeNamedSession(t, "second.jsonl", header+"\n"+`{"type":"message","id":"root","parentId":null,"text":"second"}`+"\n")
	destination := t.TempDir()

	first, err := Adopt(context.Background(), firstSource, destination)
	if err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(first.Path)
	if err != nil {
		t.Fatal(err)
	}
	_, err = Adopt(context.Background(), secondSource, destination)
	assertTypedError(t, err, KindCollision, ErrCollision)
	after, err := os.ReadFile(first.Path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(after, before) {
		t.Fatal("collision changed existing destination")
	}
	assertOnlyPublishedFile(t, destination, first.Path)
}

func TestAdoptRequiresRegularValidVersionedSession(t *testing.T) {
	tests := []struct {
		name string
		path func(*testing.T) string
	}{
		{name: "directory", path: func(t *testing.T) string { return t.TempDir() }},
		{name: "missing id", path: func(t *testing.T) string { return writeSession(t, `{"type":"session","version":3}`+"\n") }},
		{name: "missing version", path: func(t *testing.T) string { return writeSession(t, `{"type":"session","id":"id"}`+"\n") }},
		{name: "broken tree", path: func(t *testing.T) string {
			return writeSession(t, header+"\n"+`{"type":"message","id":"leaf","parentId":"missing"}`+"\n")
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			destination := t.TempDir()
			_, err := Adopt(context.Background(), tt.path(t), destination)
			assertTypedError(t, err, KindInvalidSource, ErrInvalidSource)
			assertDirectoryEmpty(t, destination)
		})
	}
}

func assertTypedError(t *testing.T, err error, kind Kind, sentinel error) {
	t.Helper()
	if !errors.Is(err, sentinel) {
		t.Fatalf("error = %v, want errors.Is(_, %v)", err, sentinel)
	}
	var adoptionErr *Error
	if !errors.As(err, &adoptionErr) {
		t.Fatalf("error type = %T, want *Error", err)
	}
	if adoptionErr.Kind != kind {
		t.Fatalf("error kind = %q, want %q", adoptionErr.Kind, kind)
	}
}

func writeSession(t *testing.T, contents string) string {
	t.Helper()
	return writeNamedSession(t, "session.jsonl", contents)
}

func writeNamedSession(t *testing.T, name, contents string) string {
	t.Helper()
	directory := t.TempDir()
	path := filepath.Join(directory, name)
	if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func assertDirectoryEmpty(t *testing.T, path string) {
	t.Helper()
	entries, err := os.ReadDir(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("directory contains %v, want empty", entries)
	}
}

func assertOnlyPublishedFile(t *testing.T, directory, publishedPath string) {
	t.Helper()
	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || filepath.Join(directory, entries[0].Name()) != publishedPath {
		t.Fatalf("directory entries = %v, want only %q", entries, publishedPath)
	}
}
