package api

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"testing"
)

type dagCatalogBody struct {
	Runs []struct {
		RunID        string `json:"run_id"`
		RunKey       string `json:"run_key"`
		Name         string `json:"name"`
		Status       string `json:"status"`
		CreatedAt    string `json:"created_at"`
		UpdatedAt    string `json:"updated_at"`
		Total        int    `json:"total"`
		ContentToken string `json:"content_token"`
	} `json:"runs"`
	NextCursor *string `json:"next_cursor"`
}

func TestChatDagRunCatalog(t *testing.T) {
	t.Run("allEmbeddedIDsBeyondLegacyCaps", func(t *testing.T) {
		f := newDagHTTPFixture(t)
		// Also exceed the old candidate cap; unrelated records cannot hide owned runs.
		for i := range 2050 {
			r := dagFixtureRun(fmt.Sprintf("foreign-%04d", i), 1, 1)
			r["parentSessionId"] = "other"
			writeDagFixture(t, filepath.Join(f.dir, fmt.Sprintf("a-%04d.json", i)), r)
		}
		const total = 517
		tokens := map[string]string{}
		for i := range total {
			id := fmt.Sprintf("run-%04d", i)
			data := writeDagFixture(t, filepath.Join(f.dir, fmt.Sprintf("z-%04d.json", total-i)), dagFixtureRun(id, 1, 2048))
			sum := sha256.Sum256(data)
			tokens[id] = hex.EncodeToString(sum[:])
		}
		big := dagFixtureRun("zz-large", 64, 70<<10)
		bigBytes := writeDagFixture(t, filepath.Join(f.dir, "large-file.json"), big)
		bigSum := sha256.Sum256(bigBytes)
		tokens["zz-large"] = hex.EncodeToString(bigSum[:])
		seen := map[string]bool{}
		cursor := ""
		ids := []string{}
		for page := 0; ; page++ {
			suffix := ""
			if cursor != "" {
				suffix = "?cursor=" + url.QueryEscape(cursor)
			}
			rec := f.get(t, suffix)
			if rec.Code != 200 {
				t.Fatalf("catalog status=%d body=%s", rec.Code, rec.Body.String())
			}
			var body dagCatalogBody
			if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			if body.Runs == nil || len(body.Runs) > 100 || (page == 0 && len(body.Runs) != 100) {
				t.Fatalf("invalid default page size %d", len(body.Runs))
			}
			for _, entry := range body.Runs {
				if seen[entry.RunID] {
					t.Fatalf("duplicate %q", entry.RunID)
				}
				seen[entry.RunID] = true
				ids = append(ids, entry.RunID)
				wantTotal := 1
				if entry.RunID == "zz-large" {
					wantTotal = 64
				}
				if entry.Total != wantTotal || entry.ContentToken != tokens[entry.RunID] || entry.RunKey != "key-"+entry.RunID || entry.Name != "name-"+entry.RunID || entry.Status != big["status"] || entry.CreatedAt != big["createdAt"] || entry.UpdatedAt != big["updatedAt"] {
					t.Fatalf("catalog entry differs from original source: %+v", entry)
				}
			}
			if body.NextCursor == nil {
				break
			}
			if *body.NextCursor == "" || *body.NextCursor == cursor || page > total {
				t.Fatal("nonprogressing cursor")
			}
			cursor = *body.NextCursor
		}
		if len(seen) != total+1 || !sort.StringsAreSorted(ids) {
			t.Fatalf("discovery returned %d unsorted=%v", len(seen), !sort.StringsAreSorted(ids))
		}
		for i := range total {
			if !seen[fmt.Sprintf("run-%04d", i)] {
				t.Fatalf("missing run %d", i)
			}
		}
		assertFullDag(t, decodeDagDocument(t, f.get(t, "/zz-large")), big, bigBytes)
	})
	t.Run("keysetSurvivesFilenameReplacement", func(t *testing.T) {
		f := newDagHTTPFixture(t)
		a := dagFixtureRun("a", 1, 1)
		b := dagFixtureRun("b", 1, 1)
		writeDagFixture(t, filepath.Join(f.dir, "first.json"), a)
		writeDagFixture(t, filepath.Join(f.dir, "second.json"), b)
		rec := f.get(t, "?limit=1")
		if rec.Code != 200 {
			t.Fatalf("status=%d", rec.Code)
		}
		var first dagCatalogBody
		if err := json.Unmarshal(rec.Body.Bytes(), &first); err != nil {
			t.Fatal(err)
		}
		if len(first.Runs) != 1 || first.Runs[0].RunID != "a" || first.NextCursor == nil {
			t.Fatal("first page incorrect")
		}
		if err := os.Rename(filepath.Join(f.dir, "second.json"), filepath.Join(f.dir, "renamed.json")); err != nil {
			t.Fatal(err)
		}
		rec = f.get(t, "?limit=1&cursor="+url.QueryEscape(*first.NextCursor))
		if rec.Code != 200 {
			t.Fatalf("status=%d", rec.Code)
		}
		var second dagCatalogBody
		if err := json.Unmarshal(rec.Body.Bytes(), &second); err != nil {
			t.Fatal(err)
		}
		if len(second.Runs) != 1 || second.Runs[0].RunID != "b" || second.NextCursor != nil {
			t.Fatalf("second page incorrect: %+v", second)
		}
	})
	t.Run("invalidInput", func(t *testing.T) {
		f := newDagHTTPFixture(t)
		for _, suffix := range []string{"?cursor=%25", "?cursor=e30", "?limit=0", "?limit=-1", "?limit=101", "?limit=abc", "?limit=1&limit=2", "?cursor="} {
			t.Run(suffix, func(t *testing.T) {
				if rec := f.get(t, suffix); rec.Code != http.StatusBadRequest {
					t.Fatalf("status=%d want 400", rec.Code)
				}
			})
		}
	})
	t.Run("empty", func(t *testing.T) {
		f := newDagHTTPFixture(t)
		rec := f.get(t, "")
		if rec.Code != 200 {
			t.Fatalf("status=%d", rec.Code)
		}
		var body dagCatalogBody
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if body.Runs == nil || len(body.Runs) != 0 || body.NextCursor != nil {
			t.Fatal("empty catalog shape")
		}
	})
}
