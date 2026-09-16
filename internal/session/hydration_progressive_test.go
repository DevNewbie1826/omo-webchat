package session

// Progressive hydration contract: a capability-marked subscriber gets the
// bounded tail painted first, the live engine tail as the single terminal
// page, then earlier branch history warmed newest-first in head pages. A
// legacy subscriber keeps today's complete root-to-leaf stream.

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc/omorpctest"
)

const progressiveLiveTailEntry = `{"type":"message","id":"live-1","parentId":"entry-0299","message":{"role":"user","content":[{"type":"text","text":"live"}]}}`

// capabilityRecorder marks the attach as progressive-capable (or not) for the
// hydration capability negotiation.
type capabilityRecorder struct {
	recorder
	progressive bool
}

func (r *capabilityRecorder) ProgressiveHistory() bool { return r.progressive }

// writeProgressiveFixture writes a linear active branch of the given entry
// count, turning the listed indexes into compaction boundaries. padding
// grows each message body so byte-bounded page chunking splits ranges.
func writeProgressiveFixture(t *testing.T, dir, name string, entries, padding int, compactionAt ...int) (path, leafID string) {
	t.Helper()
	path = filepath.Join(dir, name)
	sum := sha256.Sum256([]byte(path))
	durableID := "durable-" + hex.EncodeToString(sum[:4]) + "-7d24-4b1e-resume"
	compactions := make(map[int]bool, len(compactionAt))
	for _, at := range compactionAt {
		compactions[at] = true
	}
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	writer := bufio.NewWriterSize(file, 64<<10)
	encoder := json.NewEncoder(writer)
	if err := encoder.Encode(map[string]any{
		"type": "session", "version": 3, "id": durableID,
		"timestamp": "2026-09-16T00:00:00.000Z", "cwd": dir,
	}); err != nil {
		t.Fatal(err)
	}
	parent := any(nil)
	body := strings.Repeat("x", padding)
	for i := 0; i < entries; i++ {
		id := fmt.Sprintf("entry-%04d", i)
		var entry map[string]any
		if compactions[i] {
			entry = map[string]any{
				"type": "compaction", "id": id, "parentId": parent,
				"summary": "fold", "tokensBefore": 100, "firstKeptEntryId": "entry-0000",
			}
		} else {
			entry = map[string]any{
				"type": "message", "id": id, "parentId": parent,
				"timestamp": "2026-09-16T00:00:01.000Z",
				"message": map[string]any{
					"role":    "user",
					"content": []any{map[string]any{"type": "text", "text": body}},
				},
			}
		}
		if err := encoder.Encode(entry); err != nil {
			t.Fatal(err)
		}
		parent, leafID = id, id
	}
	if err := writer.Flush(); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	return path, leafID
}

// attachScriptedTail acquires the chat with a scripted live engine tail: the
// get_entries response carries liveTailJSON entries and reports liveLeaf.
func attachScriptedTail(t *testing.T, d *omorpctest.Daemon, mgr *Manager, store *memCursorStore, chatID, path, liveTailJSON, liveLeaf string, progressive bool) (*Session, *capabilityRecorder, func()) {
	t.Helper()
	store.cursors[chatID] = Cursor{SessionFile: path}
	// Earlier attaches on the same daemon already answered their tail probes;
	// await the next request for this path relative to that baseline.
	baseline := d.RequestCountForPath(omorpc.CmdGetEntries, path)
	release := d.BlockHandlerForPath(omorpc.CmdGetEntries, path)
	sub := &capabilityRecorder{recorder: *newRecorder(1024), progressive: progressive}
	type attachResult struct {
		sess   *Session
		detach func()
		err    error
	}
	result := make(chan attachResult, 1)
	go func() {
		sess, _, detach, err := mgr.Acquire(context.Background(), testChat{id: chatID, cwd: filepath.Dir(path)}, sub)
		result <- attachResult{sess: sess, detach: detach, err: err}
	}()
	if !d.AwaitRequestCountForPath(omorpc.CmdGetEntries, path, baseline+1, testTimeout) {
		t.Fatal("incremental tail request absent")
	}
	request := d.LastRequest(omorpc.CmdGetEntries)
	id, _ := request["id"].(string)
	sid, _ := request["sessionId"].(string)
	d.WriteRaw(fmt.Appendf(nil, `{"id":%q,"type":"response","command":"get_entries","sessionId":%q,"success":true,"data":{"entries":[%s],"leafId":%q}}`+"\n", id, sid, liveTailJSON, liveLeaf))
	got := <-result
	if got.err != nil {
		t.Fatal(got.err)
	}
	release()
	if got.detach == nil {
		t.Fatal("attach returned no detach")
	}
	return got.sess, sub, got.detach
}

// collectMarkedHydration drains every entries frame and compaction-history
// notice through a FIFO marker published after attach returned, so pages that
// the hydration goroutine queued after the terminal page are still observed.
func collectMarkedHydration(t *testing.T, sess *Session, sub *capabilityRecorder) (pages []EntriesFrame, compactionHistory []string) {
	t.Helper()
	sess.lifecycleMu.Lock()
	sess.publishLocked(Frame{Kind: FrameState, SessionID: sess.ID()})
	sess.lifecycleMu.Unlock()
	deadline := time.After(testTimeout)
	for {
		select {
		case frame := <-sub.ch:
			switch frame.Kind {
			case FrameEntries:
				pages = append(pages, frame.Data.(EntriesFrame))
			case FrameNotice:
				if data, ok := frame.Data.(map[string]any); ok {
					if kind, _ := data["kind"].(string); kind == "compaction_history" {
						compactionHistory = append(compactionHistory, fmt.Sprint(data["text"]))
					}
				}
			case FrameState:
				return pages, compactionHistory
			}
		case <-deadline:
			t.Fatalf("timed out collecting hydration output after %d pages", len(pages))
		}
	}
}

func pageEntryIDs(t *testing.T, page EntriesFrame) []string {
	t.Helper()
	ids := make([]string, 0, len(page.Entries))
	for _, raw := range page.Entries {
		var entry struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal(raw, &entry); err != nil || entry.ID == "" {
			t.Fatalf("entry without id: %s", raw)
		}
		ids = append(ids, entry.ID)
	}
	return ids
}

func wantIDs(from, to int) []string {
	ids := make([]string, 0, to-from)
	for i := from; i < to; i++ {
		ids = append(ids, fmt.Sprintf("entry-%04d", i))
	}
	return ids
}

func TestProgressiveAttachPaintsBoundedTailThenTerminalThenHeadPages(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	store := newMemStore()
	mgr := testManager(t, client, store, 64)
	path, leafID := writeProgressiveFixture(t, t.TempDir(), "long-session.jsonl", 300, 0)

	sess, sub, detach := attachScriptedTail(t, d, mgr, store, "prog-long", path, "", leafID, true)
	defer detach()
	pages, _ := collectMarkedHydration(t, sess, sub)

	if len(pages) != 5 {
		t.Fatalf("progressive attach produced %d pages, want 5 (tail, terminal, 3 head): %+v", len(pages), pages)
	}
	tailPage, terminal := pages[0], pages[1]
	if tailPage.Final || tailPage.Segment != "" || tailPage.HistoryComplete != nil {
		t.Fatalf("bounded tail page = %+v, want non-final unsegmented without historyComplete", tailPage)
	}
	if len(tailPage.Entries) != 60 {
		t.Fatalf("bounded tail page holds %d entries, want 60", len(tailPage.Entries))
	}
	assertIDs(t, pageEntryIDs(t, tailPage), wantIDs(240, 300))
	if !terminal.Final || terminal.Segment != "" {
		t.Fatalf("terminal page = %+v, want final without segment", terminal)
	}
	if terminal.HistoryComplete == nil || *terminal.HistoryComplete {
		t.Fatalf("terminal historyComplete = %v, want explicit false while head chunks follow", terminal.HistoryComplete)
	}
	if terminal.LeafID != leafID {
		t.Fatalf("terminal leaf = %q, want disk leaf %q", terminal.LeafID, leafID)
	}
	if len(terminal.Entries) != 0 {
		t.Fatalf("terminal page holds %d entries, want empty engine tail", len(terminal.Entries))
	}
	heads := pages[2:]
	wantHeadRanges := [][2]int{{140, 240}, {40, 140}, {0, 40}}
	for i, head := range heads {
		if head.Final || head.Segment != "head" {
			t.Fatalf("head page %d = %+v, want non-final head segment", i, head)
		}
		if len(head.Entries) > 100 {
			t.Fatalf("head page %d holds %d entries, want at most 100", i, len(head.Entries))
		}
		complete := head.HistoryComplete
		if i == len(heads)-1 {
			if complete == nil || !*complete {
				t.Fatalf("final head page must set historyComplete=true: %+v", head)
			}
		} else if complete != nil {
			t.Fatalf("non-final head page %d must omit historyComplete: %+v", i, head)
		}
		assertIDs(t, pageEntryIDs(t, head), wantIDs(wantHeadRanges[i][0], wantHeadRanges[i][1]))
	}

	// Reversing the newest-first head pages and appending the bounded tail
	// must reproduce the complete branch root-to-leaf, each entry exactly once.
	var rebuilt []string
	seen := map[string]bool{}
	for i := len(heads) - 1; i >= 0; i-- {
		for _, id := range pageEntryIDs(t, heads[i]) {
			if seen[id] {
				t.Fatalf("duplicate entry %q in reconstruction", id)
			}
			seen[id] = true
			rebuilt = append(rebuilt, id)
		}
	}
	rebuilt = append(rebuilt, pageEntryIDs(t, tailPage)...)
	assertIDs(t, rebuilt, wantIDs(0, 300))
}

func TestProgressiveAttachTerminalCarriesLiveEngineTailAndLeaf(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	store := newMemStore()
	mgr := testManager(t, client, store, 64)
	path, _ := writeProgressiveFixture(t, t.TempDir(), "live-tail-session.jsonl", 300, 0)

	sess, sub, detach := attachScriptedTail(t, d, mgr, store, "prog-live", path, progressiveLiveTailEntry, "live-1", true)
	defer detach()
	pages, _ := collectMarkedHydration(t, sess, sub)

	var terminal *EntriesFrame
	before := 0
	for i := range pages {
		if pages[i].Final {
			terminal = &pages[i]
			continue
		}
		if terminal == nil && pages[i].Segment == "" {
			before += len(pages[i].Entries)
		}
	}
	if terminal == nil {
		t.Fatalf("no terminal page in progressive attach: %+v", pages)
	}
	if before != 60 {
		t.Fatalf("branch entries before terminal = %d, want 60", before)
	}
	if terminal.LeafID != "live-1" {
		t.Fatalf("terminal leaf = %q, want live engine leaf", terminal.LeafID)
	}
	assertIDs(t, pageEntryIDs(t, *terminal), []string{"live-1"})
}

func TestLegacyAttachStreamsCompleteBranchRootToLeaf(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	store := newMemStore()
	mgr := testManager(t, client, store, 64)
	path, leafID := writeProgressiveFixture(t, t.TempDir(), "legacy-session.jsonl", 300, 0)

	sess, sub, detach := attachScriptedTail(t, d, mgr, store, "legacy-long", path, "", leafID, false)
	defer detach()
	pages, _ := collectMarkedHydration(t, sess, sub)

	var stream []string
	terminals := 0
	for i, page := range pages {
		if page.Segment != "" || page.HistoryComplete != nil {
			t.Fatalf("legacy page %d carries progressive markers: %+v", i, page)
		}
		if page.Final {
			terminals++
			if i != len(pages)-1 {
				t.Fatalf("terminal page at %d of %d, want last", i, len(pages))
			}
			if page.LeafID != leafID {
				t.Fatalf("terminal leaf = %q, want disk leaf %q", page.LeafID, leafID)
			}
			if len(page.Entries) != 0 {
				t.Fatalf("terminal page holds %d entries, want empty engine tail", len(page.Entries))
			}
			continue
		}
		stream = append(stream, pageEntryIDs(t, page)...)
	}
	if terminals != 1 {
		t.Fatalf("legacy attach produced %d terminal pages, want 1", terminals)
	}
	assertIDs(t, stream, wantIDs(0, 300))
}

func TestProgressiveAttachShortBranchEmitsOneTerminalAndNoHeadPages(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	store := newMemStore()
	mgr := testManager(t, client, store, 64)
	path, leafID := writeProgressiveFixture(t, t.TempDir(), "short-session.jsonl", 3, 0)

	sess, sub, detach := attachScriptedTail(t, d, mgr, store, "prog-short", path, "", leafID, true)
	defer detach()
	pages, _ := collectMarkedHydration(t, sess, sub)

	terminals := 0
	for i, page := range pages {
		if page.Segment != "" {
			t.Fatalf("short-branch page %d carries head markers: %+v", i, page)
		}
		if page.Final {
			terminals++
			if len(page.Entries) != 0 || page.LeafID != leafID {
				t.Fatalf("terminal page = %+v, want empty tail with disk leaf", page)
			}
			if page.HistoryComplete == nil || !*page.HistoryComplete {
				t.Fatalf("short-branch terminal historyComplete = %v, want explicit true (tail begins at the root)", page.HistoryComplete)
			}
		} else if page.HistoryComplete != nil {
			t.Fatalf("non-terminal page %d carries historyComplete: %+v", i, page)
		}
	}
	if terminals != 1 {
		t.Fatalf("short-branch attach produced %d terminal pages, want 1", terminals)
	}
	if len(pages) != 2 {
		t.Fatalf("short-branch attach produced %d pages, want 2 (3-entry page, terminal): %+v", len(pages), pages)
	}
}

func TestCompactionHistoryCountIdenticalForLegacyAndProgressiveAttach(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	store := newMemStore()
	mgr := testManager(t, client, store, 64)
	dir := t.TempDir()
	path, leafID := writeProgressiveFixture(t, dir, "compaction-session.jsonl", 120, 0, 10, 70)

	legacySess, legacySub, legacyDetach := attachScriptedTail(t, d, mgr, store, "compact-legacy", path, "", leafID, false)
	defer legacyDetach()
	_, legacyNotices := collectMarkedHydration(t, legacySess, legacySub)

	progSess, progSub, progDetach := attachScriptedTail(t, d, mgr, store, "compact-prog", path, "", leafID, true)
	defer progDetach()
	_, progNotices := collectMarkedHydration(t, progSess, progSub)

	if len(legacyNotices) != 1 || len(progNotices) != 1 {
		t.Fatalf("compaction history notices: legacy %v progressive %v, want one each", legacyNotices, progNotices)
	}
	if legacyNotices[0] != progNotices[0] {
		t.Fatalf("compaction history diverged: legacy %q progressive %q", legacyNotices[0], progNotices[0])
	}
	if legacyNotices[0] != "Session compacted 2 times" {
		t.Fatalf("compaction history = %q, want complete-branch count", legacyNotices[0])
	}
}

func branchIndexOf(t *testing.T, id string) int {
	t.Helper()
	n, err := strconv.Atoi(strings.TrimPrefix(id, "entry-"))
	if err != nil {
		t.Fatalf("entry id %q has no branch index", id)
	}
	return n
}

// writeProgressiveSizedFixture writes a linear active branch whose message
// bodies vary by branch index, so a fixture can grow exactly the entries
// that must push a backward range past the reader's own page-byte budget
// while the rest of the branch stays small.
func writeProgressiveSizedFixture(t *testing.T, dir, name string, entries int, padFor func(int) int) (path, leafID string) {
	t.Helper()
	path = filepath.Join(dir, name)
	sum := sha256.Sum256([]byte(path))
	durableID := "durable-" + hex.EncodeToString(sum[:4]) + "-7d24-4b1e-resume"
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	writer := bufio.NewWriterSize(file, 64<<10)
	encoder := json.NewEncoder(writer)
	if err := encoder.Encode(map[string]any{
		"type": "session", "version": 3, "id": durableID,
		"timestamp": "2026-09-16T00:00:00.000Z", "cwd": dir,
	}); err != nil {
		t.Fatal(err)
	}
	parent := any(nil)
	for i := 0; i < entries; i++ {
		id := fmt.Sprintf("entry-%04d", i)
		entry := map[string]any{
			"type": "message", "id": id, "parentId": parent,
			"timestamp": "2026-09-16T00:00:01.000Z",
			"message": map[string]any{
				"role":    "user",
				"content": []any{map[string]any{"type": "text", "text": strings.Repeat("x", padFor(i))}},
			},
		}
		if err := encoder.Encode(entry); err != nil {
			t.Fatal(err)
		}
		parent, leafID = id, id
	}
	if err := writer.Flush(); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	return path, leafID
}

// TestProgressiveHeadPagesStayNewestFirstAcrossReaderPageSplits pins the
// second page boundary: the history reader itself splits one backward warm
// range across several callbacks once the range's entries exceed its own
// page-byte budget (4MiB by default; a single line stays under that cap).
// Head pages must remain strictly newest-first across those callbacks too,
// and historyComplete may land only on the final head page, the one that
// starts at branch index 0. The byte-budget split inside a callback is
// already covered above with 4KiB bodies; these fixtures cross the reader's
// own budget, which the 4KiB bodies never reach.
func TestProgressiveHeadPagesStayNewestFirstAcrossReaderPageSplits(t *testing.T) {
	mib := 1 << 20
	cases := []struct {
		name    string
		entries int
		padFor  func(int) int
	}{
		{
			// The two 3MiB root entries push the final root-reaching range
			// (2 entries, ~6MiB) past the reader's page budget, so the reader
			// emits that one range as one callback per entry.
			name:    "final head range splits across reader callbacks",
			entries: 62,
			padFor: func(i int) int {
				if i < 2 {
					return 3 * mib
				}
				return 1 << 10
			},
		},
		{
			// 50KiB bodies push a full 100-entry warm range past the same
			// budget, splitting mid-range instead of at the branch root.
			name:    "interior warm range splits across reader callbacks",
			entries: 162,
			padFor:  func(int) int { return 50 << 10 },
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			d := newDaemon(t)
			client := dial(t, d)
			store := newMemStore()
			mgr := testManager(t, client, store, 64)
			path, leafID := writeProgressiveSizedFixture(t, t.TempDir(), "reader-split-session.jsonl", tc.entries, tc.padFor)

			sess, sub, detach := attachScriptedTail(t, d, mgr, store, "prog-reader-split", path, "", leafID, true)
			defer detach()
			pages, _ := collectMarkedHydration(t, sess, sub)

			var tailIDs []string
			var terminal *EntriesFrame
			var heads []EntriesFrame
			for i := range pages {
				if pages[i].Final {
					terminal = &pages[i]
					continue
				}
				if pages[i].Segment == "head" {
					heads = append(heads, pages[i])
					continue
				}
				tailIDs = append(tailIDs, pageEntryIDs(t, pages[i])...)
			}
			if terminal == nil {
				t.Fatalf("no terminal page: %+v", pages)
			}
			assertIDs(t, tailIDs, wantIDs(tc.entries-60, tc.entries))
			if terminal.HistoryComplete == nil || *terminal.HistoryComplete {
				t.Fatalf("terminal historyComplete = %v, want explicit false while head chunks follow", terminal.HistoryComplete)
			}
			warmRanges := (tc.entries - 60 + 99) / 100
			if len(heads) <= warmRanges {
				t.Fatalf("%d head pages for %d warm ranges, fixture must split ranges across pages", len(heads), warmRanges)
			}

			for k, page := range heads {
				ids := pageEntryIDs(t, page)
				if len(ids) == 0 {
					t.Fatalf("head page %d is empty", k)
				}
				// Within one wire page entries ascend branch order.
				first, last := branchIndexOf(t, ids[0]), branchIndexOf(t, ids[len(ids)-1])
				for j := 1; j < len(ids); j++ {
					if branchIndexOf(t, ids[j]) != first+j {
						t.Fatalf("head page %d is not contiguous ascending branch order: %v", k, ids)
					}
				}
				// The next head page must be strictly older: its last entry
				// directly precedes this page's first entry, page by page.
				if k > 0 {
					prevIDs := pageEntryIDs(t, heads[k-1])
					if want := branchIndexOf(t, prevIDs[0]); last+1 != want {
						t.Fatalf("head page %d covers [%d..%d], but page %d starts at %d: not strictly newest-first", k, first, last, k-1, want)
					}
				}
				if k < len(heads)-1 && page.HistoryComplete != nil {
					t.Fatalf("non-final head page %d carries historyComplete: %+v", k, page)
				}
			}
			finalIDs := pageEntryIDs(t, heads[len(heads)-1])
			if got := branchIndexOf(t, finalIDs[0]); got != 0 {
				t.Fatalf("final head page starts at branch index %d, want 0 (root)", got)
			}
			if page := heads[len(heads)-1]; page.HistoryComplete == nil || !*page.HistoryComplete {
				t.Fatalf("final head page historyComplete = %v, want true", page.HistoryComplete)
			}

			// Prepending each head page in arrival order still rebuilds the branch.
			var rebuilt []string
			for i := len(heads) - 1; i >= 0; i-- {
				rebuilt = append(rebuilt, pageEntryIDs(t, heads[i])...)
			}
			rebuilt = append(rebuilt, tailIDs...)
			assertIDs(t, rebuilt, wantIDs(0, tc.entries))
		})
	}
}

// TestProgressiveHeadPagesStayStrictlyNewestFirstWhenRangesSplit pins the
// wire invariant a prepend-style client depends on: every successive head
// page is strictly older than the one before it, page by page, even when the
// 256KiB/100-entry page bounds split one backward warm range into several
// wire pages - and the final head page is the one starting at branch index 0.
func TestProgressiveHeadPagesStayStrictlyNewestFirstWhenRangesSplit(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	store := newMemStore()
	mgr := testManager(t, client, store, 64)
	// 4KiB bodies force the byte budget to split each 100-entry backward
	// range (and the final root-reaching range) into several wire pages.
	path, leafID := writeProgressiveFixture(t, t.TempDir(), "padded-session.jsonl", 350, 4<<10)

	sess, sub, detach := attachScriptedTail(t, d, mgr, store, "prog-padded", path, "", leafID, true)
	defer detach()
	pages, _ := collectMarkedHydration(t, sess, sub)

	var tailIDs []string
	var terminal *EntriesFrame
	var heads []EntriesFrame
	for i := range pages {
		if pages[i].Final {
			terminal = &pages[i]
			continue
		}
		if pages[i].Segment == "head" {
			heads = append(heads, pages[i])
			continue
		}
		tailIDs = append(tailIDs, pageEntryIDs(t, pages[i])...)
	}
	if terminal == nil {
		t.Fatalf("no terminal page: %+v", pages)
	}
	assertIDs(t, tailIDs, wantIDs(290, 350))
	if terminal.LeafID != leafID {
		t.Fatalf("terminal leaf = %q, want disk leaf %q", terminal.LeafID, leafID)
	}
	if terminal.HistoryComplete == nil || *terminal.HistoryComplete {
		t.Fatalf("terminal historyComplete = %v, want explicit false while head chunks follow", terminal.HistoryComplete)
	}

	// 290 earlier entries in 100-entry ranges = 3 ranges; each must have
	// been split into several wire pages by the byte budget.
	if len(heads) <= 3 {
		t.Fatalf("%d head pages, want more than one page per backward range (fixture must split ranges)", len(heads))
	}
	for k, page := range heads {
		ids := pageEntryIDs(t, page)
		if len(ids) < 2 {
			t.Fatalf("head page %d holds %d entries, fixture must produce multi-entry pages", k, len(ids))
		}
		// Within one wire page entries ascend branch order.
		first, last := branchIndexOf(t, ids[0]), branchIndexOf(t, ids[len(ids)-1])
		for j := 1; j < len(ids); j++ {
			if branchIndexOf(t, ids[j]) != first+j {
				t.Fatalf("head page %d is not contiguous ascending branch order: %v", k, ids)
			}
		}
		// The next head page must be strictly older: its last entry directly
		// precedes this page's first entry.
		if k > 0 {
			prev := heads[k-1]
			prevIDs := pageEntryIDs(t, prev)
			want := branchIndexOf(t, prevIDs[0])
			if last+1 != want {
				t.Fatalf("head page %d covers [%d..%d], but page %d starts at %d: not strictly newest-first", k, first, last, k-1, want)
			}
		}
		if k < len(heads)-1 && page.HistoryComplete != nil {
			t.Fatalf("non-final head page %d carries historyComplete: %+v", k, page)
		}
	}
	// The final head page starts at the branch root and is the completion page.
	finalIDs := pageEntryIDs(t, heads[len(heads)-1])
	if got := branchIndexOf(t, finalIDs[0]); got != 0 {
		t.Fatalf("final head page starts at branch index %d, want 0 (root)", got)
	}
	if page := heads[len(heads)-1]; page.HistoryComplete == nil || !*page.HistoryComplete {
		t.Fatalf("final head page historyComplete = %v, want true", page.HistoryComplete)
	}

	// Prepending each head page in arrival order still rebuilds the branch.
	var rebuilt []string
	for i := len(heads) - 1; i >= 0; i-- {
		rebuilt = append(rebuilt, pageEntryIDs(t, heads[i])...)
	}
	rebuilt = append(rebuilt, tailIDs...)
	assertIDs(t, rebuilt, wantIDs(0, 350))
}
