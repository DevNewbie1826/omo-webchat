package coldhistory

import (
	"context"
	"fmt"
	"strings"
	"testing"
)

func TestStreamTailFirst(t *testing.T) {
	type wantPage struct {
		ids   []string
		start int
		head  bool
		final bool
	}
	tests := []struct {
		name     string
		entries  int
		header   bool
		tail     int
		warm     int
		wantLeaf string
		want     []wantPage
	}{
		{
			name:     "branch shorter than tail budget",
			entries:  2,
			tail:     3,
			warm:     2,
			wantLeaf: "e-1",
			want: []wantPage{
				{ids: []string{"e-0", "e-1"}, start: 0, final: true},
			},
		},
		{
			name:     "branch exactly tail budget",
			entries:  3,
			tail:     3,
			warm:     2,
			wantLeaf: "e-2",
			want: []wantPage{
				{ids: []string{"e-0", "e-1", "e-2"}, start: 0, final: true},
			},
		},
		{
			name:     "branch one past tail budget",
			entries:  4,
			tail:     3,
			warm:     2,
			wantLeaf: "e-3",
			want: []wantPage{
				{ids: []string{"e-1", "e-2", "e-3"}, start: 1},
				{ids: []string{"e-0"}, start: 0, head: true, final: true},
			},
		},
		{
			name:     "several warm chunks",
			entries:  8,
			tail:     3,
			warm:     2,
			wantLeaf: "e-7",
			want: []wantPage{
				{ids: []string{"e-5", "e-6", "e-7"}, start: 5},
				{ids: []string{"e-3", "e-4"}, start: 3, head: true},
				{ids: []string{"e-1", "e-2"}, start: 1, head: true},
				{ids: []string{"e-0"}, start: 0, head: true, final: true},
			},
		},
		{
			name:   "header only",
			header: true,
			tail:   3,
			warm:   2,
			want:   []wantPage{{start: 0, final: true}},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var path string
			if tt.header {
				path = writeFixture(t, testHeader+"\n")
			} else {
				path = writeLinearBranch(t, tt.entries)
			}

			var pages []Page
			metadata, err := StreamTailFirst(context.Background(), path, Options{}, tt.tail, tt.warm, func(meta Metadata, page Page) error {
				if meta.LeafID != tt.wantLeaf || meta.Total != tt.entries {
					t.Fatalf("callback metadata = %+v, want leaf %q total %d", meta, tt.wantLeaf, tt.entries)
				}
				pages = append(pages, page)
				return nil
			})
			if err != nil {
				t.Fatal(err)
			}
			if metadata.LeafID != tt.wantLeaf || metadata.Total != tt.entries {
				t.Fatalf("metadata = %+v, want leaf %q total %d", metadata, tt.wantLeaf, tt.entries)
			}
			if len(pages) != len(tt.want) {
				t.Fatalf("got %d pages %+v, want %d", len(pages), summarizePages(t, pages), len(tt.want))
			}
			for i, got := range pages {
				want := tt.want[i]
				ids := pageIDs(t, []Page{got})
				if fmt.Sprint(ids) != fmt.Sprint(want.ids) {
					t.Fatalf("page %d ids = %v, want %v", i, ids, want.ids)
				}
				if got.Start != want.start || got.Head != want.head || got.Final != want.final {
					t.Fatalf("page %d start/head/final = %d/%v/%v, want %d/%v/%v", i, got.Start, got.Head, got.Final, want.start, want.head, want.final)
				}
				if want.ids == nil && len(got.Entries) != 0 {
					t.Fatalf("page %d entries = %d, want empty", i, len(got.Entries))
				}
			}
		})
	}
}

func writeLinearBranch(t *testing.T, entries int) string {
	t.Helper()
	lines := []string{testHeader}
	for i := 0; i < entries; i++ {
		parent := "null"
		if i > 0 {
			parent = fmt.Sprintf("%q", fmt.Sprintf("e-%d", i-1))
		}
		lines = append(lines, fmt.Sprintf(`{"type":"message","id":"e-%d","parentId":%s}`, i, parent))
	}
	return writeFixture(t, strings.Join(lines, "\n")+"\n")
}

func paddedEntryLine(i, pad int) string {
	parent := "null"
	if i > 0 {
		parent = fmt.Sprintf("%q", fmt.Sprintf("e-%d", i-1))
	}
	return fmt.Sprintf(`{"type":"message","id":"e-%d","parentId":%s,"pad":"%s"}`, i, parent, strings.Repeat("x", pad))
}

func writePaddedLinearBranch(t *testing.T, entries, pad int) string {
	t.Helper()
	lines := []string{testHeader}
	for i := 0; i < entries; i++ {
		lines = append(lines, paddedEntryLine(i, pad))
	}
	return writeFixture(t, strings.Join(lines, "\n")+"\n")
}

// TestStreamTailFirstEmitsSplitHeadRangesNewestFirst pins the reader's own
// page boundary: when the byte or count bound splits one backward warm range
// into several pages, those pages must arrive newest-first, so a consumer
// that prepends each page rebuilds the range in order, and the page that
// reaches the branch root is the final one. A 7-entry branch with a 3-entry
// tail leaves the single warm range [e-0..e-3]; each subtest splits that one
// range across two pages by a different bound.
func TestStreamTailFirstEmitsSplitHeadRangesNewestFirst(t *testing.T) {
	const (
		entries = 7
		tail    = 3
		warm    = 4
		pad     = 100
	)
	want := []struct {
		ids   []string
		start int
		head  bool
		final bool
	}{
		{ids: []string{"e-4", "e-5"}, start: 4},
		{ids: []string{"e-6"}, start: 6},
		{ids: []string{"e-2", "e-3"}, start: 2, head: true},
		{ids: []string{"e-0", "e-1"}, start: 0, head: true, final: true},
	}
	// Two padded entries fit one page, three never do.
	twoEntries := 2 * len(paddedEntryLine(1, pad))
	splitByBytes := Options{MaxLineBytes: twoEntries + 10, PageBytes: twoEntries + 10, PageEntries: 10}
	splitByCount := Options{PageEntries: 2}

	for _, tc := range []struct {
		name string
		opts Options
	}{
		{name: "byte bound splits one warm range", opts: splitByBytes},
		{name: "count bound splits one warm range", opts: splitByCount},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path := writePaddedLinearBranch(t, entries, pad)
			var pages []Page
			metadata, err := StreamTailFirst(context.Background(), path, tc.opts, tail, warm, func(_ Metadata, page Page) error {
				pages = append(pages, page)
				return nil
			})
			if err != nil {
				t.Fatal(err)
			}
			if metadata.LeafID != "e-6" || metadata.Total != entries {
				t.Fatalf("metadata = %+v, want leaf e-6 total %d", metadata, entries)
			}
			if len(pages) != len(want) {
				t.Fatalf("got %d pages %s, want %d (the warm range must split)", len(pages), summarizePages(t, pages), len(want))
			}
			for i, got := range pages {
				ids := pageIDs(t, []Page{got})
				if fmt.Sprint(ids) != fmt.Sprint(want[i].ids) {
					t.Fatalf("page %d ids = %v, want %v (pages must arrive newest-first)", i, ids, want[i].ids)
				}
				if got.Start != want[i].start || got.Head != want[i].head || got.Final != want[i].final {
					t.Fatalf("page %d start/head/final = %d/%v/%v, want %d/%v/%v", i, got.Start, got.Head, got.Final, want[i].start, want[i].head, want[i].final)
				}
			}
			// Successive head pages must be strictly older: the last entry of
			// each page directly precedes the first entry of the page before it.
			var headIDs [][]string
			for _, page := range pages {
				if page.Head {
					headIDs = append(headIDs, pageIDs(t, []Page{page}))
				}
			}
			for k := 1; k < len(headIDs); k++ {
				older, newer := headIDs[k], headIDs[k-1]
				if branchIDIndex(t, older[len(older)-1])+1 != branchIDIndex(t, newer[0]) {
					t.Fatalf("head pages %d and %d are not adjacent newest-first: %v then %v", k-1, k, newer, older)
				}
			}
		})
	}
}

func branchIDIndex(t *testing.T, id string) int {
	t.Helper()
	var n int
	if _, err := fmt.Sscanf(id, "e-%d", &n); err != nil {
		t.Fatalf("entry id %q has no index", id)
	}
	return n
}

func summarizePages(t *testing.T, pages []Page) string {
	t.Helper()
	parts := make([]string, 0, len(pages))
	for _, page := range pages {
		parts = append(parts, fmt.Sprintf("{ids=%v start=%d head=%v final=%v}", pageIDs(t, []Page{page}), page.Start, page.Head, page.Final))
	}
	return strings.Join(parts, " ")
}
