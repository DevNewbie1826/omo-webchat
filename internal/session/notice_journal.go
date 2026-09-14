package session

import (
	"fmt"
	"log/slog"
	"sync"
	"time"
)

// NoticeJournalCapacity bounds the durable notices retained per chat for
// attach-time replay; past the cap the oldest notices are evicted first. It
// matches the client's current retained-notice display cap (the frontend
// keeps the newest 50 notices), keeping server retention bounded at the same
// order as client visibility.
const NoticeJournalCapacity = 50

// noticeJournal is the per-chat durable-notice ring. Each entry was stamped
// once, at publish time, with its replay identity (nid) and receipt time (at);
// every replay delivers the stored values verbatim. generation qualifies
// every stamped nid with this manager instance's lifetime. Both fields are
// guarded by mu, as is retired: a retired journal is a terminal tombstone
// that refuses every further stamp, save, replay registration, and fanout,
// and stays installed in the manager's map so no second journal can ever be
// created for the same pathname within this manager instance.
type noticeJournal struct {
	mu          sync.Mutex
	dir         string
	chatID      string
	generation  int64
	retired     bool
	loaded      bool
	seq         uint64
	ring        []Frame
	derivations map[string]bool
	transcripts map[string]persistedTranscriptNoticeState
	sessions    map[*Session]struct{}
}

// append admits one journaled frame, evicting the oldest entry once the ring
// is full so the backing store never grows past the cap.
func (j *noticeJournal) append(f Frame) {
	if len(j.ring) == NoticeJournalCapacity {
		copy(j.ring, j.ring[1:])
		j.ring[len(j.ring)-1] = f
		return
	}
	j.ring = append(j.ring, f)
}

// noticeJournal returns the chat's journal, creating it on first use. A
// journal retired by RetireIdentity stays installed as a tombstone, so this
// lookup hands every caller - including ones racing retirement - the same
// single journal per chat and pathname.
func (m *Manager) noticeJournal(chatID string) *noticeJournal {
	m.mu.Lock()
	journal := m.noticeJournals[chatID]
	if journal == nil {
		journal = &noticeJournal{dir: m.cfg.NoticeDir, chatID: chatID, generation: m.nidGeneration}
		m.noticeJournals[chatID] = journal
	}
	m.mu.Unlock()
	journal.ensureLoaded()
	return journal
}

// ensureLoaded populates the journal from disk exactly once, before its
// first use. Loading runs outside the manager lock so disk latency on one
// chat never stalls unrelated chats; journal.mu serializes it against
// concurrent appends and replays. A tombstone is born loaded, so it never
// reads the disk; a live journal's load always completes under mu before
// retirement's clear-under-mu can run, so a load can never repopulate a
// retired journal.
func (j *noticeJournal) ensureLoaded() {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.loaded {
		return
	}
	j.loaded = true
	if j.dir == "" {
		return
	}
	state := loadNoticeJournal(j.dir, j.chatID)
	j.seq = state.Seq
	j.derivations = state.Derivations
	j.transcripts = state.Transcripts
	j.ring = make([]Frame, 0, len(state.Entries))
	for _, e := range state.Entries {
		j.ring = append(j.ring, Frame{Kind: e.Kind, SessionID: e.SessionID, Data: e.Data})
	}
}

// persistLocked installs the journal's current state on disk. Callers hold
// mu. A retired journal must never touch the disk again: retirement unlinks
// the file after draining writers under mu, and the retired check here - the
// only place a save is attempted - refuses every later save, so no in-flight
// or late publisher can resurrect the file. Other failures are best-effort:
// the in-memory ring stays authoritative, every append rewrites the full
// state, and delivered nids stay unique across restarts because each manager
// instance stamps its own generation, so a failed write is logged and
// superseded.
func (j *noticeJournal) persistLocked() {
	if j.dir == "" || j.retired {
		return
	}
	state := persistedNoticeJournal{Seq: j.seq, Entries: make([]persistedNotice, 0, len(j.ring)), Derivations: j.derivations, Transcripts: j.transcripts}
	for _, f := range j.ring {
		payload, _ := f.Data.(map[string]any)
		state.Entries = append(state.Entries, persistedNotice{Kind: f.Kind, SessionID: f.SessionID, Data: payload})
	}
	if err := saveNoticeJournal(j.dir, j.chatID, state); err != nil {
		slog.Warn("failed to persist notice journal", "chat_id", j.chatID, "error", err)
	}
}

// stampNotice stamps one notice frame with its stable replay identity and
// records it in the chat's journal. The sequence is monotonic per chat and
// never reused, so evicted entries cannot collide with later ones. The
// returned frame (a copy carrying the stamped payload) is what publication
// must deliver, so live delivery and replay present identical values. The
// second result reports admission: a retired tombstone admits nothing - no
// nid is issued, nothing is retained, and the frame must not be delivered.
func stampNotice(chatID string, journal *noticeJournal, f Frame) (Frame, bool) {
	if journal.retired {
		return f, false
	}
	payload, ok := f.Data.(map[string]any)
	if !ok || payload == nil {
		return f, true
	}
	stamped := cloneAnyMap(payload)
	if at, _ := stamped["at"].(string); at == "" {
		stamped["at"] = time.Now().UTC().Format(time.RFC3339Nano)
	}
	journal.seq++
	// The generation qualifier makes delivered nids per-manager-instance:
	// a nid whose save failed and never reached disk cannot be re-issued by
	// a restarted manager, because the restart stamps a fresh generation.
	// Within one instance the seq stays strictly monotonic per chat.
	stamped["nid"] = fmt.Sprintf("%s:g%d:%d", chatID, journal.generation, journal.seq)
	f.Data = stamped
	journal.append(f)
	journal.persistLocked()
	return f, true
}

// publishNotice serializes journal admission and delivery with attach replay
// publication. An attach therefore receives the notice from exactly one side
// of the replay/live boundary.
func (m *Manager) publishNotice(chatID string, f Frame, publish func(Frame)) Frame {
	journal := m.noticeJournal(chatID)
	journal.mu.Lock()
	defer journal.mu.Unlock()
	stamped, admitted := stampNotice(chatID, journal, f)
	if !admitted {
		return f
	}
	if publish != nil {
		publish(stamped)
	}
	return stamped
}

func (m *Manager) journalNotice(chatID string, f Frame) Frame {
	return m.publishNotice(chatID, f, nil)
}

// RecordNotice journals one transport-originated durable notice for chatID.
func (m *Manager) RecordNotice(chatID string, payload map[string]any) Frame {
	return m.journalNotice(chatID, Frame{Kind: FrameNotice, SessionID: chatID, Data: payload})
}

// PublishNotice journals and fans out one transport-originated durable notice.
// If no session is live, the journal still retains it for the next attach.
func (m *Manager) PublishNotice(chatID string, payload map[string]any) {
	journal := m.noticeJournal(chatID)
	journal.mu.Lock()
	defer journal.mu.Unlock()
	f, admitted := stampNotice(chatID, journal, Frame{Kind: FrameNotice, SessionID: chatID, Data: payload})
	if !admitted {
		return
	}
	for sess := range journal.sessions {
		sess.broadcast.publish(f)
	}
}

func (m *Manager) withNoticeReplay(chatID string, sess *Session, use func([]Frame)) {
	journal := m.noticeJournal(chatID)
	journal.mu.Lock()
	defer journal.mu.Unlock()
	if journal.retired {
		// A tombstone still attaches the subscriber - it just retains no
		// notices and registers no live fanout, keeping the replay/live fence
		// consistent: both sides of a retired identity deliver nothing.
		use(nil)
		return
	}
	if sess != nil {
		if journal.sessions == nil {
			journal.sessions = make(map[*Session]struct{})
		}
		journal.sessions[sess] = struct{}{}
	}
	out := make([]Frame, len(journal.ring))
	copy(out, journal.ring)
	use(out)
}

func (m *Manager) unregisterNoticeSession(chatID string, sess *Session) {
	m.mu.Lock()
	journal := m.noticeJournals[chatID]
	m.mu.Unlock()
	if journal == nil {
		return
	}
	journal.mu.Lock()
	delete(journal.sessions, sess)
	journal.mu.Unlock()
}

// noticeReplay snapshots the journaled notices for chatID in publish order.
func (m *Manager) noticeReplay(chatID string) []Frame {
	var out []Frame
	m.withNoticeReplay(chatID, nil, func(replay []Frame) { out = replay })
	return out
}

// journalLen reports the number of retained journal records for chatID.
func (m *Manager) journalLen(chatID string) int {
	journal := m.noticeJournal(chatID)
	journal.mu.Lock()
	defer journal.mu.Unlock()
	return len(journal.ring)
}
