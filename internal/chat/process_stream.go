package chat

import (
	"encoding/json"
	"fmt"
	"io"
)

// readFrames reads provider frames from dec until EOF, emitting one or more
// Events per frame to out. A omo get_entries response is token-streamed into
// bounded "entries.stream" page events so a multi-hundred-MB history never
// materializes in full (each entry is decoded once and released).
//
// A JSON decode error is fatal: unlike the prior line reader (which could drop
// one malformed line and continue), a streaming Decoder cannot resynchronize
// mid-value, so a corrupt provider stream terminates the pump. The returned
// error is surfaced to the client as a decode_failed frame before the session
// is torn down.
func (p *Process) readFrames(dec *json.Decoder, out chan<- Event) error {
	for {
		tok, err := dec.Token()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return fmt.Errorf("chat: decode frame start: %w", err)
		}
		delim, ok := tok.(json.Delim)
		if !ok || delim != '{' {
			return fmt.Errorf("chat: expected frame object, got %q", tok)
		}
		if err := readFrameObject(dec, out); err != nil {
			return err
		}
	}
}

// readFrameObject consumes one top-level JSON object. Every field is captured as
// a json.RawMessage so frames of any shape (response, message_update, tool,
// agent_end, ...) reconstruct losslessly for the existing raw-consuming
// handlers. The one exception is a SUCCESSFUL omo get_entries: when type,
// command, and success are already known, its data object is streamed instead of
// captured. omo emits type/command/success before data, so the streaming
// branch is reached with all three set; a failed get_entries (success:false) is
// reconstructed so forwardResponse surfaces the provider error.
//
// The streamed terminal page is held and emitted only after the outer response
// object closes, so a malformed trailing frame surfaces a fatal decode error
// rather than marking an incomplete history as fully loaded.
func readFrameObject(dec *json.Decoder, out chan<- Event) error {
	fields := make(map[string]json.RawMessage)
	var typ, command, sessionID, requestID string
	success := false
	streamed := false
	var terminalPage []json.RawMessage
	var terminalLeafID string
	for dec.More() {
		keyTok, err := dec.Token()
		if err != nil {
			return fmt.Errorf("chat: decode field key: %w", err)
		}
		key, ok := keyTok.(string)
		if !ok {
			return fmt.Errorf("chat: non-string field key %q", keyTok)
		}
		if key == "data" && typ == "response" && command == "get_entries" && success {
			last, leafID, err := streamEntries(dec, out, sessionID, requestID)
			if err != nil {
				return err
			}
			streamed = true
			terminalPage = last
			terminalLeafID = leafID
			continue
		}
		var val json.RawMessage
		if err := dec.Decode(&val); err != nil {
			return fmt.Errorf("chat: decode field %q: %w", key, err)
		}
		fields[key] = val
		switch key {
		case "type":
			typ = rawString(val)
		case "command":
			command = rawString(val)
		case "success":
			success = rawBool(val)
		case "sessionId":
			sessionID = rawString(val)
		case "id":
			requestID = rawString(val)
		}
	}
	if _, err := dec.Token(); err != nil { // closing '}'
		return fmt.Errorf("chat: decode frame end: %w", err)
	}
	if streamed {
		out <- Event{Type: "entries.stream", Page: terminalPage, LeafID: terminalLeafID, Final: true, SessionID: sessionID, RequestID: requestID}
		return nil
	}
	raw, err := json.Marshal(fields)
	if err != nil {
		return fmt.Errorf("chat: reconstruct frame: %w", err)
	}
	out <- Event{Type: typ, Raw: raw}
	return nil
}

// streamEntries consumes a omo get_entries data object ({entries:[...],
// leafId}), emitting bounded non-final "entries.stream" page events as it fills.
// It returns the final (possibly partial) page and leafID WITHOUT emitting them,
// so the caller can emit the terminal page only after the outer response object
// has been validated. omo entries are already {id,type,message} envelopes, so
// they flow through the existing paging path unchanged.
func streamEntries(dec *json.Decoder, out chan<- Event, sessionID, requestID string) (page []json.RawMessage, leafID string, err error) {
	open, derr := dec.Token()
	if derr != nil {
		return nil, "", fmt.Errorf("chat: decode data object: %w", derr)
	}
	if d, ok := open.(json.Delim); !ok || d != '{' {
		return nil, "", fmt.Errorf("chat: expected data object, got %q", open)
	}
	page = make([]json.RawMessage, 0, entriesPageMaxCount)
	pageBytes := 0
	emitPage := func() {
		out <- Event{Type: "entries.stream", Page: page, Final: false, SessionID: sessionID, RequestID: requestID}
		page = make([]json.RawMessage, 0, entriesPageMaxCount)
		pageBytes = 0
	}
	for dec.More() {
		keyTok, kerr := dec.Token()
		if kerr != nil {
			return nil, "", fmt.Errorf("chat: decode data key: %w", kerr)
		}
		switch keyTok.(string) {
		case "entries":
			if aerr := streamEntriesArray(dec, &page, &pageBytes, emitPage); aerr != nil {
				return nil, "", aerr
			}
		case "leafId":
			got, lerr := decodeStringField(dec)
			if lerr != nil {
				return nil, "", fmt.Errorf("chat: decode leafId: %w", lerr)
			}
			leafID = got
		default:
			var skip json.RawMessage
			if serr := dec.Decode(&skip); serr != nil {
				return nil, "", fmt.Errorf("chat: decode data field %q: %w", keyTok, serr)
			}
		}
	}
	if _, derr := dec.Token(); derr != nil { // '}' close data
		return nil, "", fmt.Errorf("chat: decode data end: %w", derr)
	}
	return page, leafID, nil
}

// streamEntriesArray decodes the entries array element-by-element into page,
// emitting a non-final page via emit whenever page fills. A page is flushed
// BEFORE an entry that would cross the byte limit (matching chunkEntries), so no
// page exceeds the budget by more than one individually-oversized entry; memory
// stays bounded regardless of array size.
func streamEntriesArray(dec *json.Decoder, page *[]json.RawMessage, pageBytes *int, emit func()) error {
	open, err := dec.Token()
	if err != nil {
		return fmt.Errorf("chat: decode entries array: %w", err)
	}
	if d, ok := open.(json.Delim); !ok || d != '[' {
		return fmt.Errorf("chat: expected entries array, got %q", open)
	}
	for dec.More() {
		var entry json.RawMessage
		if err := dec.Decode(&entry); err != nil {
			return fmt.Errorf("chat: decode entry: %w", err)
		}
		if len(*page) >= entriesPageMaxCount || (len(*page) > 0 && *pageBytes+len(entry) > entriesPageMaxBytes) {
			emit()
		}
		*page = append(*page, entry)
		*pageBytes += len(entry)
	}
	if _, err := dec.Token(); err != nil { // ']'
		return fmt.Errorf("chat: decode entries end: %w", err)
	}
	return nil
}

// decodeStringField decodes one complete JSON value and returns it as a string
// when it is a JSON string (empty otherwise). Decoding the full value (rather
// than a single token) keeps the Decoder synchronized even if the field is
// unexpectedly composite (object/array) or null.
func decodeStringField(dec *json.Decoder) (string, error) {
	var raw json.RawMessage
	if err := dec.Decode(&raw); err != nil {
		return "", err
	}
	return rawString(raw), nil
}

// rawString unquotes a json.RawMessage holding a JSON string.
func rawString(v json.RawMessage) string {
	var s string
	if json.Unmarshal(v, &s) == nil {
		return s
	}
	return ""
}

// rawBool unquotes a json.RawMessage holding a JSON boolean.
func rawBool(v json.RawMessage) bool {
	var b bool
	_ = json.Unmarshal(v, &b)
	return b
}
