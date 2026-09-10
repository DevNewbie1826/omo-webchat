package api

import (
	"encoding/json"
	"fmt"
	"net/url"
	"path/filepath"
	"testing"
	"time"
)

// Router-level catalog contract: runs are ordered updated_at DESC (parsed
// RFC3339 instants, never raw strings or run IDs) with a deterministic
// run_id DESC tiebreak, and the next_cursor is a value-encoded keyset over
// that same total order, so consecutive pages concatenate to the full order
// with no gaps and no duplicates.

func writeTimestampedDagRun(t *testing.T, f dagHTTPFixture, id, updatedAt string) {
	t.Helper()
	run := dagFixtureRun(id, 1, 1)
	run["updatedAt"] = updatedAt
	writeDagFixture(t, filepath.Join(f.dir, "run-"+id+".json"), run)
}

func fetchDagCatalog(t *testing.T, f dagHTTPFixture, suffix string) dagCatalogBody {
	t.Helper()
	rec := f.get(t, suffix)
	if rec.Code != 200 {
		t.Fatalf("catalog status=%d body=%s", rec.Code, rec.Body.String())
	}
	var body dagCatalogBody
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	return body
}

func dagCatalogPageIDs(t *testing.T, body dagCatalogBody) []string {
	t.Helper()
	ids := make([]string, len(body.Runs))
	for i, run := range body.Runs {
		ids[i] = run.RunID
	}
	return ids
}

func assertDagRunIDs(t *testing.T, got, want []string) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("got %v want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("position %d: got %v want %v", i, got, want)
		}
	}
}

func TestChatDagRunCatalogNewestFirst(t *testing.T) {
	f := newDagHTTPFixture(t)
	// Run IDs run opposite to recency so they cannot masquerade as the
	// ordering signal. The +09:00 entry is 2026-09-03T04:00:00Z: older than
	// the 05:00Z entry even though its raw string sorts later.
	writeTimestampedDagRun(t, f, "run-z", "2026-09-04T09:00:00Z")
	writeTimestampedDagRun(t, f, "run-m", "2026-09-03T13:00:00+09:00")
	writeTimestampedDagRun(t, f, "run-y", "2026-09-03T05:00:00Z")
	writeTimestampedDagRun(t, f, "run-a", "2026-09-02T23:00:00Z")
	body := fetchDagCatalog(t, f, "")
	assertDagRunIDs(t, dagCatalogPageIDs(t, body), []string{"run-z", "run-y", "run-m", "run-a"})
	wantClocks := []string{"2026-09-04T09:00:00Z", "2026-09-03T05:00:00Z", "2026-09-03T13:00:00+09:00", "2026-09-02T23:00:00Z"}
	for i, run := range body.Runs {
		if run.UpdatedAt != wantClocks[i] {
			t.Fatalf("run %q updated_at=%q want the source timestamp %q", run.RunID, run.UpdatedAt, wantClocks[i])
		}
	}
}

func TestChatDagRunCatalogEqualUpdatedAtTiebreakRunIDDesc(t *testing.T) {
	f := newDagHTTPFixture(t)
	for _, id := range []string{"eq-a", "eq-c", "eq-b"} {
		writeTimestampedDagRun(t, f, id, "2026-09-04T08:00:00Z")
	}
	body := fetchDagCatalog(t, f, "")
	// Equal updated_at clocks fall to the documented run_id DESC tiebreak.
	assertDagRunIDs(t, dagCatalogPageIDs(t, body), []string{"eq-c", "eq-b", "eq-a"})
}

func TestChatDagRunCatalogPagesConcatenateInCatalogOrder(t *testing.T) {
	f := newDagHTTPFixture(t)
	// 25 runs whose recency decreases with their index, except r10..r14,
	// which share one updated_at. Filenames enumerate backwards so neither
	// run IDs nor filenames can stand in for the order.
	base := time.Date(2026, 9, 4, 10, 0, 0, 0, time.UTC)
	for i := range 25 {
		minutes := i
		if i >= 10 && i <= 14 {
			minutes = 10
		}
		writeTimestampedDagRun(t, f, fmt.Sprintf("r%02d", i), base.Add(-time.Duration(minutes)*time.Minute).Format(time.RFC3339))
	}
	want := make([]string, 0, 25)
	for i := range 10 {
		want = append(want, fmt.Sprintf("r%02d", i))
	}
	// The shared-clock cluster r10..r14 orders by the run_id DESC tiebreak.
	for i := 14; i >= 10; i-- {
		want = append(want, fmt.Sprintf("r%02d", i))
	}
	for i := 15; i < 25; i++ {
		want = append(want, fmt.Sprintf("r%02d", i))
	}
	// limit=12 lands a page boundary inside the shared-clock cluster, where
	// only the composite (updated_at, run_id) keyset key can avoid a gap or a
	// duplicate.
	var got []string
	seen := map[string]bool{}
	for cursor, pages := "", 0; ; pages++ {
		suffix := "?limit=12"
		if cursor != "" {
			suffix += "&cursor=" + url.QueryEscape(cursor)
		}
		body := fetchDagCatalog(t, f, suffix)
		if len(body.Runs) == 0 || len(body.Runs) > 12 {
			t.Fatalf("page %d size=%d", pages, len(body.Runs))
		}
		for _, run := range body.Runs {
			if seen[run.RunID] {
				t.Fatalf("duplicate run %q across pages", run.RunID)
			}
			seen[run.RunID] = true
			got = append(got, run.RunID)
		}
		if body.NextCursor == nil {
			assertDagRunIDs(t, got, want)
			return
		}
		if *body.NextCursor == "" || *body.NextCursor == cursor {
			t.Fatalf("page %d nonprogressing cursor %q", pages, *body.NextCursor)
		}
		cursor = *body.NextCursor
	}
}

func TestChatDagRunCatalogCursorSurvivesConcurrentAppend(t *testing.T) {
	t.Run("appendOlderRunAppearsOnLaterPage", func(t *testing.T) {
		f := newDagHTTPFixture(t)
		// IDs run opposite to recency so runId order cannot satisfy the expectations.
		writeTimestampedDagRun(t, f, "p-d", "2026-09-04T04:00:00Z")
		writeTimestampedDagRun(t, f, "p-c", "2026-09-04T03:00:00Z")
		writeTimestampedDagRun(t, f, "p-b", "2026-09-04T02:00:00Z")
		writeTimestampedDagRun(t, f, "p-a", "2026-09-04T01:00:00Z")
		first := fetchDagCatalog(t, f, "?limit=2")
		assertDagRunIDs(t, dagCatalogPageIDs(t, first), []string{"p-d", "p-c"})
		if first.NextCursor == nil {
			t.Fatal("missing next cursor after partial page")
		}
		// The appended run is older than every entry already emitted, so it
		// sorts behind the cursor key and must surface on a later page.
		writeTimestampedDagRun(t, f, "p-0", "2026-09-04T00:00:00Z")
		var got []string = dagCatalogPageIDs(t, first)
		cursor := *first.NextCursor
		for {
			body := fetchDagCatalog(t, f, "?limit=2&cursor="+url.QueryEscape(cursor))
			got = append(got, dagCatalogPageIDs(t, body)...)
			if body.NextCursor == nil {
				break
			}
			cursor = *body.NextCursor
		}
		assertDagRunIDs(t, got, []string{"p-d", "p-c", "p-b", "p-a", "p-0"})
	})
	t.Run("appendNewerRunDoesNotRestartWalk", func(t *testing.T) {
		f := newDagHTTPFixture(t)
		// IDs run opposite to recency so runId order cannot satisfy the expectations.
		writeTimestampedDagRun(t, f, "q-d", "2026-09-04T04:00:00Z")
		writeTimestampedDagRun(t, f, "q-c", "2026-09-04T03:00:00Z")
		writeTimestampedDagRun(t, f, "q-b", "2026-09-04T02:00:00Z")
		writeTimestampedDagRun(t, f, "q-a", "2026-09-04T01:00:00Z")
		first := fetchDagCatalog(t, f, "?limit=2")
		assertDagRunIDs(t, dagCatalogPageIDs(t, first), []string{"q-d", "q-c"})
		if first.NextCursor == nil {
			t.Fatal("missing next cursor after partial page")
		}
		// The appended run sorts before the cursor key (and also carries the
		// largest run ID, so no ordering can smuggle it back): the walk must
		// resume at q-b, never restart at the top and never duplicate.
		writeTimestampedDagRun(t, f, "q-z", "2026-09-04T05:00:00Z")
		second := fetchDagCatalog(t, f, "?limit=2&cursor="+url.QueryEscape(*first.NextCursor))
		assertDagRunIDs(t, dagCatalogPageIDs(t, second), []string{"q-b", "q-a"})
		// The walk emitted every entry behind the cursor key, so it must end
		// cleanly instead of circling back to the appended run.
		if second.NextCursor != nil {
			t.Fatal("expected the walk to end after emitting the remaining runs")
		}
		// The appended run is not lost: a fresh walk starts at it.
		assertDagRunIDs(t, dagCatalogPageIDs(t, fetchDagCatalog(t, f, "?limit=1")), []string{"q-z"})
	})
}
