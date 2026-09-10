package api

import (
	"fmt"
	"net/url"
	"path/filepath"
	"testing"
)

// Every next_cursor this endpoint emits must resume on this same endpoint.
// The store accepts runs whose updated_at is missing or unparseable and
// ranks them as the oldest entries, so a page boundary can land on one. The
// emitted cursor must therefore carry a clock key the endpoint's own
// validation accepts and that reproduces the boundary entry's exact position
// under the catalog comparator (updated_at DESC, run_id DESC tiebreak),
// while the emitted catalog entries keep the source's original raw clocks.

// writeDagClockRun stores an owned run with updatedAt set to clock, or with
// updatedAt absent from the source entirely when clock is empty.
func writeDagClockRun(t *testing.T, f dagHTTPFixture, id, clock string) {
	t.Helper()
	run := dagFixtureRun(id, 1, 1)
	if clock == "" {
		delete(run, "updatedAt")
	} else {
		run["updatedAt"] = clock
	}
	writeDagFixture(t, filepath.Join(f.dir, "run-"+id+".json"), run)
}

func TestChatDagRunCatalogEmitsResumableCursors(t *testing.T) {
	t.Run("unparseableClockAtTenEntryBoundary", func(t *testing.T) {
		f := newDagHTTPFixture(t)
		// Nine valid-clock runs newest first, then the accepted
		// malformed-clock runs the comparator ranks oldest (run_id DESC
		// among equal oldest clocks: z-bad before a-bad). limit=10 lands
		// the page boundary exactly on z-bad, whose raw clock is not an
		// RFC3339 instant.
		for i := range 9 {
			writeDagClockRun(t, f, fmt.Sprintf("ok-%02d", i), fmt.Sprintf("2026-09-04T%02d:00:00Z", 9-i))
		}
		writeDagClockRun(t, f, "z-bad", "not-a-timestamp")
		writeDagClockRun(t, f, "a-bad", "not-a-timestamp")
		first := fetchDagCatalog(t, f, "?limit=10")
		assertDagRunIDs(t, dagCatalogPageIDs(t, first), []string{"ok-00", "ok-01", "ok-02", "ok-03", "ok-04", "ok-05", "ok-06", "ok-07", "ok-08", "z-bad"})
		// Original metadata is retained: the boundary entry echoes the
		// source's raw malformed clock rather than a sanitized one.
		if last := first.Runs[len(first.Runs)-1]; last.UpdatedAt != "not-a-timestamp" {
			t.Fatalf("boundary entry updated_at=%q want the source's raw clock", last.UpdatedAt)
		}
		if first.NextCursor == nil || *first.NextCursor == "" {
			t.Fatal("missing next cursor at the ten-entry boundary")
		}
		second := fetchDagCatalog(t, f, "?limit=10&cursor="+url.QueryEscape(*first.NextCursor))
		assertDagRunIDs(t, dagCatalogPageIDs(t, second), []string{"a-bad"})
		if second.NextCursor != nil {
			t.Fatal("unexpected next cursor after the final run")
		}
	})
	t.Run("missingClockAtTenEntryBoundary", func(t *testing.T) {
		f := newDagHTTPFixture(t)
		for i := range 9 {
			writeDagClockRun(t, f, fmt.Sprintf("ok-%02d", i), fmt.Sprintf("2026-09-04T%02d:00:00Z", 9-i))
		}
		writeDagClockRun(t, f, "z-none", "")
		writeDagClockRun(t, f, "a-none", "")
		first := fetchDagCatalog(t, f, "?limit=10")
		assertDagRunIDs(t, dagCatalogPageIDs(t, first), []string{"ok-00", "ok-01", "ok-02", "ok-03", "ok-04", "ok-05", "ok-06", "ok-07", "ok-08", "z-none"})
		if first.NextCursor == nil || *first.NextCursor == "" {
			t.Fatal("missing next cursor at the ten-entry boundary")
		}
		second := fetchDagCatalog(t, f, "?limit=10&cursor="+url.QueryEscape(*first.NextCursor))
		assertDagRunIDs(t, dagCatalogPageIDs(t, second), []string{"a-none"})
		if second.NextCursor != nil {
			t.Fatal("unexpected next cursor after the final run")
		}
	})
	t.Run("walkCrossesMixedMalformedClockCluster", func(t *testing.T) {
		f := newDagHTTPFixture(t)
		// Eight valid-clock runs, then an oldest cluster mixing absent and
		// unparseable clocks; the comparator orders that cluster by run_id
		// DESC: z-bad, y-none, x-bad, a-none. Page boundaries land on an
		// absent clock and then on an unparseable clock, and the walk must
		// still concatenate the full order without gaps or duplicates.
		for i := range 8 {
			writeDagClockRun(t, f, fmt.Sprintf("ok-%02d", i), fmt.Sprintf("2026-09-04T%02d:00:00Z", 8-i))
		}
		writeDagClockRun(t, f, "z-bad", "not-a-timestamp")
		writeDagClockRun(t, f, "y-none", "")
		writeDagClockRun(t, f, "x-bad", "also not a timestamp")
		writeDagClockRun(t, f, "a-none", "")
		var got []string
		seen := map[string]bool{}
		limit, cursor := 10, ""
		for page := 0; ; page++ {
			suffix := fmt.Sprintf("?limit=%d", limit)
			if cursor != "" {
				suffix += "&cursor=" + url.QueryEscape(cursor)
			}
			body := fetchDagCatalog(t, f, suffix)
			for _, run := range body.Runs {
				if seen[run.RunID] {
					t.Fatalf("duplicate run %q across pages", run.RunID)
				}
				seen[run.RunID] = true
				got = append(got, run.RunID)
			}
			if body.NextCursor == nil {
				break
			}
			if *body.NextCursor == "" || *body.NextCursor == cursor {
				t.Fatalf("page %d nonprogressing cursor", page)
			}
			cursor = *body.NextCursor
			// The second page stops inside the malformed cluster so the
			// walk must resume across it twice.
			limit = 1
		}
		assertDagRunIDs(t, got, []string{"ok-00", "ok-01", "ok-02", "ok-03", "ok-04", "ok-05", "ok-06", "ok-07", "z-bad", "y-none", "x-bad", "a-none"})
	})
}
