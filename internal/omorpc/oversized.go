package omorpc

import (
	"encoding/json"
	"fmt"
	"strings"
)

// This error is constructed only after validating the entire JSONL record.
// It is not a Response: neither a missing body nor a fabricated success may
// escape to callers. Ordinary Decoder.Decode retains its fatal size contract.
type oversizedHistoryError struct{ id, command string }

func (e *oversizedHistoryError) Error() string {
	return fmt.Sprintf("%s: response %s (%s)", ErrFrameTooLarge, e.id, e.command)
}
func (e *oversizedHistoryError) Unwrap() error { return ErrFrameTooLarge }

// discardHistory validates without retaining data, even a single giant string.
// Metadata has its own hard budget; ambiguous duplicate envelope members and
// missing LF are fatal. Unknown members are validated and discarded as well.
func (d *Decoder) discardHistory(prefix []byte) error {
	p := oversizedJSON{prefix: prefix, br: d.br, budget: 64 << 10}
	p.advance()
	p.space()
	p.want('{')
	p.space()
	fields := make(map[string]json.RawMessage)
	seen := make(map[string]bool)
	for p.err == nil && p.next != '}' {
		p.capture = make([]byte, 0, 32)
		p.string()
		if p.err != nil {
			break
		}
		var key string
		if err := json.Unmarshal(p.capture, &key); err != nil {
			return err
		}
		key = strings.ToLower(key)
		p.capture = nil
		p.space()
		p.want(':')
		p.space()
		known := key == "id" || key == "type" || key == "command" || key == "sessionid" || key == "success" || key == "error" || key == "data"
		if known {
			if seen[key] {
				return fmt.Errorf("%w: duplicate envelope member %q", ErrFrameTooLarge, key)
			}
			seen[key] = true
			if key != "data" {
				p.capture = make([]byte, 0, 32)
			}
		}
		p.value(1)
		if known && key != "data" {
			fields[key] = p.capture
		}
		p.capture = nil
		p.space()
		if p.next != ',' {
			break
		}
		p.want(',')
		p.space()
		if p.next == '}' {
			p.fail()
		}
	}
	p.want('}')
	p.space()
	if p.err != nil {
		return fmt.Errorf("%w: invalid oversized record: %w", ErrFrameTooLarge, p.err)
	}
	if p.next != '\n' {
		return fmt.Errorf("%w: oversized record is not LF-terminated", ErrFrameTooLarge)
	}
	// The lookahead LF has been consumed from the source, but no peer byte has.
	header, err := json.Marshal(fields)
	if err != nil {
		return err
	}
	var meta struct {
		ID        string `json:"id"`
		Type      string `json:"type"`
		Command   string `json:"command"`
		SessionID string `json:"sessionid"`
		Success   *bool  `json:"success"`
		Error     string `json:"error"`
	}
	if err := json.Unmarshal(header, &meta); err != nil {
		return fmt.Errorf("%w: invalid envelope: %w", ErrFrameTooLarge, err)
	}
	if meta.Type != "response" || meta.Command != CmdGetEntries || meta.ID == "" || meta.Success == nil {
		return fmt.Errorf("%w: not a correlated history response", ErrFrameTooLarge)
	}
	return &oversizedHistoryError{id: meta.ID, command: meta.Command}
}

func (c *Client) settleOversizedHistory(ep *connectionEpoch, err *oversizedHistoryError) bool {
	c.mu.Lock()
	if c.current != ep {
		c.mu.Unlock()
		return false
	}
	pending, ok := c.pending[err.id]
	if ok && pending.command != err.command {
		c.mu.Unlock()
		return false
	}
	if ok {
		delete(c.pending, err.id)
	}
	c.mu.Unlock()
	if ok {
		pending.result <- callResult{epoch: EpochToken{epoch: ep}, err: err}
	} else {
		// Like ordinary late responses, this is unsolicited. Its raw body cannot
		// fit the event contract; account for the loss rather than invent an event.
		c.dropped.Add(1)
	}
	return true
}
