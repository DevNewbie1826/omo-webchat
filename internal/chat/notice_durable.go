package chat

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sync/atomic"
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
	NID     string          `json:"nid,omitempty"`
}

// UnmarshalJSON tolerates damaged persisted notice elements by decoding them
// to the zero record. This keeps one bad advisory from preventing the entire
// state file from loading; seedNotices performs the final allowlist filtering.
func (r *NoticeRecord) UnmarshalJSON(raw []byte) error {
	var fields struct {
		Kind    json.RawMessage `json:"kind"`
		Payload json.RawMessage `json:"payload"`
		At      json.RawMessage `json:"at"`
		NID     json.RawMessage `json:"nid"`
	}
	if json.Unmarshal(raw, &fields) != nil {
		*r = NoticeRecord{}
		return nil
	}
	var kind, stamp, nid string
	if json.Unmarshal(fields.Kind, &kind) != nil || json.Unmarshal(fields.At, &stamp) != nil {
		*r = NoticeRecord{}
		return nil
	}
	if len(fields.NID) > 0 && json.Unmarshal(fields.NID, &nid) != nil {
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
	*r = NoticeRecord{Kind: kind, Payload: append(json.RawMessage(nil), fields.Payload...), At: at, NID: nid}
	return nil
}

// Clone deep-copies the payload, so a record can be handed across the session
// boundary without aliasing the log or the store.
func (r NoticeRecord) Clone() NoticeRecord {
	return NoticeRecord{
		Kind:    r.Kind,
		Payload: append(json.RawMessage(nil), r.Payload...),
		At:      r.At,
		NID:     r.NID,
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
		if a[i].Kind != b[i].Kind || !bytes.Equal(a[i].Payload, b[i].Payload) || !a[i].At.Equal(b[i].At) || a[i].NID != b[i].NID {
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
var noticeNamespaceSequence atomic.Uint64

func (s *Session) nextNoticeIDLocked() string {
	if s.noticeNamespace == "" {
		var random [12]byte
		if _, err := rand.Read(random[:]); err == nil {
			s.noticeNamespace = hex.EncodeToString(random[:])
		} else {
			s.noticeNamespace = fmt.Sprintf("%x-%x", time.Now().UnixNano(), noticeNamespaceSequence.Add(1))
		}
	}
	s.nextNoticeSequence++
	return fmt.Sprintf("%s:%x", s.noticeNamespace, s.nextNoticeSequence)
}

func (s *Session) rememberDurableNotice(kind string, payload json.RawMessage, at time.Time) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	nid := s.nextNoticeIDLocked()
	s.durableNotices = append(s.durableNotices, NoticeRecord{
		Kind:    kind,
		Payload: append(json.RawMessage(nil), payload...),
		At:      at,
		NID:     nid,
	})
	if len(s.durableNotices) > maxDurableNotices {
		s.durableNotices = s.durableNotices[len(s.durableNotices)-maxDurableNotices:]
	}
	return nid
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
	seenIDs := make(map[string]bool, len(seed))
	for _, rec := range seed {
		if !durableNoticeKinds[rec.Kind] || rec.At.IsZero() || !validNoticePayload(rec.Payload) {
			continue
		}
		if rec.NID == "" || seenIDs[rec.NID] {
			rec.NID = s.nextNoticeIDLocked()
		}
		seenIDs[rec.NID] = true
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
			NID:       rec.NID,
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
func (s *Session) persistDurableNotices(snapshot []NoticeRecord) {
	s.mu.Lock()
	callback := s.onNoticePersist
	if callback == nil || equalNotices(snapshot, s.noticesPersisted) {
		s.mu.Unlock()
		return
	}
	s.mu.Unlock()
	if !callback(s, snapshot) {
		return
	}
	s.mu.Lock()
	s.noticesPersisted = cloneNoticeRecords(snapshot)
	s.mu.Unlock()
}

type noticePersistenceRequest struct {
	snapshot []NoticeRecord
	ack      chan struct{}
	stop     bool
}

func (s *Session) startNoticePersistence() {
	s.mu.Lock()
	if s.onNoticePersist == nil || s.noticePersistWork != nil {
		s.mu.Unlock()
		return
	}
	// work is only a wakeup edge. Requests live in the mutex-guarded FIFO, so
	// producers never wait for worker capacity while persistence is stalled.
	work := make(chan struct{}, 1)
	done := make(chan struct{})
	s.noticePersistWork = work
	s.noticePersistDone = done
	s.mu.Unlock()
	go func() {
		defer close(done)
		for range work {
			for {
				s.noticePersistenceMu.Lock()
				if len(s.noticePersistPending) == 0 {
					s.noticePersistenceMu.Unlock()
					break
				}
				request := s.noticePersistPending[0]
				s.noticePersistPending[0] = noticePersistenceRequest{}
				s.noticePersistPending = s.noticePersistPending[1:]
				s.noticePersistenceMu.Unlock()

				if request.snapshot != nil {
					s.persistDurableNotices(request.snapshot)
				}
				if request.ack != nil {
					close(request.ack)
				}
				if request.stop {
					return
				}
			}
		}
	}()
}

// wakeNoticePersistenceLocked signals the worker without waiting for it. The
// caller holds noticePersistenceMu.
func (s *Session) wakeNoticePersistenceLocked(work chan struct{}) {
	select {
	case work <- struct{}{}:
	default:
	}
}

func (s *Session) queueNoticePersistence() {
	s.noticePersistenceMu.Lock()
	defer s.noticePersistenceMu.Unlock()
	s.mu.Lock()
	work := s.noticePersistWork
	snapshot := cloneNoticeRecords(s.durableNotices)
	s.mu.Unlock()
	if work == nil {
		return
	}

	// Keep at most one pending snapshot per representable log record. Once the
	// cap is reached, the newest request subsumes later appends: its full-log
	// snapshot is the next flush covering all records still present in the log.
	snapshotCount := 0
	lastSnapshot := -1
	for i, request := range s.noticePersistPending {
		if request.snapshot != nil {
			snapshotCount++
			lastSnapshot = i
		}
	}
	request := noticePersistenceRequest{snapshot: snapshot}
	if snapshotCount >= maxDurableNotices && lastSnapshot == len(s.noticePersistPending)-1 {
		s.noticePersistPending[lastSnapshot] = request
	} else {
		s.noticePersistPending = append(s.noticePersistPending, request)
	}
	s.wakeNoticePersistenceLocked(work)
}

func (s *Session) drainNoticePersistence() {
	s.noticePersistenceMu.Lock()
	s.mu.Lock()
	work := s.noticePersistWork
	s.mu.Unlock()
	if work == nil {
		s.noticePersistenceMu.Unlock()
		return
	}
	ack := make(chan struct{})
	s.noticePersistPending = append(s.noticePersistPending, noticePersistenceRequest{ack: ack})
	s.wakeNoticePersistenceLocked(work)
	s.noticePersistenceMu.Unlock()
	<-ack
}

func (s *Session) stopNoticePersistence() {
	s.noticePersistenceMu.Lock()
	s.mu.Lock()
	work := s.noticePersistWork
	done := s.noticePersistDone
	s.noticePersistWork = nil
	s.mu.Unlock()
	if work == nil {
		s.noticePersistenceMu.Unlock()
		return
	}
	s.noticePersistPending = append(s.noticePersistPending, noticePersistenceRequest{stop: true})
	s.wakeNoticePersistenceLocked(work)
	s.noticePersistenceMu.Unlock()
	<-done
}
