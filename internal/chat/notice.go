package chat

import "encoding/json"

// forwardNotice delivers one ephemeral notice frame through the plain send
// path (marshal + broadcast under the delivery barrier). Unlike
// forwardExtensionEvent there is deliberately no activity-snapshot caching:
// notices are transient advisories and must never enter the replay cache.
func (s *Session) forwardNotice(kind string, payload json.RawMessage) {
	s.send(&NoticeFrame{Type: "notice", SessionID: s.id, Kind: kind, Payload: payload})
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
