package chat

import (
	"bytes"
	"encoding/json"
	"time"
)

// maxDurableNotices bounds the per-session durable notice log: the oldest
// record is dropped on overflow, so a chatty provider cannot grow a session
// (or a chat record) without bound.
const maxDurableNotices = 50

// durableNoticeKinds is exactly the advisory set that survives reload,
// reconnect, and server restart: logged on the session, replayed to every
// later attach, and persisted through OnNoticePersist. Everything else —
// including extension_notify — is transient: broadcast once, never logged
// and never persisted.
var durableNoticeKinds = map[string]bool{
	"retry_fallback_applied":   true,
	"retry_fallback_reverted":  true,
	"retry_fallback_succeeded": true,
	"retry_fallback_exhausted": true,
	"server_fallback_aborted":  true,
	"high_reasoning_warning":   true,
}

// NoticeRecord is one durable advisory notice in the replayable session log
// and the persisted chat record: the omo event kind verbatim, the bare
// advisory payload, and the server receipt time. It is the in-memory log's
// shape, the shape handed to persistence, and the shape stored on the chat
// record as the replay seed for a session restored from disk.
type NoticeRecord struct {
	Kind    string          `json:"kind"`
	Payload json.RawMessage `json:"payload,omitempty"`
	At      time.Time       `json:"at"`
}

// UnmarshalJSON tolerates damaged persisted notice elements by decoding them
// to the zero record. This keeps one bad advisory from preventing the entire
// state file from loading; seedNotices performs the final allowlist filtering.
func (r *NoticeRecord) UnmarshalJSON(raw []byte) error {
	var fields struct {
		Kind    json.RawMessage `json:"kind"`
		Payload json.RawMessage `json:"payload"`
		At      json.RawMessage `json:"at"`
	}
	if json.Unmarshal(raw, &fields) != nil {
		*r = NoticeRecord{}
		return nil
	}
	var kind, stamp string
	if json.Unmarshal(fields.Kind, &kind) != nil || json.Unmarshal(fields.At, &stamp) != nil {
		*r = NoticeRecord{}
		return nil
	}
	at, err := time.Parse(time.RFC3339Nano, stamp)
	if err != nil || at.IsZero() {
		*r = NoticeRecord{}
		return nil
	}
	if len(fields.Payload) > 0 {
		var payload map[string]json.RawMessage
		if json.Unmarshal(fields.Payload, &payload) != nil || payload == nil {
			*r = NoticeRecord{}
			return nil
		}
	}
	*r = NoticeRecord{Kind: kind, Payload: append(json.RawMessage(nil), fields.Payload...), At: at}
	return nil
}

// Clone deep-copies the payload, so a record can be handed across the session
// boundary without aliasing the log or the store.
func (r NoticeRecord) Clone() NoticeRecord {
	return NoticeRecord{
		Kind:    r.Kind,
		Payload: append(json.RawMessage(nil), r.Payload...),
		At:      r.At,
	}
}

// cloneNoticeRecords deep-copies a log, so neither side observes later
// mutations of the other.
func cloneNoticeRecords(records []NoticeRecord) []NoticeRecord {
	out := make([]NoticeRecord, len(records))
	for i, rec := range records {
		out[i] = rec.Clone()
	}
	return out
}

// equalNotices reports whether both logs carry identical records: same
// length, kinds, payload bytes, and receipt times. Because the log only ever
// appends (and drops from the front at the cap), this is the persistence
// changed-guard: an unchanged log is never written again.
func equalNotices(a, b []NoticeRecord) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i].Kind != b[i].Kind || !bytes.Equal(a[i].Payload, b[i].Payload) || !a[i].At.Equal(b[i].At) {
			return false
		}
	}
	return true
}

// rememberDurableNotice appends one durable notice to the bounded log,
// dropping the oldest record on overflow. The caller holds the delivery
// barrier, so the log and the live broadcast commit together: a concurrent
// attach can never replay a log that misses a notice it is about to receive
// live.
func (s *Session) rememberDurableNotice(kind string, payload json.RawMessage, at time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.durableNotices = append(s.durableNotices, NoticeRecord{
		Kind:    kind,
		Payload: append(json.RawMessage(nil), payload...),
		At:      at,
	})
	if len(s.durableNotices) > maxDurableNotices {
		s.durableNotices = s.durableNotices[len(s.durableNotices)-maxDurableNotices:]
	}
}

// seedNotices pre-loads the durable notice log from a persisted chat record.
// It runs once at session creation, before any attach. Malformed persisted
// records (empty kind, zero receipt time) are dropped: a damaged record never
// breaks session restore. Overlong seeds are truncated to the cap, matching
// the live log's bound.
func (s *Session) seedNotices(seed []NoticeRecord) {
	if len(seed) == 0 {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, rec := range seed {
		if !durableNoticeKinds[rec.Kind] || rec.At.IsZero() || !validNoticePayload(rec.Payload) {
			continue
		}
		s.durableNotices = append(s.durableNotices, rec.Clone())
	}
	if len(s.durableNotices) > maxDurableNotices {
		s.durableNotices = s.durableNotices[len(s.durableNotices)-maxDurableNotices:]
	}
}

func validNoticePayload(raw json.RawMessage) bool {
	if len(raw) == 0 {
		return true
	}
	var payload map[string]json.RawMessage
	return json.Unmarshal(raw, &payload) == nil && payload != nil
}

// durableNoticeFrames copies and marshals the durable log as notice frames in
// replay order (oldest -> newest). The caller holds the delivery barrier, so
// this snapshot is the exact suffix a newly registered subscriber must
// receive after the activity snapshot frames.
func (s *Session) durableNoticeFrames() [][]byte {
	s.mu.Lock()
	records := cloneNoticeRecords(s.durableNotices)
	s.mu.Unlock()
	frames := make([][]byte, 0, len(records))
	for _, rec := range records {
		b, err := json.Marshal(&NoticeFrame{
			Type:      "notice",
			SessionID: s.id,
			Kind:      rec.Kind,
			Payload:   rec.Payload,
			At:        rec.At.Format(time.RFC3339Nano),
		})
		if err == nil {
			frames = append(frames, b)
		}
	}
	return frames
}

// persistDurableNotices hands the durable log to the session's persistence
// callback. The durable notice itself is the write boundary (not run-settle:
// high_reasoning_warning fires with no run): every arriving durable notice
// writes through unless the log is unchanged since the last successful
// handoff. The marker advances only after the callback reports success, so a
// failed write is retried by the next durable notice. Called with no session
// locks held; the callback must not block the session, and its failure never
// breaks forwarding — the live frame and the replay log are already committed.
func (s *Session) persistDurableNotices() {
	s.mu.Lock()
	callback := s.onNoticePersist
	if callback == nil {
		s.mu.Unlock()
		return
	}
	if equalNotices(s.durableNotices, s.noticesPersisted) {
		s.mu.Unlock()
		return
	}
	snapshot := cloneNoticeRecords(s.durableNotices)
	s.mu.Unlock()
	if !callback(s, snapshot) {
		return
	}
	s.mu.Lock()
	// Do not let an older in-flight snapshot move the marker behind a newer
	// successful write (the worker serializes calls, but the log may grow while
	// the callback is running).
	if len(snapshot) >= len(s.noticesPersisted) {
		s.noticesPersisted = cloneNoticeRecords(snapshot)
	}
	s.mu.Unlock()
}

type noticePersistenceRequest struct {
	flush bool
	ack   chan struct{}
}

func (s *Session) startNoticePersistence() {
	s.mu.Lock()
	if s.onNoticePersist == nil || s.noticePersistWork != nil {
		s.mu.Unlock()
		return
	}
	work := make(chan noticePersistenceRequest, 1)
	stop := make(chan struct{})
	done := make(chan struct{})
	s.noticePersistWork = work
	s.noticePersistStop = stop
	s.noticePersistDone = done
	s.mu.Unlock()
	go func() {
		defer close(done)
		for {
			select {
			case request := <-work:
				if request.flush {
					s.persistDurableNotices()
				}
				if request.ack != nil {
					close(request.ack)
				}
			case <-stop:
				// Flush the latest dirty snapshot after all provider delivery has
				// stopped, then make Close a deterministic persistence boundary.
				s.persistDurableNotices()
				return
			}
		}
	}()
}

func (s *Session) queueNoticePersistence() {
	s.mu.Lock()
	work := s.noticePersistWork
	s.mu.Unlock()
	if work == nil {
		return
	}
	select {
	case work <- noticePersistenceRequest{flush: true}:
	default:
	}
}

func (s *Session) drainNoticePersistence() {
	s.mu.Lock()
	work := s.noticePersistWork
	s.mu.Unlock()
	if work == nil {
		return
	}
	ack := make(chan struct{})
	work <- noticePersistenceRequest{ack: ack}
	<-ack
}

func (s *Session) stopNoticePersistence() {
	s.mu.Lock()
	stop := s.noticePersistStop
	done := s.noticePersistDone
	s.noticePersistWork = nil
	s.noticePersistStop = nil
	s.mu.Unlock()
	if stop == nil {
		return
	}
	close(stop)
	<-done
}
