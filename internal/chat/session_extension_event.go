package chat

import (
	"encoding/json"
	"log/slog"
)

// forwardExtensionEvent maps a provider extension_event to the client's
// extensionEvent frame. A nameless event cannot be routed by consumers and
// is dropped; name and data are otherwise passed through verbatim. The
// frame is delivered through the delivery barrier with the snapshot cache
// commit (rememberActivitySnapshot), so cache and broadcast are atomic.
//
// An event that names a parent_session_id is dropped when the receiving
// session already has a different provider runtime session ID, so a misrouted
// provider record cannot contaminate another session's activity cache or WS
// frames. The durable piSessionID may be a file path and is intentionally not
// used for this comparison. Events with no parent_session_id, and sessions
// with no runtime identity yet, pass through unchanged.
func (s *Session) forwardExtensionEvent(raw json.RawMessage) {
	var ev struct {
		Name string          `json:"name"`
		Data json.RawMessage `json:"data"`
	}
	if json.Unmarshal(raw, &ev) != nil || ev.Name == "" {
		return
	}
	var payload struct {
		ParentSessionID string `json:"parent_session_id"`
	}
	if json.Unmarshal(ev.Data, &payload) == nil && payload.ParentSessionID != "" {
		s.mu.Lock()
		providerSessionID := s.providerSessionID
		s.mu.Unlock()
		if providerSessionID != "" && providerSessionID != payload.ParentSessionID {
			slog.Debug("dropped mismatched extension event",
				"session", s.id,
				"name", ev.Name,
				"provider_session_id", providerSessionID,
				"parent_session_id", payload.ParentSessionID,
			)
			return
		}
	}
	b, err := json.Marshal(&ExtensionEventFrame{Type: "extensionEvent", SessionID: s.id, Name: ev.Name, Data: ev.Data})
	if err != nil {
		return
	}
	s.barrier.Lock()
	defer s.barrier.Unlock()
	s.rememberActivitySnapshot(ev.Name, ev.Data)
	s.writeFrame(b)
}
