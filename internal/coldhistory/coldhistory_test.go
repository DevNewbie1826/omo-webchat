package coldhistory

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const testHeader = `{"type":"session","id":"session-1","version":3,"timestamp":"2026-09-02T00:00:00Z","cwd":"/tmp/work","parentSession":"parent-1"}`

func TestStreamActiveBranch(t *testing.T) {
	path := writeFixture(t, strings.Join([]string{
		"", testHeader,
		`{"type":"model_change","id":"root","parentId":null,"modelId":"m"}`,
		`{"type":"message","id":"left","parentId":"root","message":{"role":"user","content":"left"}}`,
		`{"type":"message","id":"abandoned","parentId":"root","message":{"role":"user","content":"branch"}}`,
		`{"type":"message","id":"leaf","parentId":"left","message":{"role":"assistant","content":"done"}}`,
		"",
	}, "\n"))

	var pages []Page
	metadata, err := Stream(context.Background(), path, Options{PageEntries: 2}, func(meta Metadata, page Page) error {
		if meta.LeafID != "leaf" || meta.Total != 3 {
			t.Fatalf("callback metadata = %+v, want leaf/3", meta)
		}
		pages = append(pages, page)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if metadata.Header.ID != "session-1" || metadata.Header.Version != 3 || metadata.Header.CWD != "/tmp/work" || metadata.Header.ParentSession != "parent-1" {
		t.Fatalf("header = %+v", metadata.Header)
	}
	if !json.Valid(metadata.Header.Raw) {
		t.Fatalf("raw header is invalid: %s", metadata.Header.Raw)
	}
	if len(pages) != 2 || pages[0].Start != 0 || pages[0].Final || pages[1].Start != 2 || !pages[1].Final {
		t.Fatalf("pages = %+v", pages)
	}
	if got := pageIDs(t, pages); fmt.Sprint(got) != "[root left leaf]" {
		t.Fatalf("entry IDs = %v, want [root left leaf]", got)
	}
}

func TestStreamFormatEdges(t *testing.T) {
	tests := []struct {
		name        string
		contents    string
		wantIDs     []string
		wantLeaf    string
		wantErr     error
		wantOnePage bool
	}{
		{
			name:     "torn final line is ignored",
			contents: testHeader + "\n" + `{"type":"message","id":"root","parentId":null}` + "\n" + `{"type":"message","id":"torn"`,
			wantIDs:  []string{"root"}, wantLeaf: "root",
		},
		{
			name:     "valid unterminated final line is retained",
			contents: testHeader + "\n" + `{"type":"message","id":"root","parentId":null}`,
			wantIDs:  []string{"root"}, wantLeaf: "root",
		},
		{
			name:     "interior corruption",
			contents: testHeader + "\n" + "{bad}\n" + `{"type":"message","id":"root","parentId":null}` + "\n",
			wantErr:  ErrCorruptLine,
		},
		{
			name:     "terminated final corruption is not a torn append",
			contents: testHeader + "\n{bad}\n",
			wantErr:  ErrCorruptLine,
		},
		{
			name: "cycle is capped at entry count",
			contents: testHeader + "\n" +
				`{"type":"message","id":"a","parentId":"b"}` + "\n" +
				`{"type":"message","id":"b","parentId":"a"}` + "\n",
			wantErr: ErrBranchCycle,
		},
		{
			name:     "empty file",
			contents: " \n\t\n",
			wantErr:  ErrEmpty,
		},
		{
			name:        "header only",
			contents:    "\n" + testHeader + "\n\n",
			wantOnePage: true,
		},
		{
			name: "missing active parent",
			contents: testHeader + "\n" +
				`{"type":"message","id":"leaf","parentId":"gone"}` + "\n",
			wantErr: ErrBrokenBranch,
		},
		{
			name: "duplicate id",
			contents: testHeader + "\n" +
				`{"type":"message","id":"same","parentId":null}` + "\n" +
				`{"type":"message","id":"same","parentId":null}` + "\n",
			wantErr: ErrDuplicateID,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			path := writeFixture(t, tt.contents)
			var pages []Page
			metadata, err := Stream(context.Background(), path, Options{}, func(_ Metadata, page Page) error {
				pages = append(pages, page)
				return nil
			})
			if !errors.Is(err, tt.wantErr) {
				t.Fatalf("error = %v, want errors.Is(_, %v)", err, tt.wantErr)
			}
			if tt.wantErr != nil {
				return
			}
			if metadata.LeafID != tt.wantLeaf || metadata.Total != len(tt.wantIDs) {
				t.Fatalf("metadata = %+v, want leaf %q total %d", metadata, tt.wantLeaf, len(tt.wantIDs))
			}
			if got := pageIDs(t, pages); fmt.Sprint(got) != fmt.Sprint(tt.wantIDs) {
				t.Fatalf("entry IDs = %v, want %v", got, tt.wantIDs)
			}
			if tt.wantOnePage && (len(pages) != 1 || len(pages[0].Entries) != 0 || !pages[0].Final) {
				t.Fatalf("header-only pages = %+v, want one empty final page", pages)
			}
		})
	}
}

func TestStreamCleanBoundaryErrors(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "missing.jsonl")
	_, err := Stream(context.Background(), missing, Options{}, func(Metadata, Page) error { return nil })
	if !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("missing-file error = %v, want os.ErrNotExist", err)
	}

	path := writeFixture(t, testHeader+"\n"+`{"type":"message","id":"root","parentId":null,"pad":"`+strings.Repeat("x", 200)+`"}`+"\n")
	_, err = Stream(context.Background(), path, Options{ChunkBytes: 32, MaxLineBytes: 128, PageBytes: 128}, func(Metadata, Page) error { return nil })
	if !errors.Is(err, ErrLineTooLong) {
		t.Fatalf("oversized-line error = %v, want ErrLineTooLong", err)
	}

	_, err = Stream(context.Background(), path, Options{MaxLineBytes: 1024, PageBytes: 512}, func(Metadata, Page) error { return nil })
	if !errors.Is(err, ErrInvalidOptions) {
		t.Fatalf("invalid-options error = %v, want ErrInvalidOptions", err)
	}
}

func TestStreamIndexBudget(t *testing.T) {
	tests := []struct {
		name       string
		entries    int
		idWidth    int
		indexBytes int64
		wantErr    bool
	}{
		{name: "many small entries exceed aggregate bound", entries: 512, idWidth: 6, indexBytes: 4 << 10, wantErr: true},
		{name: "coordinate bytes count toward bound", entries: 64, idWidth: 128, indexBytes: 8 << 10, wantErr: true},
		{name: "entries within aggregate bound stream", entries: 32, idWidth: 6, indexBytes: 1 << 20},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			path := writeEntryChain(t, tt.entries, tt.idWidth)
			emitted := 0
			metadata, err := Stream(context.Background(), path, Options{IndexBytes: tt.indexBytes}, func(_ Metadata, page Page) error {
				emitted += len(page.Entries)
				return nil
			})
			if !tt.wantErr {
				if err != nil {
					t.Fatal(err)
				}
				if metadata.Total != tt.entries || emitted != tt.entries {
					t.Fatalf("total/emitted = %d/%d, want %d/%d", metadata.Total, emitted, tt.entries, tt.entries)
				}
				return
			}

			if !errors.Is(err, ErrIndexBudgetExceeded) {
				t.Fatalf("error = %v, want ErrIndexBudgetExceeded", err)
			}
			var budgetErr *IndexBudgetError
			if !errors.As(err, &budgetErr) {
				t.Fatalf("error type = %T, want *IndexBudgetError", err)
			}
			if budgetErr.Limit != tt.indexBytes || budgetErr.Used > budgetErr.Limit || budgetErr.Required <= budgetErr.Limit {
				t.Fatalf("budget error = %+v", budgetErr)
			}
			if emitted != 0 {
				t.Fatalf("emitted %d entries before index failure, want 0", emitted)
			}
		})
	}
}

func TestStreamMultiMegabyteUsesBoundedReadsAndPages(t *testing.T) {
	const (
		entries  = 1536
		padBytes = 4096
		chunk    = 8 << 10
		pageMax  = 32 << 10
	)
	path := filepath.Join(t.TempDir(), "large.jsonl")
	out, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	writer := bufio.NewWriterSize(out, 64<<10)
	if _, err := fmt.Fprintln(writer, testHeader); err != nil {
		t.Fatal(err)
	}
	pad := strings.Repeat("x", padBytes)
	for i := 0; i < entries; i++ {
		parent := "null"
		if i > 0 {
			parent = fmt.Sprintf("%q", fmt.Sprintf("e-%04d", i-1))
		}
		if _, err := fmt.Fprintf(writer, `{"type":"message","id":"e-%04d","parentId":%s,"pad":"%s"}`+"\n", i, parent, pad); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Flush(); err != nil {
		t.Fatal(err)
	}
	if err := out.Close(); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Size() < 6<<20 {
		t.Fatalf("fixture size = %d, want at least 6 MiB", info.Size())
	}

	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	counted := &countingReadSeeker{ReadSeeker: file}
	opts, err := normalizeOptions(Options{ChunkBytes: chunk, MaxLineBytes: pageMax, PageBytes: pageMax, PageEntries: 50})
	if err != nil {
		t.Fatal(err)
	}
	seen := 0
	metadata, err := stream(context.Background(), counted, opts, func(meta Metadata, page Page) error {
		if meta.Total != entries {
			t.Fatalf("callback total = %d, want %d", meta.Total, entries)
		}
		pageBytes := 0
		for _, raw := range page.Entries {
			pageBytes += len(raw)
		}
		if pageBytes > pageMax {
			t.Fatalf("page bytes = %d, bound = %d", pageBytes, pageMax)
		}
		if len(page.Entries) > 50 {
			t.Fatalf("page entries = %d, bound = 50", len(page.Entries))
		}
		seen += len(page.Entries)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if metadata.LeafID != "e-1535" || metadata.Total != entries || seen != entries {
		t.Fatalf("metadata/seen = %+v/%d", metadata, seen)
	}
	if counted.maxRequest > chunk {
		t.Fatalf("largest Read buffer = %d, chunk bound = %d", counted.maxRequest, chunk)
	}
	if counted.calls < 100 {
		t.Fatalf("Read calls = %d, want incremental reads", counted.calls)
	}
	if counted.bytes <= info.Size() {
		t.Fatalf("bytes read = %d, file size = %d; expected bounded two-pass reads", counted.bytes, info.Size())
	}
}

type countingReadSeeker struct {
	io.ReadSeeker
	maxRequest int
	calls      int
	bytes      int64
}

func (r *countingReadSeeker) Read(p []byte) (int, error) {
	if len(p) > r.maxRequest {
		r.maxRequest = len(p)
	}
	r.calls++
	n, err := r.ReadSeeker.Read(p)
	r.bytes += int64(n)
	return n, err
}

func writeFixture(t *testing.T, contents string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "session.jsonl")
	if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func writeEntryChain(t *testing.T, entries, idWidth int) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "session.jsonl")
	out, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	writer := bufio.NewWriter(out)
	if _, err := fmt.Fprintln(writer, testHeader); err != nil {
		t.Fatal(err)
	}
	previous := ""
	for i := 0; i < entries; i++ {
		id := fmt.Sprintf("e-%0*d", idWidth-2, i)
		parent := "null"
		if previous != "" {
			parent = fmt.Sprintf("%q", previous)
		}
		if _, err := fmt.Fprintf(writer, `{"type":"message","id":%q,"parentId":%s}`+"\n", id, parent); err != nil {
			t.Fatal(err)
		}
		previous = id
	}
	if err := writer.Flush(); err != nil {
		t.Fatal(err)
	}
	if err := out.Close(); err != nil {
		t.Fatal(err)
	}
	return path
}

func pageIDs(t *testing.T, pages []Page) []string {
	t.Helper()
	var ids []string
	for _, page := range pages {
		for _, raw := range page.Entries {
			var entry struct {
				ID string `json:"id"`
			}
			if err := json.Unmarshal(raw, &entry); err != nil {
				t.Fatalf("decode entry %s: %v", raw, err)
			}
			ids = append(ids, entry.ID)
		}
	}
	return ids
}
