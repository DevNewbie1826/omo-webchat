package chat

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

// decodeAll runs the streaming reader over input and returns the emitted events,
// mirroring how Process.Events surfaces a fatal decode error.
func decodeAll(t *testing.T, input string) []Event {
	t.Helper()
	dec := json.NewDecoder(strings.NewReader(input))
	out := make(chan Event, 256)
	var got []Event
	done := make(chan struct{})
	go func() {
		for ev := range out {
			got = append(got, ev)
		}
		close(done)
	}()
	if err := (&Process{}).readFrames(dec, out); err != nil {
		if msg, merr := json.Marshal(err.Error()); merr == nil {
			out <- Event{Type: "decode_error", Raw: msg}
		}
	}
	close(out)
	<-done
	return got
}

func TestStreamFrames_NonResponseReconstructs(t *testing.T) {
	// A non-response frame (varied shape) reconstructs losslessly for downstream.
	got := decodeAll(t, `{"type":"message_update","messageId":"m1","delta":{"kind":"text_delta","delta":"hi"}}`)
	if len(got) != 1 || got[0].Type != "message_update" {
		t.Fatalf("events = %+v", got)
	}
	var parsed struct {
		Type      string `json:"type"`
		MessageID string `json:"messageId"`
		Delta     struct {
			Delta string `json:"delta"`
		} `json:"delta"`
	}
	if err := json.Unmarshal(got[0].Raw, &parsed); err != nil {
		t.Fatalf("reconstructed raw did not parse: %v", err)
	}
	if parsed.MessageID != "m1" || parsed.Delta.Delta != "hi" {
		t.Fatalf("reconstructed fields lost: %+v", parsed)
	}
}

func TestStreamFrames_SequentialAndCRLF(t *testing.T) {
	// Multiple frames separated by CRLF; both reconstruct.
	got := decodeAll(t, "{\"type\":\"state\",\"isStreaming\":false}\r\n{\"type\":\"models\",\"models\":[]}\r\n")
	if len(got) != 2 || got[0].Type != "state" || got[1].Type != "models" {
		t.Fatalf("events = %+v", got)
	}
}

func TestStreamFrames_UnicodeSeparatorsPreserved(t *testing.T) {
	// U+2028/U+2029 inside a JSON string must survive reconstruction.
	const ls, ps = "\u2028", "\u2029"
	got := decodeAll(t, `{"type":"message_update","text":"before`+ls+`after`+ps+`done"}`)
	if len(got) != 1 {
		t.Fatalf("events = %+v", got)
	}
	var parsed struct {
		Text string `json:"text"`
	}
	if err := json.Unmarshal(got[0].Raw, &parsed); err != nil {
		t.Fatalf("parse: %v", err)
	}
	if parsed.Text != "before"+ls+"after"+ps+"done" {
		t.Fatalf("unicode separators corrupted: %q", parsed.Text)
	}
}

func TestStreamFrames_GetEntriesStreamed(t *testing.T) {
	got := decodeAll(t, getEntriesJSON(5, 10, "leaf-5"))
	pages, responses, total, finalCount := 0, 0, 0, 0
	var leafID string
	for _, ev := range got {
		switch ev.Type {
		case "entries.stream":
			pages++
			total += len(ev.Page)
			if ev.Final {
				finalCount++
				leafID = ev.LeafID
			}
		case "response":
			responses++
		}
	}
	if responses != 0 {
		t.Fatalf("streamed get_entries emitted a redundant response frame: %+v", got)
	}
	if pages == 0 || total != 5 || finalCount != 1 || leafID != "leaf-5" {
		t.Fatalf("pages=%d total=%d final=%d leaf=%q", pages, total, finalCount, leafID)
	}
}

func TestStreamFrames_GetEntriesExceedsOldLineCap(t *testing.T) {
	// >16 MiB of entries: the old LineReader failed with errLineTooLong; the
	// streaming reader must deliver every entry with bounded pages.
	const n, entrySize = 20000, 1000 // ~20 MiB
	got := decodeAll(t, getEntriesJSON(n, entrySize, "leaf-big"))
	total, finalCount, leafID := 0, 0, ""
	for _, ev := range got {
		if ev.Type != "entries.stream" {
			continue
		}
		total += len(ev.Page)
		if ev.Final {
			finalCount++
			leafID = ev.LeafID
		}
	}
	if total != n {
		t.Fatalf("streamed %d entries, want %d", total, n)
	}
	if finalCount != 1 || leafID != "leaf-big" {
		t.Fatalf("finalCount=%d leaf=%q", finalCount, leafID)
	}
}

func TestStreamFrames_FailedGetEntriesNotStreamed(t *testing.T) {
	// A failed get_entries (success:false, no data) is reconstructed as a normal
	// response so forwardResponse surfaces the error — it is NOT streamed.
	got := decodeAll(t, `{"id":"r1","type":"response","command":"get_entries","success":false,"error":"boom"}`)
	if len(got) != 1 || got[0].Type != "response" {
		t.Fatalf("events = %+v", got)
	}
	var resp struct {
		Command string `json:"command"`
		Success bool   `json:"success"`
		Error   string `json:"error"`
	}
	if err := json.Unmarshal(got[0].Raw, &resp); err != nil {
		t.Fatalf("parse: %v", err)
	}
	if resp.Success || resp.Command != "get_entries" || resp.Error != "boom" {
		t.Fatalf("failed get_entries not preserved: %+v", resp)
	}
}

func TestStreamFrames_MalformedIsFatal(t *testing.T) {
	// Malformed JSON cannot be resynchronized by a streaming decoder; it surfaces
	// a single decode_error and stops (the provider connection is corrupt).
	got := decodeAll(t, `{"type":"response","command":"get_state","success":true,"data":{}}`+"\n"+`{not valid json`)
	if len(got) != 2 || got[1].Type != "decode_error" {
		t.Fatalf("expected the good frame then a decode_error, got %+v", got)
	}
}

func getEntriesJSON(n, entrySize int, leafID string) string {
	payload := strings.Repeat("x", entrySize)
	var b strings.Builder
	b.WriteString(`{"id":"r1","type":"response","command":"get_entries","success":true,"data":{"entries":[`)
	for i := range n {
		if i > 0 {
			b.WriteByte(',')
		}
		fmt.Fprintf(&b, `{"id":"e%d","type":"message","message":{"role":"user","content":"%s"}}`, i, payload)
	}
	b.WriteString(`],"leafId":"`)
	b.WriteString(leafID)
	b.WriteString(`"}}`)
	return b.String()
}

func TestStreamFrames_MalformedOuterTailSuppressesTerminal(t *testing.T) {
	// A get_entries response whose outer object never closes must NOT emit a
	// terminal entries page: the malformed frame surfaces a fatal decode error
	// instead of marking an incomplete history as fully loaded.
	body := `{"id":"r1","type":"response","command":"get_entries","success":true,"data":{"entries":[{"id":"e1","type":"message","message":{"role":"user","content":"x"}}],"leafId":"l"}}`
	got := decodeAll(t, body[:len(body)-1]) // drop the trailing outer '}'
	finalCount, decodeErr := 0, false
	for _, ev := range got {
		if ev.Type == "entries.stream" && ev.Final {
			finalCount++
		}
		if ev.Type == "decode_error" {
			decodeErr = true
		}
	}
	if finalCount != 0 {
		t.Fatalf("emitted %d terminal pages on a malformed outer tail; want 0", finalCount)
	}
	if !decodeErr {
		t.Fatalf("expected a fatal decode_error for the malformed tail; events: %+v", got)
	}
}

func TestStreamFrames_FailedGetEntriesWithDataNotStreamed(t *testing.T) {
	// success:false WITH a data object must NOT be streamed (that would suppress
	// the provider error); it reconstructs as a normal response for forwardResponse.
	got := decodeAll(t, `{"id":"r1","type":"response","command":"get_entries","success":false,"error":"boom","data":{"entries":[],"leafId":null}}`)
	if len(got) != 1 || got[0].Type != "response" {
		t.Fatalf("events = %+v", got)
	}
	var resp struct {
		Success bool   `json:"success"`
		Error   string `json:"error"`
	}
	if err := json.Unmarshal(got[0].Raw, &resp); err != nil {
		t.Fatalf("parse: %v", err)
	}
	if resp.Success || resp.Error != "boom" {
		t.Fatalf("failed get_entries with data not preserved as error: %+v", resp)
	}
}

func TestStreamFrames_CompositeLeafIdDoesNotDesync(t *testing.T) {
	// A malformed composite leafId must not desync the Decoder into a premature
	// terminal; the full value is consumed and the response completes cleanly.
	got := decodeAll(t, `{"id":"r1","type":"response","command":"get_entries","success":true,"data":{"entries":[{"id":"e1","type":"message","message":{"role":"user","content":"x"}}],"leafId":{"weird":true}}}`)
	finalCount, total, decodeErr := 0, 0, false
	for _, ev := range got {
		if ev.Type == "entries.stream" {
			total += len(ev.Page)
			if ev.Final {
				finalCount++
			}
		}
		if ev.Type == "decode_error" {
			decodeErr = true
		}
	}
	if decodeErr {
		t.Fatalf("composite leafId desynced the decoder: %+v", got)
	}
	if total != 1 || finalCount != 1 {
		t.Fatalf("total=%d final=%d (composite leafId must not corrupt the stream)", total, finalCount)
	}
}
