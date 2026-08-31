package chat

import "encoding/json"

// Entries history is delivered as one or more WebSocket frames. A single
// get_entries response is chunked so no frame approaches gws
// WriteMaxPayloadSize (16 MiB, equal to the provider line cap in framing.go).
// The streamed path (deliverStreamedPage) holds Final=false on every frame
// except the terminal page, so the client buffers and reconciles once. The pump
// runs on one goroutine, so frames are written back-to-back and arrive in order.
const (
	entriesPageMaxBytes = 256 << 10
	entriesPageMaxCount = 100
)

func chunkEntries(arr []json.RawMessage) [][]json.RawMessage {
	if len(arr) == 0 {
		return nil
	}
	pages := make([][]json.RawMessage, 0, len(arr)/entriesPageMaxCount+1)
	var current []json.RawMessage
	currentBytes := 0
	flush := func() {
		if len(current) > 0 {
			pages = append(pages, current)
			current = nil
			currentBytes = 0
		}
	}
	for _, entry := range arr {
		size := len(entry)
		if len(current) >= entriesPageMaxCount || (len(current) > 0 && currentBytes+size > entriesPageMaxBytes) {
			flush()
		}
		current = append(current, entry)
		currentBytes += size
	}
	flush()
	return pages
}

// sendEntriesPaged emits entries as one or more frames; the last chunk of the
// delivery carries Final=true, and leafID is attached to the terminal frame.
func (s *Session) sendEntriesPaged(entries []json.RawMessage, leafID string) {
	if len(entries) == 0 {
		frame := &EntriesFrame{Type: "entries", SessionID: s.id, Entries: []byte("[]"), Final: true}
		frame.LeafID = leafID
		s.send(frame)
		return
	}
	totalBytes := 0
	for _, entry := range entries {
		totalBytes += len(entry)
	}
	if len(entries) <= entriesPageMaxCount && totalBytes <= entriesPageMaxBytes {
		merged, _ := json.Marshal(entries)
		frame := &EntriesFrame{Type: "entries", SessionID: s.id, Entries: merged, Final: true}
		frame.LeafID = leafID
		s.send(frame)
		return
	}
	pages := chunkEntries(entries)
	for index, page := range pages {
		pageJSON, _ := json.Marshal(page)
		isLast := index == len(pages)-1
		frame := &EntriesFrame{Type: "entries", SessionID: s.id, Entries: pageJSON, Final: isLast}
		if isLast {
			frame.LeafID = leafID
		}
		s.send(frame)
	}
}

// deliverStreamedPage forwards one bounded omo get_entries page emitted by the
// streaming reader (process_stream.go). Pages arrive already chunked to the
// entries limits; the terminal page (final == true) carries the leafId and
// completes the delivery, matching the contract sendEntriesPaged produces.
func (s *Session) deliverStreamedPage(page []json.RawMessage, leafID string, final bool) {
	pageJSON, _ := json.Marshal(page)
	frame := &EntriesFrame{Type: "entries", SessionID: s.id, Entries: pageJSON, Final: final}
	if final {
		frame.LeafID = leafID
	}
	s.send(frame)
}
