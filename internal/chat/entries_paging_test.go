package chat

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"
)

func entryJSON(i int, body string) []byte {
	b, _ := json.Marshal(map[string]any{
		"id":   fmt.Sprintf("e-%d", i),
		"type": "message",
		"message": map[string]any{
			"role":    "user",
			"content": body,
		},
	})
	return b
}

func entriesPayload(n int, body string) []json.RawMessage {
	out := make([]json.RawMessage, n)
	for i := 0; i < n; i++ {
		out[i] = entryJSON(i, body)
	}
	return out
}

func TestSendEntriesMalformedDataCompletesHistory(t *testing.T) {
	w := newCollectWriter()
	s := newTestSession("chat-1", w)
	data := `{"type":"response","command":"get_entries","success":true,"data":{"entries":[],"leafId":123}}`
	s.forwardResponse([]byte(data))

	frames := w.waitForType(t, "entries", 2*time.Second)
	if len(frames) != 1 {
		t.Fatalf("entries frames = %d, want 1 terminal frame for malformed data", len(frames))
	}
	var ef EntriesFrame
	if json.Unmarshal(frames[0], &ef) != nil {
		t.Fatalf("failed to unmarshal entries frame")
	}
	if !ef.Final {
		t.Fatalf("malformed-data frame Final = false, want true")
	}
	var page []json.RawMessage
	if json.Unmarshal(ef.Entries, &page) != nil || len(page) != 0 {
		t.Fatalf("malformed-data entries = %s, want []", string(ef.Entries))
	}
}

func TestChunkEntriesCountBound(t *testing.T) {
	// 250 small entries: byte sum is tiny, so paging is driven by the count cap.
	arr := entriesPayload(250, "x")
	pages := chunkEntries(arr)
	if len(pages) < 3 {
		t.Fatalf("pages = %d, want >= 3 (count cap = %d)", len(pages), entriesPageMaxCount)
	}
	for i, p := range pages {
		if len(p) > entriesPageMaxCount {
			t.Fatalf("page %d has %d entries, want <= %d", i, len(p), entriesPageMaxCount)
		}
	}
	total := 0
	for _, p := range pages {
		total += len(p)
	}
	if total != 250 {
		t.Fatalf("reconstructed count = %d, want 250", total)
	}
}

func TestChunkEntriesByteBound(t *testing.T) {
	// Each entry ~200 KiB: two together exceed the 256 KiB budget, so each page
	// holds exactly one even though the count cap is far from reached.
	body := make([]byte, 200*1024)
	for i := range body {
		body[i] = 'a'
	}
	arr := entriesPayload(3, string(body))
	pages := chunkEntries(arr)
	if len(pages) != 3 {
		t.Fatalf("pages = %d, want 3 (byte budget forces one entry per page)", len(pages))
	}
	for _, p := range pages {
		sum := 0
		for _, e := range p {
			sum += len(e)
		}
		if sum > entriesPageMaxBytes {
			t.Fatalf("page byte sum = %d, want <= %d", sum, entriesPageMaxBytes)
		}
	}
}

func TestChunkEntriesOversizedEntryOwnPage(t *testing.T) {
	// A single entry larger than the byte budget becomes its own page rather
	// than being dropped or split.
	body := make([]byte, entriesPageMaxBytes+4096)
	for i := range body {
		body[i] = 'b'
	}
	pages := chunkEntries([]json.RawMessage{entryJSON(0, string(body))})
	if len(pages) != 1 || len(pages[0]) != 1 {
		t.Fatalf("pages = %v, want one page holding the single oversized entry", pages)
	}
}

func TestSendEntriesPagedLargePayloadSplit(t *testing.T) {
	w := newCollectWriter()
	s := newTestSession("chat-1", w)

	arr := entriesPayload(250, "payload-body")
	rawEntries, _ := json.Marshal(arr)
	data := fmt.Sprintf(`{"type":"response","command":"get_entries","success":true,"data":{"entries":%s,"leafId":"leaf-final"}}`, string(rawEntries))
	s.forwardResponse([]byte(data))

	frames := w.waitForType(t, "entries", 2*time.Second)
	if len(frames) < 2 {
		t.Fatalf("entries frames = %d, want >= 2 for a payload over the page budget", len(frames))
	}

	var parsed []EntriesFrame
	for _, f := range frames {
		var ef EntriesFrame
		if json.Unmarshal(f, &ef) == nil && ef.Type == "entries" {
			parsed = append(parsed, ef)
		}
	}
	if len(parsed) < 2 {
		t.Fatalf("parsed entries frames = %d, want >= 2", len(parsed))
	}

	finalCount := 0
	leafCount := 0
	reconstructed := 0
	for i, ef := range parsed {
		if ef.Final {
			finalCount++
		}
		if ef.LeafID != "" {
			leafCount++
		}
		var page []json.RawMessage
		if json.Unmarshal(ef.Entries, &page) != nil {
			t.Fatalf("page %d entries are not a JSON array", i)
		}
		if len(page) > entriesPageMaxCount {
			t.Fatalf("page %d has %d entries, want <= %d", i, len(page), entriesPageMaxCount)
		}
		reconstructed += len(page)
	}
	if finalCount != 1 {
		t.Fatalf("final pages = %d, want exactly 1", finalCount)
	}
	if leafCount != 1 {
		t.Fatalf("pages carrying leafId = %d, want exactly 1 (final only)", leafCount)
	}
	if parsed[len(parsed)-1].LeafID != "leaf-final" {
		t.Fatalf("final page leafId = %q, want leaf-final", parsed[len(parsed)-1].LeafID)
	}
	if reconstructed != 250 {
		t.Fatalf("reconstructed entry count = %d, want 250", reconstructed)
	}
	// Non-final pages must signal more-pages (Final false -> omitted in JSON, so
	// the field reads false after unmarshal).
	for _, ef := range parsed[:len(parsed)-1] {
		if ef.Final {
			t.Fatalf("non-final page has Final=true")
		}
		if ef.LeafID != "" {
			t.Fatalf("non-final page carries leafId %q", ef.LeafID)
		}
	}
}

func TestSendEntriesPagedEmptyOversizedArray(t *testing.T) {
	w := newCollectWriter()
	s := newTestSession("chat-1", w)
	// A valid empty array inflated past the byte budget must still complete with
	// a single Final frame; chunkEntries returns no pages for an empty slice.
	data := `{"type":"response","command":"get_entries","success":true,"data":{"entries":[` + strings.Repeat(" ", entriesPageMaxBytes+1024) + `],"leafId":"leaf"}}`
	s.forwardResponse([]byte(data))

	frames := w.waitForType(t, "entries", 2*time.Second)
	if len(frames) != 1 {
		t.Fatalf("entries frames = %d, want 1 for an empty oversized array", len(frames))
	}
	var ef EntriesFrame
	if json.Unmarshal(frames[0], &ef) != nil {
		t.Fatalf("failed to unmarshal entries frame")
	}
	if !ef.Final {
		t.Fatalf("empty oversized array Final = false, want true")
	}
	if ef.LeafID != "leaf" {
		t.Fatalf("leafId = %q, want leaf", ef.LeafID)
	}
}

func TestSendEntriesPagedSmallPayloadSingleFrame(t *testing.T) {
	w := newCollectWriter()
	s := newTestSession("chat-1", w)

	data := `{"type":"response","command":"get_entries","success":true,"data":{"entries":[{"role":"user","content":"hi"}],"leafId":"leaf-1"}}`
	s.forwardResponse([]byte(data))

	frames := w.waitForType(t, "entries", 2*time.Second)
	if len(frames) != 1 {
		t.Fatalf("entries frames = %d, want 1 for a small payload", len(frames))
	}
	var ef EntriesFrame
	if json.Unmarshal(frames[0], &ef) != nil {
		t.Fatalf("failed to unmarshal entries frame")
	}
	if !ef.Final {
		t.Fatalf("small payload Final = false, want true")
	}
	if ef.LeafID != "leaf-1" {
		t.Fatalf("leafId = %q, want leaf-1", ef.LeafID)
	}
}
