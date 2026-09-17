package coldhistory

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
)

func TestResumeSkipsCoveredRangeWithBoundedPages(t *testing.T) {
	path := writeLinearBranch(t, 430)
	var header struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal([]byte(testHeader), &header); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name     string
		cursor   ResumeCursor
		want     int
		accepted bool
	}{
		{"partial growth", ResumeCursor{header.ID, "e-140", "e-299", false}, 270, true},
		{"complete unchanged", ResumeCursor{header.ID, "e-0", "e-429", true}, 0, true},
		{"wrong identity", ResumeCursor{"another", "e-0", "e-429", true}, 430, false},
		{"missing tip", ResumeCursor{header.ID, "e-140", "unknown", false}, 430, false},
		{"reversed anchors", ResumeCursor{header.ID, "e-299", "e-140", false}, 430, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			seen := map[string]bool{}
			finals := 0
			_, err := StreamTailFirst(context.Background(), path, Options{Resume: &tc.cursor, PageEntries: 7}, 60, 100, func(meta Metadata, page Page) error {
				if (meta.Resume != nil) != tc.accepted {
					t.Fatalf("accepted = %v", meta.Resume)
				}
				if len(page.Entries) > 7 {
					t.Fatalf("unbounded page: %d", len(page.Entries))
				}
				if page.Final {
					finals++
				}
				for _, id := range pageIDs(t, []Page{page}) {
					if seen[id] {
						t.Fatalf("duplicate %s", id)
					}
					seen[id] = true
				}
				return nil
			})
			if err != nil {
				t.Fatal(err)
			}
			if len(seen) != tc.want || finals != 1 {
				t.Fatalf("entries=%d finals=%d", len(seen), finals)
			}
			if tc.name == "partial growth" {
				for i := 140; i < 300; i++ {
					if seen[fmt.Sprintf("e-%d", i)] {
						t.Fatalf("covered index %d", i)
					}
				}
			}
		})
	}
}
