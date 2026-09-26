package session

// Keep remaps for the live cache plus one retirement window after eviction.
const maxOverviewPublications = maxOverviewCacheEntries + maxIdentityTombstones

// overviewPublications retains remap sources independently of activity eviction.
// Each subscriber also keeps its own history because its initial projection can
// differ from the last broadcast. Callers serialize access.
type overviewPublications struct {
	ids  map[string]string
	fifo []string
}

// touchOverviewHistory keeps the oldest last-used identity at the front.
func touchOverviewHistory(fifo []string, durable string) []string {
	for i, id := range fifo {
		if id == durable {
			copy(fifo[i:], fifo[i+1:])
			fifo[len(fifo)-1] = durable
			return fifo
		}
	}
	return append(fifo, durable)
}

// evictOverviewHistory spends the retirement window before live evidence.
func evictOverviewHistory(ids map[string]string, fifo []string, limit int, live func(string) bool) []string {
	for len(fifo) > limit {
		oldest := -1
		for i, id := range fifo {
			if !live(id) {
				oldest = i
				break
			}
		}
		if oldest < 0 {
			break
		}
		delete(ids, fifo[oldest])
		fifo = append(fifo[:oldest], fifo[oldest+1:]...)
	}
	return fifo
}

func (p *overviewPublications) project(snapshot Summary, live func(string) bool) Summary {
	durable := snapshot.DurableSessionID
	if durable == "" || snapshot.ChatID == "" {
		return snapshot
	}
	if p.ids == nil {
		p.ids = make(map[string]string)
	}
	if previous, known := p.ids[durable]; known {
		snapshot.ReplacesSessionID = ""
		if previous != snapshot.ChatID {
			snapshot.ReplacesSessionID = previous
		}
	}
	p.fifo = touchOverviewHistory(p.fifo, durable)
	p.ids[durable] = snapshot.ChatID
	p.fifo = evictOverviewHistory(p.ids, p.fifo, maxOverviewPublications, live)
	return snapshot
}

func (m *Manager) currentOverviewOwnerLocked(durable, title string) (string, string) {
	if s := m.byChat[m.durableToChat[durable]]; s != nil && s.durableID == durable && m.byRoute[s.routingID] == s {
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
		if m.overviewOwners == nil {
			m.overviewOwners = make(map[string]string)
		}
		m.overviewOwnerFIFO = touchOverviewHistory(m.overviewOwnerFIFO, durable)
		m.overviewOwners[durable] = chatID
		m.overviewOwnerFIFO = evictOverviewHistory(m.overviewOwners, m.overviewOwnerFIFO, maxIdentityTombstones, m.overviewDurableLiveLocked)
	} else {
		_, retired := m.retiredDurable[durable]
		_, known := m.overviewOwners[durable]
		if retired || known || m.durableToChat[durable] != "" {
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
		return entry.summary(chatID, durable, title)
	}
	snapshot.ChatID, snapshot.Title = chatID, title
	return snapshot
}

func (m *Manager) overviewDurableLiveLocked(durable string) bool {
	return m.overviewCache[durable] != nil || m.durableToChat[durable] != ""
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
