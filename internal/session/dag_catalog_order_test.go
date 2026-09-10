package session

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// Catalog order contract under test: updated_at DESC is the primary key,
// compared as a parsed RFC3339 instant so differing UTC offsets cannot
// reorder runs, with run_id DESC as the deterministic tiebreak so the whole
// comparator is uniformly descending. Run IDs never imply recency; they only
// break exact ties. Runs with a missing or unparseable updated_at rank as the
// oldest and sort last. The paginated catalog endpoint walks this same total
// order, so these store-level expectations are the pagination contract too.

func writeDagCatalogRun(t *testing.T, cwd, filename, runID, updatedAt string) {
	t.Helper()
	doc := map[string]any{
		"runId":           runID,
		"runKey":          "key-" + runID,
		"name":            "name-" + runID,
		"status":          "completed",
		"parentSessionId": "parent",
		"createdAt":       "2026-09-02T10:00:00Z",
		"definition":      map[string]any{"nodes": []map[string]any{{"id": "n1", "label": "n1", "prompt": "p"}}},
		"nodes":           []map[string]any{{"id": "n1", "state": "completed"}},
	}
	// An absent updatedAt stays absent: the store must not invent a clock.
	if updatedAt != "" {
		doc["updatedAt"] = updatedAt
	}
	data, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(cwd, ".omo", "senpi-task", "dag", "runs")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, filename), data, 0600); err != nil {
		t.Fatal(err)
	}
}

func dagCatalogRunIDs(t *testing.T, cwd string) []string {
	t.Helper()
	entries, err := ReadDagCatalog(t.Context(), cwd, "parent")
	if err != nil {
		t.Fatalf("ReadDagCatalog: %v", err)
	}
	ids := make([]string, len(entries))
	for i, entry := range entries {
		ids[i] = entry.RunID
	}
	return ids
}

func assertIDs(t *testing.T, got, want []string) {
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

func TestReadDagCatalogOrdersNewestUpdatedAtFirst(t *testing.T) {
	cwd := t.TempDir()
	// Run IDs deliberately run opposite to recency and filenames are
	// scrambled: neither can be the recency signal. The +09:00 entry is
	// 2026-09-03T04:00:00Z, so it is older than the 05:00Z entry even though
	// its raw string sorts later - pinning instant comparison over string
	// comparison.
	writeDagCatalogRun(t, cwd, "f3.json", "zz-newest", "2026-09-04T09:00:00Z")
	writeDagCatalogRun(t, cwd, "f1.json", "mm-middle", "2026-09-03T13:00:00+09:00")
	writeDagCatalogRun(t, cwd, "f2.json", "aa-older", "2026-09-03T05:00:00Z")
	writeDagCatalogRun(t, cwd, "f0.json", "kk-oldest", "2026-09-02T23:00:00Z")
	assertIDs(t, dagCatalogRunIDs(t, cwd), []string{"zz-newest", "aa-older", "mm-middle", "kk-oldest"})
}

func TestReadDagCatalogTiebreakEqualUpdatedAtByRunIDDesc(t *testing.T) {
	const shared = "2026-09-04T08:00:00Z"
	// The same run set under two stores whose filenames enumerate in opposite
	// orders must produce the identical sequence: the tiebreak direction is
	// fixed (run_id DESC) and cannot inherit directory iteration order.
	for _, filenames := range [][4]string{{"a.json", "b.json", "c.json", "d.json"}, {"z.json", "y.json", "x.json", "w.json"}} {
		cwd := t.TempDir()
		for i, id := range []string{"tie-b", "tie-d", "tie-a", "tie-c"} {
			writeDagCatalogRun(t, cwd, filenames[i], id, shared)
		}
		assertIDs(t, dagCatalogRunIDs(t, cwd), []string{"tie-d", "tie-c", "tie-b", "tie-a"})
	}
}

func TestReadDagCatalogMissingUpdatedAtSortsLast(t *testing.T) {
	cwd := t.TempDir()
	// Missing and unparseable clocks rank as the oldest instant; among them
	// the same run_id DESC tiebreak applies.
	writeDagCatalogRun(t, cwd, "a.json", "no-clock", "")
	writeDagCatalogRun(t, cwd, "b.json", "bad-clock", "not-a-timestamp")
	writeDagCatalogRun(t, cwd, "c.json", "clocked", "2026-09-04T07:00:00Z")
	assertIDs(t, dagCatalogRunIDs(t, cwd), []string{"clocked", "no-clock", "bad-clock"})
}

func TestReadDagCatalogEmptyStoreIsEmpty(t *testing.T) {
	entries, err := ReadDagCatalog(t.Context(), t.TempDir(), "parent")
	if err != nil {
		t.Fatalf("absent store error=%v", err)
	}
	if entries == nil || len(entries) != 0 {
		t.Fatalf("absent store entries=%v", entries)
	}
}
