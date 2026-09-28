package coldhistory

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
)

func TestStreamTailFirstSkipWarmEmitsTailOnly(t *testing.T) {
	tests := []struct {
		name    string
		entries int
		header  bool
		tail    int
		wantIDs []string
	}{
		{name: "tail cuts warm ranges", entries: 10, tail: 3, wantIDs: []string{"e-7", "e-8", "e-9"}},
		{name: "small tail", entries: 8, tail: 2, wantIDs: []string{"e-6", "e-7"}},
		{name: "branch shorter than tail", entries: 2, tail: 3, wantIDs: []string{"e-0", "e-1"}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			path := writeLinearBranch(t, tc.entries)
			var pages []Page
			metadata, err := StreamTailFirst(context.Background(), path, Options{SkipWarm: true}, tc.tail, 2, func(_ Metadata, page Page) error {
				pages = append(pages, page)
				return nil
			})
			if err != nil {
				t.Fatal(err)
			}
			if metadata.LeafID != fmt.Sprintf("e-%d", tc.entries-1) || metadata.Total != tc.entries {
				t.Fatalf("metadata = %+v", metadata)
			}
			if len(pages) != 1 {
				t.Fatalf("got %d pages %s, want exactly the tail page", len(pages), summarizePages(t, pages))
			}
			page := pages[0]
			if got := pageIDs(t, pages); fmt.Sprint(got) != fmt.Sprint(tc.wantIDs) {
				t.Fatalf("ids = %v, want %v", got, tc.wantIDs)
			}
			if page.Head {
				t.Fatal("skip-warm tail page must not be a head chunk")
			}
			wantStart := tc.entries - len(tc.wantIDs)
			if page.Start != wantStart {
				t.Fatalf("start = %d, want absolute %d", page.Start, wantStart)
			}
			if !page.Final {
				t.Fatal("the only emitted page must carry Final")
			}
			complete := pages[0].Start == 0
			if complete != (tc.entries <= tc.tail) {
				t.Fatalf("first tail page Start==%d implies historyComplete=%v", pages[0].Start, complete)
			}
		})
	}

	t.Run("header only", func(t *testing.T) {
		path := writeFixture(t, testHeader+"\n")
		var pages []Page
		if _, err := StreamTailFirst(context.Background(), path, Options{SkipWarm: true}, 3, 2, func(_ Metadata, page Page) error {
			pages = append(pages, page)
			return nil
		}); err != nil {
			t.Fatal(err)
		}
		if len(pages) != 1 || len(pages[0].Entries) != 0 || pages[0].Start != 0 || !pages[0].Final || pages[0].Head {
			t.Fatalf("pages = %s, want one empty final tail page", summarizePages(t, pages))
		}
	})

	t.Run("zero options keep warm ranges", func(t *testing.T) {
		path := writeLinearBranch(t, 10)
		var pages []Page
		if _, err := StreamTailFirst(context.Background(), path, Options{}, 3, 2, func(_ Metadata, page Page) error {
			pages = append(pages, page)
			return nil
		}); err != nil {
			t.Fatal(err)
		}
		want := []struct {
			ids   []string
			start int
			head  bool
			final bool
		}{
			{ids: []string{"e-7", "e-8", "e-9"}, start: 7},
			{ids: []string{"e-5", "e-6"}, start: 5, head: true},
			{ids: []string{"e-3", "e-4"}, start: 3, head: true},
			{ids: []string{"e-1", "e-2"}, start: 1, head: true},
			{ids: []string{"e-0"}, start: 0, head: true, final: true},
		}
		if len(pages) != len(want) {
			t.Fatalf("got %d pages %s, want %d", len(pages), summarizePages(t, pages), len(want))
		}
		for i, got := range pages {
			if fmt.Sprint(pageIDs(t, []Page{got})) != fmt.Sprint(want[i].ids) ||
				got.Start != want[i].start || got.Head != want[i].head || got.Final != want[i].final {
				t.Fatalf("page %d = %s, want %+v", i, summarizePages(t, []Page{got}), want[i])
			}
		}
	})
}

func TestStreamTailFirstFreshTailUsesEntryJSONByteBound(t *testing.T) {
	// Given a branch with a tail whose last two JSON entries exactly fit.
	path := writePaddedLinearBranch(t, 4, 128)
	budget := len(paddedEntryLine(2, 128)) + len(paddedEntryLine(3, 128))

	// When selecting a fresh tail under both the entry and byte bounds.
	var pages []Page
	_, err := StreamTailFirst(context.Background(), path, Options{SkipWarm: true, TailBytes: budget}, 60, 100,
		func(_ Metadata, page Page) error {
			pages = append(pages, page)
			return nil
		})
	if err != nil {
		t.Fatal(err)
	}

	// Then the exact JSON size is eligible, and its absolute start is not root.
	if len(pages) != 1 || pages[0].Start != 2 || !pages[0].Final {
		t.Fatalf("bounded tail pages = %s, want one final page starting at 2", summarizePages(t, pages))
	}
	if got := pageIDs(t, pages); fmt.Sprint(got) != fmt.Sprint([]string{"e-2", "e-3"}) {
		t.Fatalf("bounded tail ids = %v, want the last two", got)
	}
	if got := len(pages[0].Entries[0]) + len(pages[0].Entries[1]); got != budget {
		t.Fatalf("entry JSON = %d bytes, want exact budget %d", got, budget)
	}
}

func TestStreamTailFirstSkipWarmResumeRangeOnly(t *testing.T) {
	path := writeLinearBranch(t, 430)
	cursor := ResumeCursor{SessionID: "session-1", FirstEntryID: "e-140", LastEntryID: "e-299", HistoryComplete: false}

	var pages []Page
	metadata, err := StreamTailFirst(context.Background(), path, Options{SkipWarm: true, Resume: &cursor, PageEntries: 7}, 60, 100, func(meta Metadata, page Page) error {
		if meta.Resume == nil {
			t.Fatal("cursor not accepted")
		}
		pages = append(pages, page)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if metadata.Resume == nil {
		t.Fatal("resume cursor not recorded on metadata")
	}
	var ids []string
	finals, heads := 0, 0
	for _, page := range pages {
		if page.Head {
			heads++
		}
		if page.Final {
			finals++
		}
		ids = append(ids, pageIDs(t, []Page{page})...)
	}
	if heads != 0 {
		t.Fatalf("%d head pages emitted under SkipWarm", heads)
	}
	if len(ids) != 130 {
		t.Fatalf("emitted %d entries, want only the 130 after the cursor", len(ids))
	}
	for i, id := range ids {
		if want := fmt.Sprintf("e-%d", 300+i); id != want {
			t.Fatalf("entry %d = %s, want %s", i, id, want)
		}
	}
	if pages[0].Start != 300 {
		t.Fatalf("first page start = %d, want absolute 300", pages[0].Start)
	}
	if finals != 1 || !pages[len(pages)-1].Final {
		t.Fatalf("finals = %d, want exactly one on the last emitted page", finals)
	}

	t.Run("cursor covers the branch", func(t *testing.T) {
		whole := ResumeCursor{SessionID: "session-1", FirstEntryID: "e-0", LastEntryID: "e-9", HistoryComplete: true}
		var pages []Page
		metadata, err := StreamTailFirst(context.Background(), writeLinearBranch(t, 10), Options{SkipWarm: true, Resume: &whole}, 3, 2, func(_ Metadata, page Page) error {
			pages = append(pages, page)
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
		if metadata.Resume == nil {
			t.Fatal("complete cursor not accepted")
		}
		if len(pages) != 1 || len(pages[0].Entries) != 0 || !pages[0].Final || pages[0].Head {
			t.Fatalf("pages = %s, want one empty final page", summarizePages(t, pages))
		}
	})
}

func TestStreamBeforePages(t *testing.T) {
	path := writeLinearBranch(t, 12)
	for _, tc := range []struct {
		name     string
		before   string
		limit    int
		wantIDs  []string
		start    int
		complete bool
		wantErr  error
	}{
		{name: "middle page", before: "e-8", limit: 3, wantIDs: []string{"e-5", "e-6", "e-7"}, start: 5},
		{name: "page reaching root", before: "e-8", limit: 20, wantIDs: idsInRange(0, 8), start: 0, complete: true},
		{name: "exact window to root", before: "e-2", limit: 2, wantIDs: idsInRange(0, 2), start: 0, complete: true},
		{name: "before at root", before: "e-0", limit: 5, start: 0, complete: true},
		{name: "zero limit selects default", before: "e-11", limit: 0, wantIDs: idsInRange(0, 11), start: 0, complete: true},
		{name: "negative limit", before: "e-5", limit: -1, wantErr: ErrInvalidOptions},
	} {
		t.Run(tc.name, func(t *testing.T) {
			metadata, page, err := StreamBefore(context.Background(), path, Options{}, tc.before, tc.limit)
			if tc.wantErr != nil {
				if !errors.Is(err, tc.wantErr) {
					t.Fatalf("error = %v, want %v", err, tc.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if metadata.LeafID != "e-11" || metadata.Total != 12 || metadata.Header.ID != "session-1" {
				t.Fatalf("metadata = %+v", metadata)
			}
			if got := beforeIDs(t, page); fmt.Sprint(got) != fmt.Sprint(tc.wantIDs) {
				t.Fatalf("ids = %v, want %v", got, tc.wantIDs)
			}
			if page.Start != tc.start || page.HistoryComplete != tc.complete {
				t.Fatalf("start/complete = %d/%v, want %d/%v", page.Start, page.HistoryComplete, tc.start, tc.complete)
			}
		})
	}
}

func TestStreamBeforeOffBranchCursor(t *testing.T) {
	path := writeFixture(t, strings.Join([]string{
		testHeader,
		`{"type":"message","id":"root","parentId":null}`,
		`{"type":"message","id":"left","parentId":"root"}`,
		`{"type":"message","id":"abandoned","parentId":"root"}`,
		`{"type":"message","id":"leaf","parentId":"left"}`,
		"",
	}, "\n"))

	for _, before := range []string{"abandoned", "never-written"} {
		_, _, err := StreamBefore(context.Background(), path, Options{}, before, 10)
		if !errors.Is(err, ErrEntryNotOnBranch) {
			t.Fatalf("before %q error = %v, want ErrEntryNotOnBranch", before, err)
		}
	}

	metadata, page, err := StreamBefore(context.Background(), path, Options{}, "leaf", 10)
	if err != nil {
		t.Fatal(err)
	}
	if metadata.Total != 3 || metadata.LeafID != "leaf" {
		t.Fatalf("metadata = %+v", metadata)
	}
	if got := beforeIDs(t, page); fmt.Sprint(got) != fmt.Sprint([]string{"root", "left"}) || page.Start != 0 || !page.HistoryComplete {
		t.Fatalf("page = %+v, want [root left] complete from the root", page)
	}

	_, page, err = StreamBefore(context.Background(), path, Options{}, "leaf", 1)
	if err != nil {
		t.Fatal(err)
	}
	if got := beforeIDs(t, page); fmt.Sprint(got) != fmt.Sprint([]string{"left"}) || page.Start != 1 || page.HistoryComplete {
		t.Fatalf("limited page = %+v, want [left] at start 1", page)
	}
}

func TestStreamBeforeByteBoundDropsOldest(t *testing.T) {
	t.Run("small bound keeps the newest two", func(t *testing.T) {
		path := writePaddedLinearBranch(t, 7, 100)
		twoEntries := 2 * len(paddedEntryLine(1, 100))
		opts := Options{MaxLineBytes: twoEntries + 10, PageBytes: twoEntries + 10}
		_, page, err := StreamBefore(context.Background(), path, opts, "e-5", 10)
		if err != nil {
			t.Fatal(err)
		}
		if got := beforeIDs(t, page); fmt.Sprint(got) != fmt.Sprint([]string{"e-3", "e-4"}) {
			t.Fatalf("ids = %v, want the two newest preceding entries", got)
		}
		if page.Start != 3 || page.HistoryComplete {
			t.Fatalf("start/complete = %d/%v, want 3/false", page.Start, page.HistoryComplete)
		}
	})

	t.Run("default 4 MB bound splits a wide page", func(t *testing.T) {
		const (
			entries = 6
			pad     = 1 << 20
			before  = "e-5"
			fourMB  = 4 << 20
		)
		lines := make([]string, entries)
		for i := range lines {
			lines[i] = paddedEntryLine(i, pad)
		}
		sum, want := 0, 0
		for i := entries - 2; i >= 0; i-- {
			if want > 0 && sum+len(lines[i]) > fourMB {
				break
			}
			sum += len(lines[i])
			want++
		}
		if want < 1 || want >= entries-1 {
			t.Fatalf("fixture fits %d of %d entries; byte bound not exercised", want, entries-1)
		}
		path := writePaddedLinearBranch(t, entries, pad)
		metadata, page, err := StreamBefore(context.Background(), path, Options{}, before, entries)
		if err != nil {
			t.Fatal(err)
		}
		if metadata.Total != entries {
			t.Fatalf("metadata = %+v", metadata)
		}
		if len(page.Entries) != want {
			t.Fatalf("page keeps %d entries, want %d (oldest dropped to fit 4 MB)", len(page.Entries), want)
		}
		wantIDs := make([]string, want)
		for i := range wantIDs {
			wantIDs[i] = fmt.Sprintf("e-%d", entries-1-want+i)
		}
		if got := beforeIDs(t, page); fmt.Sprint(got) != fmt.Sprint(wantIDs) {
			t.Fatalf("ids = %v, want %v", got, wantIDs)
		}
		pageBytes := 0
		for _, raw := range page.Entries {
			pageBytes += len(raw)
		}
		if pageBytes > fourMB {
			t.Fatalf("page bytes = %d, bound = %d", pageBytes, fourMB)
		}
		if page.Start != entries-1-want || page.HistoryComplete {
			t.Fatalf("start/complete = %d/%v, want %d/false", page.Start, page.HistoryComplete, entries-1-want)
		}
	})

	t.Run("oversized single entry is still returned", func(t *testing.T) {
		path := writePaddedLinearBranch(t, 4, 500)
		line := len(paddedEntryLine(1, 500))
		opts := Options{MaxLineBytes: line, PageBytes: line}
		_, page, err := StreamBefore(context.Background(), path, opts, "e-1", 10)
		if err != nil {
			t.Fatal(err)
		}
		if got := beforeIDs(t, page); fmt.Sprint(got) != fmt.Sprint([]string{"e-0"}) || page.Start != 0 || !page.HistoryComplete {
			t.Fatalf("page = %+v, want the single oversized entry [e-0]", page)
		}
	})
}

func TestStreamBeforeTornTrailingLine(t *testing.T) {
	lines := []string{testHeader}
	for i := 0; i < 5; i++ {
		parent := "null"
		if i > 0 {
			parent = fmt.Sprintf("%q", fmt.Sprintf("e-%d", i-1))
		}
		lines = append(lines, fmt.Sprintf(`{"type":"message","id":"e-%d","parentId":%s}`, i, parent))
	}
	path := writeFixture(t, strings.Join(lines, "\n")+"\n"+`{"type":"message","id":"torn"`)

	metadata, page, err := StreamBefore(context.Background(), path, Options{}, "e-4", 10)
	if err != nil {
		t.Fatal(err)
	}
	if metadata.LeafID != "e-4" || metadata.Total != 5 {
		t.Fatalf("metadata = %+v, want the torn line ignored", metadata)
	}
	if got := beforeIDs(t, page); fmt.Sprint(got) != fmt.Sprint(idsInRange(0, 4)) || page.Start != 0 || !page.HistoryComplete {
		t.Fatalf("page = %+v, want [e-0 e-1 e-2 e-3] complete", page)
	}
}

func TestIndexCacheHitSkipsReindex(t *testing.T) {
	path := writeLinearBranch(t, 50)
	stream := func(opts Options) []string {
		t.Helper()
		var ids []string
		_, err := StreamTailFirst(context.Background(), path, opts, 10, 5, func(_ Metadata, page Page) error {
			ids = append(ids, pageIDs(t, []Page{page})...)
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
		return ids
	}

	before := sessionIndexCache.hitCount()
	first := stream(Options{})
	if got := sessionIndexCache.hitCount(); got != before {
		t.Fatalf("first open already hit the cache: %d -> %d", before, got)
	}
	second := stream(Options{})
	if got := sessionIndexCache.hitCount(); got != before+1 {
		t.Fatalf("second open did not hit the cache: %d -> %d", before, got)
	}
	if fmt.Sprint(first) != fmt.Sprint(second) {
		t.Fatal("cache hit changed the stream")
	}

	cached := stream(Options{NoCache: true})
	if got := sessionIndexCache.hitCount(); got != before+1 {
		t.Fatalf("NoCache touched the cache: %d -> %d", before+1, got)
	}
	if fmt.Sprint(cached) != fmt.Sprint(first) {
		t.Fatal("NoCache stream differs")
	}
	if again := stream(Options{}); fmt.Sprint(again) != fmt.Sprint(first) {
		t.Fatal("post-NoCache stream differs")
	}
	if got := sessionIndexCache.hitCount(); got != before+2 {
		t.Fatalf("NoCache evicted the cached entry: %d -> %d", before+1, got)
	}
}

func TestIndexCacheInvalidatesOnAppend(t *testing.T) {
	path := writeLinearBranch(t, 5)
	metadata, err := Stream(context.Background(), path, Options{}, func(Metadata, Page) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	if metadata.LeafID != "e-4" || metadata.Total != 5 {
		t.Fatalf("initial metadata = %+v", metadata)
	}

	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fmt.Fprintf(f, `{"type":"message","id":"e-5","parentId":"e-4"}`+"\n"); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}

	hits := sessionIndexCache.hitCount()
	metadata, err = Stream(context.Background(), path, Options{}, func(Metadata, Page) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	if metadata.LeafID != "e-5" || metadata.Total != 6 {
		t.Fatalf("metadata after append = %+v, want the re-indexed branch", metadata)
	}
	if got := sessionIndexCache.hitCount(); got != hits {
		t.Fatalf("appended file was served from the cache: %d -> %d", hits, got)
	}

	_, page, err := StreamBefore(context.Background(), path, Options{}, "e-5", 2)
	if err != nil {
		t.Fatal(err)
	}
	if got := beforeIDs(t, page); fmt.Sprint(got) != fmt.Sprint([]string{"e-3", "e-4"}) || page.Start != 3 {
		t.Fatalf("page after append = %+v, want [e-3 e-4] at 3", page)
	}
}

func TestIndexCacheRejectsSameSizeRestoredMtimeRewrite(t *testing.T) {
	path := writeLinearBranch(t, 5)
	original, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Stream(context.Background(), path, Options{}, func(Metadata, Page) error { return nil }); err != nil {
		t.Fatal(err)
	}

	contents, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	replacement := strings.Replace(string(contents), `"id":"e-4"`, `"id":"x-4"`, 1)
	if replacement == string(contents) {
		t.Fatal("fixture has no leaf to replace")
	}
	if err := os.WriteFile(path, []byte(replacement), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(path, original.ModTime(), original.ModTime()); err != nil {
		t.Fatal(err)
	}
	rewritten, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if !os.SameFile(original, rewritten) || original.Size() != rewritten.Size() || !original.ModTime().Equal(rewritten.ModTime()) {
		t.Fatalf("rewrite did not preserve cached path/inode/size/mtime: old=%+v new=%+v", original, rewritten)
	}

	metadata, err := Stream(context.Background(), path, Options{}, func(Metadata, Page) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	if metadata.LeafID != "x-4" {
		t.Fatalf("leaf after same-identity rewrite = %q, want x-4", metadata.LeafID)
	}
}

func TestIndexCacheRespectsIndexBudgetsAfterWarm(t *testing.T) {
	for _, tc := range []struct {
		name string
		opts Options
		want error
	}{
		{name: "index bytes", opts: Options{IndexBytes: 1}, want: ErrIndexBudgetExceeded},
		{name: "line bytes", opts: Options{MaxLineBytes: 64, PageBytes: 64}, want: ErrLineTooLong},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path := writeLinearBranch(t, 5)
			if _, err := Stream(context.Background(), path, Options{}, func(Metadata, Page) error { return nil }); err != nil {
				t.Fatal(err)
			}
			_, err := Stream(context.Background(), path, tc.opts, func(Metadata, Page) error { return nil })
			if !errors.Is(err, tc.want) {
				t.Fatalf("cached stream error = %v, want %v", err, tc.want)
			}
		})
	}
}

func TestIndexCacheEvictsLeastRecentlyUsed(t *testing.T) {
	paths := make([]string, DefaultIndexCacheFiles+1)
	for i := range paths {
		paths[i] = writeLinearBranch(t, 3+i)
	}
	warm := func(path string) {
		t.Helper()
		metadata, err := Stream(context.Background(), path, Options{}, func(Metadata, Page) error { return nil })
		if err != nil {
			t.Fatal(err)
		}
		if metadata.Total < 3 {
			t.Fatalf("metadata = %+v", metadata)
		}
	}
	for _, path := range paths {
		warm(path)
	}

	hits := sessionIndexCache.hitCount()
	warm(paths[len(paths)-1])
	if got := sessionIndexCache.hitCount(); got != hits+1 {
		t.Fatalf("most recently used file missed: %d -> %d", hits, got)
	}
	warm(paths[0])
	if got := sessionIndexCache.hitCount(); got != hits+1 {
		t.Fatalf("file beyond capacity was still cached: %d -> %d", hits+1, got)
	}
}

func TestIndexCacheConcurrentReaders(t *testing.T) {
	const entries = 400
	path := writeLinearBranch(t, entries)
	leaf := fmt.Sprintf("e-%d", entries-1)
	startHits := sessionIndexCache.hitCount()

	var wg sync.WaitGroup
	for worker := 0; worker < 8; worker++ {
		wg.Add(1)
		go func(worker int) {
			defer wg.Done()
			for i := 0; i < 5; i++ {
				opts := Options{PageEntries: 13, NoCache: i == 0}
				if worker%2 == 0 {
					opts.SkipWarm = true
				}
				seen := map[string]bool{}
				_, err := StreamTailFirst(context.Background(), path, opts, 60, 100, func(meta Metadata, page Page) error {
					if meta.LeafID != leaf || meta.Total != entries {
						t.Errorf("tail metadata = %+v", meta)
					}
					if opts.SkipWarm && page.Head {
						t.Error("head page emitted under SkipWarm")
					}
					for _, id := range pageIDs(t, []Page{page}) {
						if seen[id] {
							t.Errorf("duplicate entry %s", id)
						}
						seen[id] = true
					}
					return nil
				})
				if err != nil {
					t.Errorf("worker %d tail: %v", worker, err)
					return
				}

				bmeta, page, err := StreamBefore(context.Background(), path, opts, "e-250", 40)
				if err != nil {
					t.Errorf("worker %d before: %v", worker, err)
					return
				}
				if bmeta.Total != entries || len(page.Entries) != 40 || page.Start != 210 || page.HistoryComplete {
					t.Errorf("worker %d before page = start %d len %d complete %v", worker, page.Start, len(page.Entries), page.HistoryComplete)
				}

				count := 0
				_, err = Stream(context.Background(), path, opts, func(meta Metadata, page Page) error {
					if meta.Total != entries {
						t.Errorf("stream metadata = %+v", meta)
					}
					count += len(page.Entries)
					return nil
				})
				if err != nil {
					t.Errorf("worker %d stream: %v", worker, err)
					return
				}
				if count != entries {
					t.Errorf("worker %d streamed %d entries", worker, count)
				}
			}
		}(worker)
	}
	wg.Wait()

	if got := sessionIndexCache.hitCount(); got == startHits {
		t.Fatal("concurrent readers never hit the cache")
	}
}

func beforeIDs(t *testing.T, page BeforePage) []string {
	t.Helper()
	return pageIDs(t, []Page{{Entries: page.Entries}})
}

func idsInRange(from, to int) []string {
	ids := make([]string, 0, to-from)
	for i := from; i < to; i++ {
		ids = append(ids, fmt.Sprintf("e-%d", i))
	}
	return ids
}
