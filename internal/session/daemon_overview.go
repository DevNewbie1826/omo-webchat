package session

import "reflect"

// DaemonSession is one successful watcher snapshot member. Nil Activity
// preserves the last disk read when the store is temporarily inaccessible.
type DaemonSession struct {
	DurableSessionID string
	Status           string
	Activity         *HistoricalActivity
}

type daemonSession struct {
	status   string
	snapshot Summary
}

func (m *Manager) daemonOwnerBoundLocked(durable, chat string) bool {
	for _, s := range m.byRoute {
		if s.durableID == durable || s.chatID == chat {
			return true
		}
	}
	return false
}

func (m *Manager) daemonOverviewOwnerLocked(durable string) (string, bool) {
	if m.durableChatResolver == nil || m.deletingDurable[durable] != 0 || m.durableRetiredLocked(durable) {
		return "", false
	}
	chat, _, ok := m.durableChatResolver.ChatForDurable(durable)
	return chat, ok && chat != "" && !m.daemonOwnerBoundLocked(durable, chat)
}

// ApplyDaemonSessions uses snapshot membership, not a connection epoch, as
// the lifetime authority. Publication and route checks share Manager.mu.
func (m *Manager) ApplyDaemonSessions(sessions []DaemonSession) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return
	}
	previous := m.daemonSessions
	next := make(map[string]daemonSession, len(sessions))
	for _, observed := range sessions {
		durable := observed.DurableSessionID
		if durable == "" {
			continue
		}
		state := previous[durable]
		state.status = observed.Status
		if activity := observed.Activity; activity != nil {
			state.snapshot = Summary{
				DurableSessionID: durable, ActivityPair: activity.ActivityPair,
				TaskDigest: cloneTaskDigest(activity.TaskDigest), DagDigest: cloneDagDigest(activity.DagDigest),
				TaskOversized: activity.TaskOversized, DagOversized: activity.DagOversized,
			}
			values := state.snapshot.LiveValues()
			// The reader's complete count scan uses exactAgentCounts before
			// rich-row truncation. DAG-only work is the disjoint remainder.
			values.Running.Dag = max(0, values.Running.Agents-values.Running.Tasks)
			// A fresh disk receipt is not a visible mutation.
			values.LastActivityMS = nil
			state.snapshot.live = &values
		}
		state.snapshot.DurableSessionID = durable
		next[durable] = state
	}
	m.daemonSessions = next
	for durable := range previous {
		if _, present := next[durable]; present {
			continue
		}
		chat, _ := m.currentOverviewOwnerLocked(durable, "")
		if m.daemonOwnerBoundLocked(durable, chat) {
			continue
		}
		var removed Summary
		for _, row := range m.overviewCurrent {
			if row.DurableSessionID == durable {
				removed = row
				break
			}
		}
		m.removeDurableOverviewLocked(durable)
		delete(m.overviewCache, durable)
		m.syncOverviewEvidenceLocked(durable)
		if removed.ChatID != "" {
			removed.Active, removed.BindingID = false, ""
			subscribers := m.updateOverviewLocked(&removed)
			deliverOverview(subscribers, removed)
			m.removeOverviewLocked(removed.ChatID)
		}
	}
	for durable, state := range next {
		if _, eligible := m.daemonOverviewOwnerLocked(durable); !eligible {
			continue
		}
		snapshot := m.projectOverviewLocked(state.snapshot)
		old, exists := m.overviewCurrent[snapshot.ChatID]
		if snapshot.ChatID == "" || exists && old.DurableSessionID == durable && old.Active == snapshot.Active &&
			old.Title == snapshot.Title && reflect.DeepEqual(old.LiveValues(), snapshot.LiveValues()) {
			continue
		}
		subscribers := m.updateOverviewLocked(&snapshot)
		deliverOverview(subscribers, snapshot)
	}
}
