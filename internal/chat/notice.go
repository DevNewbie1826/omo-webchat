package chat

import (
	"encoding/json"
	"time"
)

// forwardNotice delivers one notice frame through the plain send path (marshal
// + broadcast under the delivery barrier), stamped with the server receipt
// time. Durable kinds additionally append to the bounded session log and
// write through to the persistence callback: the log commits under the same
// delivery barrier as the live broadcast, so a concurrent attach can never
// see the live notice without the replay log containing it (and vice versa).
// Transient kinds stay purely ephemeral — never logged, never persisted.
func (s *Session) forwardNotice(kind string, payload json.RawMessage, at time.Time) {
	if at.IsZero() {
		at = time.Now().UTC()
	}
	frame := &NoticeFrame{Type: "notice", SessionID: s.id, Kind: kind, Payload: payload, At: at.Format(time.RFC3339Nano)}
	if !durableNoticeKinds[kind] {
		s.send(frame)
		return
	}
	b, err := json.Marshal(frame)
	if err != nil {
		return
	}
	s.barrier.Lock()
	s.writeFrame(b)
	s.rememberDurableNotice(kind, payload, at)
	s.barrier.Unlock()
	s.queueNoticePersistence()
}

// advisoryNoticePayload returns the raw event object without its routing
// envelope keys: the notice kind and client session ID replace the provider's
// event type and internal multi-session handle.
func advisoryNoticePayload(raw json.RawMessage) json.RawMessage {
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil {
		return raw
	}
	delete(fields, "type")
	delete(fields, "sessionId")
	out, err := json.Marshal(fields)
	if err != nil {
		return raw
	}
	return out
}
