package session

import (
	"reflect"
	"time"
)

// Keep the latest non-resident remaps in addition to all resident remaps.
const maxOverviewPublications = maxIdentityTombstones

type overviewExposure struct {
	durable  string
	title    string
	active   bool
	values   LiveValues
	revision int64
}

// issueOverviewRevisionLocked advances the manager-wide exposed revision
// beyond every row previously projected, including evicted row histories.
func (m *Manager) issueOverviewRevisionLocked() int64 {
	m.overviewRevisionClock = min(maxLiveInteger, max(time.Now().UnixMilli(), m.overviewRevisionClock+1))
	return m.overviewRevisionClock
}

// overviewPublications retains remap sources independently of activity eviction.
// Each subscriber also keeps its own history because its initial projection can
// differ from the last broadcast. Callers serialize access.
type overviewPublications struct {
	ids  residencyLRU[string]
	rows map[string]string
}

func (p *overviewPublications) project(snapshot Summary) Summary {
	durable := snapshot.DurableSessionID
	if durable == "" || snapshot.ChatID == "" {
		return snapshot
	}
	if p.ids.capacity == 0 {
		p.ids.capacity = maxOverviewPublications
	}
	snapshot.ReplacesSessionID = ""
	if previous, known := p.ids.Get(durable); known {
		if previous != snapshot.ChatID && p.rows[previous] == durable {
			snapshot.ReplacesSessionID = previous
			delete(p.rows, previous)
		}
	}
	if p.rows == nil {
		p.rows = make(map[string]string)
	}
	p.rows[snapshot.ChatID] = durable
	p.ids.Put(durable, snapshot.ChatID)
	p.prune()
	return snapshot
}

func (p *overviewPublications) unpin(durable string) {
	p.ids.Unpin(durable)
	p.prune()
}

func (p *overviewPublications) prune() {
	// The forward history evicts non-resident durables; discard their reverse
	// rows too, while keeping rows that have since been claimed by another.
	if len(p.rows) > p.ids.Len() {
		for row, owner := range p.rows {
			if current, known := p.ids.Get(owner); !known || current != row {
				delete(p.rows, row)
			}
		}
	}
}

func (m *Manager) currentOverviewOwnerLocked(durable, title string) (string, string) {
	if s := m.byChat[m.durableToChat[durable]]; s != nil && s.durableID == durable && m.byRoute[s.routingID] == s {
		if m.durableChatResolver != nil {
			if name, ok := m.durableChatResolver.ChatName(s.chatID); ok && name != "" {
				title = name
			}
		}
		return s.chatID, title
	}
	if m.durableChatResolver != nil {
		if id, name, ok := m.durableChatResolver.ChatForDurable(durable); ok {
			return id, name
		}
	}
	return "", title
}

// projectOverviewLocked resolves identity at the read/publication boundary.
// It never retires an identity or changes the durable-keyed activity cache.
// Lock order is Manager.mu -> Store.mu; the resolver must remain a leaf.
func (m *Manager) projectOverviewLocked(snapshot Summary) Summary {
	durable := snapshot.DurableSessionID
	snapshot.ReplacesSessionID = ""
	if durable == "" {
		return snapshot
	}
	if m.deletingDurable[durable] != 0 {
		return Summary{}
	}
	entry := m.overviewCache[durable]
	chatID, title := m.currentOverviewOwnerLocked(durable, snapshot.Title)
	if chatID != "" {
		// Unowned activity churn must not erase former ownership evidence.
		if m.overviewDurableLiveLocked(durable) {
			m.overviewOwners.Pin(durable)
		}
		m.overviewOwners.Put(durable, chatID)
	} else {
		retired := m.durableRetiredLocked(durable)
		_, known := m.overviewOwners.Get(durable)
		if retired || known || m.durableToChat[durable] != "" {
			m.syncOverviewExposedLocked()
			return Summary{}
		}
		chatID, title = durable, ""
	}
	// A route, not mere presence in byChat (which retains resumable sessions),
	// owns the live row. Keep suppressed activity available for acquire's merge.
	if entry != nil {
		if s := m.byChat[chatID]; s != nil && m.byRoute[s.routingID] == s {
			return Summary{}
		}
		snapshot = entry.summary(chatID, durable, title)
	} else {
		snapshot.ChatID, snapshot.Title = chatID, title
	}
	return m.exposeOverviewRevisionLocked(snapshot)
}

// exposeOverviewRevisionLocked is the common revision policy for REST reads,
// initial subscriptions, and publications, including reconstructed cache rows.
func (m *Manager) exposeOverviewRevisionLocked(snapshot Summary) Summary {
	durable := snapshot.DurableSessionID
	previous, known := m.overviewExposed.Get(snapshot.ChatID)
	values := snapshot.LiveValues()
	current := values.LastActivityMS
	values.LastActivityMS = nil
	visible := values
	var revision int64
	if current != nil {
		revision = *current
	}
	if !known || previous.durable != durable || previous.title != snapshot.Title ||
		previous.active != snapshot.Active || !reflect.DeepEqual(previous.values, values) {
		revision = max(revision, min(maxLiveInteger, previous.revision+1), m.issueOverviewRevisionLocked())
	} else {
		revision = max(revision, previous.revision)
	}
	revision = min(maxLiveInteger, revision)
	m.overviewRevisionClock = max(m.overviewRevisionClock, revision)
	if current == nil || revision != *current {
		if entry := m.overviewCache[durable]; entry != nil {
			entry.liveRevision.values.LastActivityMS = &revision
		}
	}
	values.LastActivityMS = &revision
	snapshot.live = &values
	if m.overviewRowLiveLocked(snapshot.ChatID) {
		m.overviewExposed.Pin(snapshot.ChatID)
	}
	m.overviewExposed.Put(snapshot.ChatID, overviewExposure{
		durable: durable, title: snapshot.Title, active: snapshot.Active,
		values:   visible,
		revision: revision,
	})
	m.syncOverviewExposedLocked()
	return snapshot
}

func (m *Manager) overviewDurableLiveLocked(durable string) bool {
	if m.overviewCache[durable] != nil {
		return true
	}
	s := m.byChat[m.durableToChat[durable]]
	return s != nil && s.durableID == durable
}

// Exposed revisions belong to rows, not the durable that last exposed them.
// Resolve every resident durable's current owner, including owners that have
// not yet published their replacement row.
func (m *Manager) overviewResidentRowsLocked() map[string]bool {
	rows := make(map[string]bool, len(m.overviewCache)+len(m.byRoute))
	add := func(durable string) {
		if owner, _ := m.currentOverviewOwnerLocked(durable, ""); owner != "" {
			rows[owner] = true
			return
		}
		_, known := m.overviewOwners.Get(durable)
		if !m.durableRetiredLocked(durable) && !known && m.durableToChat[durable] == "" {
			rows[durable] = true
		}
	}
	for durable := range m.overviewCache {
		add(durable)
	}
	for _, s := range m.byRoute {
		if m.byChat[s.chatID] == s {
			add(s.durableID)
		}
	}
	return rows
}

func (m *Manager) overviewRowLiveLocked(chat string) bool {
	return m.overviewResidentRowsLocked()[chat]
}

func (m *Manager) syncOverviewExposedLocked() {
	rows := m.overviewResidentRowsLocked()
	// Unpin can evict history immediately. Promote every newly resident row
	// before releasing former owners so a retained watermark cannot be lost.
	m.overviewExposed.Range(func(chat string, _ overviewExposure) {
		if rows[chat] {
			m.overviewExposed.Pin(chat)
		}
	})
	m.overviewExposed.Range(func(chat string, _ overviewExposure) {
		if !rows[chat] {
			m.overviewExposed.Unpin(chat)
		}
	})
}

func (m *Manager) overviewRemapUnverifiedLocked(row, durable string) bool {
	exposed, ok := m.overviewExposed.Get(row)
	return !ok || exposed.durable != durable
}

// The caller holds the session lifecycle lock and Manager.mu. A projected
// row may inherit a revision newer than the session's own clock.
func (m *Manager) syncBoundOverviewRevisionLocked(s *Session, snapshot Summary) {
	revision := snapshot.LiveValues().LastActivityMS
	if revision == nil || snapshot.ChatID != s.chatID || snapshot.DurableSessionID != s.durableID {
		return
	}
	if previous := s.liveRevision.values.LastActivityMS; previous == nil || *previous < *revision {
		next := *revision
		s.liveRevision.values.LastActivityMS = &next
	}
}

// syncOverviewEvidenceLocked follows cache/route residency for remap and
// ownership evidence, including subscribers whose publications are queued.
func (m *Manager) syncOverviewEvidenceLocked(durable string) {
	if m.overviewDurableLiveLocked(durable) {
		m.overviewOwners.Pin(durable)
		m.overviewPrevious.ids.Pin(durable)
	} else {
		m.overviewOwners.Unpin(durable)
		m.overviewPrevious.unpin(durable)
	}
	m.syncOverviewExposedLocked()
	for _, sub := range m.overviewSubscribers {
		sub.mu.Lock()
		if m.overviewDurableLiveLocked(durable) {
			sub.published.ids.Pin(durable)
		} else {
			sub.published.unpin(durable)
		}
		sub.mu.Unlock()
	}
}

// projectedOverviewLocked is the common initial-WS/REST cache projection.
// overviewCurrent holds publication history, never authoritative identity.
func (m *Manager) projectedOverviewLocked() []Summary {
	rows := make(map[string]Summary, len(m.overviewCurrent))
	for _, snapshot := range m.overviewCurrent {
		if m.overviewCache[snapshot.DurableSessionID] != nil {
			continue
		}
		if snapshot = m.projectOverviewLocked(snapshot); snapshot.ChatID != "" {
			rows[snapshot.ChatID] = snapshot
		}
	}
	for durable := range m.overviewCache {
		snapshot := m.projectOverviewLocked(Summary{ChatID: durable, DurableSessionID: durable})
		if snapshot.ChatID != "" {
			rows[snapshot.ChatID] = snapshot
		}
	}
	out := make([]Summary, 0, len(rows))
	for _, snapshot := range rows {
		out = append(out, snapshot)
	}
	return out
}

func (m *Manager) removeDurableOverviewLocked(durable string) {
	for id, snapshot := range m.overviewCurrent {
		if snapshot.DurableSessionID == durable {
			delete(m.overviewCurrent, id)
		}
	}
}
