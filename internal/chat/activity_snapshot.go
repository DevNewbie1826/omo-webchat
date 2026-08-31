package chat

import (
	"bytes"
	"encoding/json"
)

// maxActivitySnapshotBytes bounds a cached activity payload: larger payloads
// still forward live but are never replayed, so a runaway provider event
// cannot pin unbounded memory to a session.
const maxActivitySnapshotBytes = 64 << 10

// activitySnapshotOrder lists the extension events whose latest payload is
// replayed to late-attaching clients, in replay order (task state first, the
// DAG view derived from it second). Everything else — notably the transient
// omo.dag.activity and omo.dag.heartbeat traffic — is never cached.
var activitySnapshotOrder = [2]string{"omo.task.updated", "omo.dag.updated"}

// ActivitySnapshotPair is the replayable activity state of one session in
// replay order: the latest omo.task.updated payload first, the latest
// omo.dag.updated payload second. It is the in-memory cache's shape, the
// shape handed to persistence at run completion, and the shape persisted on
// the chat record as the replay seed for a session restored from disk.
type ActivitySnapshotPair struct {
	Task json.RawMessage `json:"task,omitempty"`
	Dag  json.RawMessage `json:"dag,omitempty"`
}

// Clone deep-copies both payloads, so a pair can be handed across the
// session boundary without aliasing the cache or the store.
func (p ActivitySnapshotPair) Clone() ActivitySnapshotPair {
	return ActivitySnapshotPair{
		Task: append(json.RawMessage(nil), p.Task...),
		Dag:  append(json.RawMessage(nil), p.Dag...),
	}
}

// Equal reports whether both pairs carry identical payload bytes.
func (p ActivitySnapshotPair) Equal(other ActivitySnapshotPair) bool {
	return bytes.Equal(p.Task, other.Task) && bytes.Equal(p.Dag, other.Dag)
}

func isActivitySnapshot(name string) bool {
	return name == activitySnapshotOrder[0] || name == activitySnapshotOrder[1]
}

// rememberActivitySnapshot caches the latest payload of a replayable activity
// event. The caller holds the delivery barrier, so the cache and the live
// broadcast commit together: a concurrent attach can never replay a value
// older than one it already delivered live.
func (s *Session) rememberActivitySnapshot(name string, data json.RawMessage) {
	if !isActivitySnapshot(name) || len(data) > maxActivitySnapshotBytes {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.lastActivitySnapshots == nil {
		s.lastActivitySnapshots = make(map[string]json.RawMessage)
	}
	s.lastActivitySnapshots[name] = append(json.RawMessage(nil), data...)
}

// seedActivitySnapshots pre-loads the replayable cache from a persisted chat
// record. It runs once at session creation, before any attach: a session
// restored from disk replays the persisted pair to its first client until
// live provider snapshots supersede it name-by-name through
// rememberActivitySnapshot. Payloads over the cache cap are dropped, matching
// rememberActivitySnapshot's bound.
func (s *Session) seedActivitySnapshots(seed *ActivitySnapshotPair) {
	if seed == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for name, data := range map[string]json.RawMessage{
		activitySnapshotOrder[0]: seed.Task,
		activitySnapshotOrder[1]: seed.Dag,
	} {
		if len(data) == 0 || len(data) > maxActivitySnapshotBytes {
			continue
		}
		if s.lastActivitySnapshots == nil {
			s.lastActivitySnapshots = make(map[string]json.RawMessage)
		}
		s.lastActivitySnapshots[name] = append(json.RawMessage(nil), data...)
	}
}

// persistActivitySnapshot hands the latest replayable pair to the session's
// persistence callback. Run completion is the write boundary: at most one
// store write per settled turn, and only when the pair changed since the last
// successful handoff, so idle sessions and activity-free runs never touch the
// store. The deduplication marker advances only after the callback reports
// success: a failed write leaves it in place so the next settle retries.
// Called with no session locks held; the callback must not block the session.
func (s *Session) persistActivitySnapshot() {
	s.mu.Lock()
	callback := s.onActivitySnapshot
	if callback == nil {
		s.mu.Unlock()
		return
	}
	pair := ActivitySnapshotPair{
		Task: append(json.RawMessage(nil), s.lastActivitySnapshots[activitySnapshotOrder[0]]...),
		Dag:  append(json.RawMessage(nil), s.lastActivitySnapshots[activitySnapshotOrder[1]]...),
	}
	if pair.Equal(s.activityPersisted) {
		s.mu.Unlock()
		return
	}
	s.mu.Unlock()
	if !callback(s, pair) {
		return
	}
	s.mu.Lock()
	s.activityPersisted = pair.Clone()
	s.mu.Unlock()
}

// activitySnapshots copies and marshals each cached activity snapshot in
// replay order. The caller holds the delivery barrier, so this snapshot is the
// exact prefix a newly registered subscriber must receive before live frames.
func (s *Session) activitySnapshots() [][]byte {
	type snapshot struct {
		name string
		data json.RawMessage
	}
	s.mu.Lock()
	snapshots := make([]snapshot, 0, len(activitySnapshotOrder))
	for _, name := range activitySnapshotOrder {
		if data, cached := s.lastActivitySnapshots[name]; cached {
			snapshots = append(snapshots, snapshot{name: name, data: append(json.RawMessage(nil), data...)})
		}
	}
	s.mu.Unlock()
	frames := make([][]byte, 0, len(snapshots))
	for _, snap := range snapshots {
		b, err := json.Marshal(&ExtensionEventFrame{Type: "extensionEvent", SessionID: s.id, Name: snap.name, Data: snap.data})
		if err == nil {
			frames = append(frames, b)
		}
	}
	return frames
}
