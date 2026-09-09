package session

import (
	"fmt"
	"sync"
	"time"
)

// NoticeJournalCapacity bounds the durable notices retained per chat for
// attach-time replay; past the cap the oldest notices are evicted first. It
// matches the client's advisory retention (the frontend keeps the newest 50
// notices), so journaling beyond the cap could never reach a client anyway.
const NoticeJournalCapacity = 50

// noticeJournal is the per-chat durable-notice ring. Each entry was stamped
// once, at publish time, with its replay identity (nid) and receipt time (at);
// every replay delivers the stored values verbatim.
type noticeJournal struct {
	mu       sync.Mutex
	seq      uint64
	ring     []Frame
	sessions map[*Session]struct{}
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

// journalNotice stamps one notice frame with its stable replay identity and
// records it in the chat's journal. The sequence is monotonic per chat and
// never reused, so evicted entries cannot collide with later ones. The
// returned frame (a copy carrying the stamped payload) is what publication
// must deliver, so live delivery and replay present identical values.
func (m *Manager) noticeJournal(chatID string) *noticeJournal {
	m.mu.Lock()
	defer m.mu.Unlock()
	journal := m.noticeJournals[chatID]
	if journal == nil {
		journal = &noticeJournal{}
		m.noticeJournals[chatID] = journal
	}
	return journal
}

func stampNotice(chatID string, journal *noticeJournal, f Frame) Frame {
	payload, ok := f.Data.(map[string]any)
	if !ok || payload == nil {
		return f
	}
	stamped := cloneAnyMap(payload)
	if at, _ := stamped["at"].(string); at == "" {
		stamped["at"] = time.Now().UTC().Format(time.RFC3339Nano)
	}
	journal.seq++
	stamped["nid"] = fmt.Sprintf("%s:%d", chatID, journal.seq)
	f.Data = stamped
	journal.append(f)
	return f
}

// publishNotice serializes journal admission and delivery with attach replay
// publication. An attach therefore receives the notice from exactly one side
// of the replay/live boundary.
func (m *Manager) publishNotice(chatID string, f Frame, publish func(Frame)) Frame {
	journal := m.noticeJournal(chatID)
	journal.mu.Lock()
	defer journal.mu.Unlock()
	f = stampNotice(chatID, journal, f)
	if publish != nil {
		publish(f)
	}
	return f
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
	f := stampNotice(chatID, journal, Frame{Kind: FrameNotice, SessionID: chatID, Data: payload})
	for sess := range journal.sessions {
		sess.broadcast.publish(f)
	}
}

func (m *Manager) withNoticeReplay(chatID string, sess *Session, use func([]Frame)) {
	journal := m.noticeJournal(chatID)
	journal.mu.Lock()
	defer journal.mu.Unlock()
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
