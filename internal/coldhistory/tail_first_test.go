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

func summarizePages(t *testing.T, pages []Page) string {
	t.Helper()
	parts := make([]string, 0, len(pages))
	for _, page := range pages {
		parts = append(parts, fmt.Sprintf("{ids=%v start=%d head=%v final=%v}", pageIDs(t, []Page{page}), page.Start, page.Head, page.Final))
	}
	return strings.Join(parts, " ")
}
