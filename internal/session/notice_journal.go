package session

import (
	"fmt"
	"time"
)

// NoticeJournalCapacity bounds the durable notices retained per chat for
// attach-time replay; past the cap the oldest notices are evicted first.
const NoticeJournalCapacity = 200

// noticeJournal is the per-chat durable-notice ring. Each entry was stamped
// once, at publish time, with its replay identity (nid) and receipt time (at);
// every replay delivers the stored values verbatim.
type noticeJournal struct {
	seq  uint64
	ring []Frame
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
func (m *Manager) journalNotice(chatID string, f Frame) Frame {
	payload, ok := f.Data.(map[string]any)
	if !ok || payload == nil {
		return f
	}
	stamped := cloneAnyMap(payload)
	if at, _ := stamped["at"].(string); at == "" {
		stamped["at"] = time.Now().UTC().Format(time.RFC3339Nano)
	}
	m.mu.Lock()
	journal := m.noticeJournals[chatID]
	if journal == nil {
		journal = &noticeJournal{}
		m.noticeJournals[chatID] = journal
	}
	journal.seq++
	stamped["nid"] = fmt.Sprintf("%s:%d", chatID, journal.seq)
	journal.append(Frame{Kind: FrameNotice, SessionID: f.SessionID, Data: stamped})
	m.mu.Unlock()
	f.Data = stamped
	return f
}

// RecordNotice journals one transport-originated durable notice for chatID and
// returns the stamped frame for immediate fanout. The stamped payload carries
// the wire identity (kind, at, nid) that the frame mapper extracts.
func (m *Manager) RecordNotice(chatID string, payload map[string]any) Frame {
	return m.journalNotice(chatID, Frame{Kind: FrameNotice, SessionID: chatID, Data: payload})
}

// noticeReplay snapshots the journaled notices for chatID in publish order.
func (m *Manager) noticeReplay(chatID string) []Frame {
	m.mu.Lock()
	defer m.mu.Unlock()
	journal := m.noticeJournals[chatID]
	if journal == nil || len(journal.ring) == 0 {
		return nil
	}
	out := make([]Frame, len(journal.ring))
	copy(out, journal.ring)
	return out
}

// journalLen reports the number of retained journal records for chatID.
func (m *Manager) journalLen(chatID string) int {
	m.mu.Lock()
	defer m.mu.Unlock()
	journal := m.noticeJournals[chatID]
	if journal == nil {
		return 0
	}
	return len(journal.ring)
}
