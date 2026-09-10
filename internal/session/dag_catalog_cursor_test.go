package session

import (
	"testing"
	"time"
)

// DagCatalogCursorClock contract: the cursor-encoding clock key compares
// identically to the original clock under DagCatalogLess for every accepted
// source value, and is always either empty or a parseable RFC3339 instant -
// exactly the values the paginated endpoint's cursor validation accepts - so
// every cursor that endpoint emits is resumable by it, including pages
// bounded by runs with missing or unparseable clocks.

func TestDagCatalogCursorClockEncodesComparatorKey(t *testing.T) {
	clocks := []string{
		"2026-09-04T09:00:00Z",
		"2026-09-03T13:00:00+09:00",
		"2026-09-03T11:01:00.987654321+09:00",
		"0001-01-01T00:00:00Z",
		"",
		"not-a-timestamp",
		"2026-13-99T99:99:99Z",
		" 2026-09-04T09:00:00Z ",
	}
	comparators := []DagCatalogEntry{
		{RunID: "cmp-newer", UpdatedAt: "2026-09-05T00:00:00Z"},
		{RunID: "cmp-equal-instant", UpdatedAt: "2026-09-04T18:00:00+09:00"},
		{RunID: "cmp-equal-raw", UpdatedAt: "2026-09-04T09:00:00Z"},
		{RunID: "cmp-oldest-parseable", UpdatedAt: "0001-01-01T00:00:00Z"},
		{RunID: "cmp-missing", UpdatedAt: ""},
		{RunID: "cmp-garbage", UpdatedAt: "garbage"},
		{RunID: "zz-tie", UpdatedAt: "2026-09-04T09:00:00Z"},
		{RunID: "aa-tie", UpdatedAt: "2026-09-04T09:00:00Z"},
	}
	for _, runID := range []string{"key-a", "key-z"} {
		for _, clock := range clocks {
			encoded := DagCatalogCursorClock(clock)
			if encoded != "" {
				if _, err := time.Parse(time.RFC3339, encoded); err != nil {
					t.Fatalf("clock %q encoded %q: neither empty nor a parseable RFC3339 instant", clock, encoded)
				}
			}
			original := DagCatalogEntry{RunID: runID, UpdatedAt: clock}
			normalized := DagCatalogEntry{RunID: runID, UpdatedAt: encoded}
			for _, other := range comparators {
				if DagCatalogLess(original, other) != DagCatalogLess(normalized, other) || DagCatalogLess(other, original) != DagCatalogLess(other, normalized) {
					t.Fatalf("clock %q encoded %q compares differently from the original against %+v", clock, encoded, other)
				}
			}
		}
	}
}
