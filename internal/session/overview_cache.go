package session

import (
	"encoding/json"
	"sort"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

const (
	maxOverviewCacheEntries = 256
	overviewSubscriberQueue = 64
)

type overviewCacheEntry struct {
	epoch     omorpc.EpochToken
	chatID    string
	snapshots map[string]json.RawMessage
	oversized map[string]bool
	task      *TaskDigest
	dag       *DagDigest
	used      uint64
}

type overviewUpdate struct {
	summary  Summary
	overflow bool
}

type overviewSubscriber struct {
	onSnapshot func(Summary, bool)
	allLive    bool
	sessionIDs map[string]struct{}
	queue      chan overviewUpdate
	stop       chan struct{}
}

func (s *overviewSubscriber) run() {
	for {
		select {
		case <-s.stop:
			return
		default:
		}
		select {
		case <-s.stop:
			return
		case update := <-s.queue:
			s.onSnapshot(update.summary, update.overflow)
		}
	}
}

// SubscribeActivity atomically registers an activity observer and captures
// its filtered initial snapshot. Delivery is serialized per observer through
// a bounded latest-value queue, so subscriber code never runs on the manager
// event loop. overflow reports loss at this manager hand-off queue.
func (m *Manager) SubscribeActivity(allLive bool, sessionIDs []string, onSnapshot func(Summary, bool)) ([]Summary, func()) {
	if onSnapshot == nil {
		return nil, func() {}
	}
	ids := make(map[string]struct{}, len(sessionIDs))
	for _, id := range sessionIDs {
		ids[id] = struct{}{}
	}
	sub := &overviewSubscriber{onSnapshot: onSnapshot, allLive: allLive, sessionIDs: ids, queue: make(chan overviewUpdate, overviewSubscriberQueue), stop: make(chan struct{})}
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		close(sub.stop)
		return nil, func() {}
	}
	initial := make([]Summary, 0, len(m.overviewCurrent))
	for _, snapshot := range m.overviewCurrent {
		if sub.matches(snapshot) {
			initial = append(initial, snapshot)
		}
	}
	m.overviewSubscriberID++
	id := m.overviewSubscriberID
	m.overviewSubscribers[id] = sub
	m.mu.Unlock()

	for i := range initial {
		initial[i] = cloneSummary(initial[i])
	}
	sort.Slice(initial, func(i, j int) bool { return initial[i].ChatID < initial[j].ChatID })
	go sub.run()

	var once bool
	return initial, func() {
		m.mu.Lock()
		if !once {
			once = true
			if m.overviewSubscribers[id] == sub {
				delete(m.overviewSubscribers, id)
				close(sub.stop)
			}
		}
		m.mu.Unlock()
	}
}

// SubscribeOverview registers an observer for all subsequent snapshots.
func (m *Manager) SubscribeOverview(onSnapshot func(Summary)) func() {
	_, unsubscribe := m.SubscribeActivity(true, nil, func(snapshot Summary, _ bool) { onSnapshot(snapshot) })
	return unsubscribe
}

func (s *overviewSubscriber) matches(snapshot Summary) bool {
	if s.allLive {
		return true
	}
	for _, id := range [...]string{snapshot.ChatID, snapshot.DurableSessionID, snapshot.ReplacesSessionID} {
		if _, ok := s.sessionIDs[id]; ok && id != "" {
			return true
		}
	}
	return false
}

// updateOverviewLocked stores immutable current state and evaluates filters.
// Callers enqueue the returned hand-offs only after releasing Manager.mu.
func (m *Manager) updateOverviewLocked(snapshot Summary) []*overviewSubscriber {
	if snapshot.ChatID == "" {
		return nil
	}
	if m.overviewCurrent == nil {
		m.overviewCurrent = make(map[string]Summary)
	}
	m.overviewCurrent[snapshot.ChatID] = snapshot
	matched := make([]*overviewSubscriber, 0, len(m.overviewSubscribers))
	for _, sub := range m.overviewSubscribers {
		if sub.matches(snapshot) {
			matched = append(matched, sub)
		}
	}
	return matched
}

func deliverOverview(subscribers []*overviewSubscriber, snapshot Summary) {
	for _, sub := range subscribers {
		update := overviewUpdate{summary: cloneSummary(snapshot)}
		select {
		case sub.queue <- update:
			continue
		default:
		}
		select {
		case <-sub.queue:
		default:
		}
		update.overflow = true
		select {
		case sub.queue <- update:
		default:
		}
	}
}

func (m *Manager) notifySessionOverviewLocked(s *Session) {
	snapshot := cloneSummary(s.summaryLocked())
	m.mu.Lock()
	// Route removal is the epoch invalidation barrier. Because the caller holds
	// lifecycleMu, this check and publication preserve the global lock order and
	// cannot race a completed detach back into overviewCurrent.
	registered := m.byRoute[s.routingID] == s
	if _, dead := m.invalidatedEpochs[s.epoch]; dead {
		registered = false
	}
	var subscribers []*overviewSubscriber
	if registered {
		subscribers = m.updateOverviewLocked(snapshot)
	}
	m.mu.Unlock()
	if registered {
		deliverOverview(subscribers, snapshot)
	}
}

func cloneSummary(snapshot Summary) Summary {
	snapshot.ActivityPair.Task = append(json.RawMessage(nil), snapshot.ActivityPair.Task...)
	snapshot.ActivityPair.Dag = append(json.RawMessage(nil), snapshot.ActivityPair.Dag...)
	snapshot.TaskDigest = cloneTaskDigest(snapshot.TaskDigest)
	snapshot.DagDigest = cloneDagDigest(snapshot.DagDigest)
	return snapshot
}

func decodeOverviewEvent(ev *omorpc.Event) (string, string, json.RawMessage, bool) {
	if ev == nil || ev.Type != "extension_event" {
		return "", "", nil, false
	}
	var raw struct {
		Name string          `json:"name"`
		Data json.RawMessage `json:"data"`
	}
	if json.Unmarshal(ev.Raw, &raw) != nil || (raw.Name != activitySnapshotOrder[0] && raw.Name != activitySnapshotOrder[1]) || len(raw.Data) == 0 {
		return "", "", nil, false
	}
	var parent struct {
		ParentSessionID string `json:"parent_session_id"`
	}
	_ = json.Unmarshal(raw.Data, &parent)
	durableID := parent.ParentSessionID
	if durableID == "" {
		durableID = ev.SessionID
	}
	if durableID == "" {
		return "", "", nil, false
	}
	return durableID, raw.Name, raw.Data, true
}

// ingestEpochEvent resolves direct routes first, then durable identity. The
// latter keeps delayed events from retired routing handles attached to the one
// stable chat row. A token that crossed detachEpoch's barrier is rejected.
func (m *Manager) ingestEpochEvent(epoch omorpc.EpochToken, ev *omorpc.Event) (*Session, Summary, []*overviewSubscriber) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, dead := m.invalidatedEpochs[epoch]; dead {
		return nil, Summary{}, nil
	}
	if s := m.byRoute[ev.SessionID]; s != nil && s.epoch == epoch {
		return s, Summary{}, nil
	}
	if durableID, _, _, ok := decodeOverviewEvent(ev); ok {
		if byDurable := m.byDurableEpoch[epoch]; byDurable != nil {
			if binding := byDurable[durableID]; binding != nil {
				if binding.session == nil {
					return nil, Summary{}, nil
				}
				return binding.session, Summary{}, nil
			}
		}
		if _, retired := m.retiredDurable[durableID]; retired {
			return nil, Summary{}, nil
		}
	}
	snapshot, subscribers := m.ingestUnboundOverviewLocked(epoch, ev)
	return nil, snapshot, subscribers
}

// ingestUnboundOverviewLocked records one unbound task/dag snapshot. The
// caller holds Manager.mu and has already proved no route is bound in epoch.
func (m *Manager) ingestUnboundOverviewLocked(epoch omorpc.EpochToken, ev *omorpc.Event) (Summary, []*overviewSubscriber) {
	durableID, name, data, ok := decodeOverviewEvent(ev)
	if !ok {
		return Summary{}, nil
	}
	if _, retired := m.retiredDurable[durableID]; retired {
		return Summary{}, nil
	}
	chatID := durableID
	if mapped := m.durableToChat[durableID]; mapped != "" {
		chatID = mapped
	}
	entry := m.overviewCache[durableID]
	if entry == nil || entry.epoch != epoch {
		if entry != nil {
			delete(m.overviewCurrent, entry.chatID)
		}
		entry = &overviewCacheEntry{epoch: epoch, chatID: chatID, snapshots: make(map[string]json.RawMessage), oversized: make(map[string]bool)}
		m.overviewCache[durableID] = entry
	} else if entry.chatID != chatID {
		delete(m.overviewCurrent, entry.chatID)
		entry.chatID = chatID
	}
	m.overviewClock++
	entry.used = m.overviewClock
	entry.oversized[name] = len(data) > maxActivitySnapshotBytes
	if !entry.oversized[name] {
		entry.snapshots[name] = append(json.RawMessage(nil), data...)
	}
	switch name {
	case activitySnapshotOrder[0]:
		if digest, valid := parseTaskDigest(data); valid {
			entry.task = digest
		}
	case activitySnapshotOrder[1]:
		if digest, valid := parseDagDigest(data); valid {
			entry.dag = digest
		}
		reconcileOverviewEntry(entry, data)
	}
	m.evictOverviewLRULocked()
	snapshot := entry.summary(entry.chatID, durableID)
	return snapshot, m.updateOverviewLocked(snapshot)
}

func reconcileOverviewEntry(entry *overviewCacheEntry, dag json.RawMessage) {
	outcomes := terminalDagRunTaskOutcomes(dag)
	if len(outcomes) == 0 {
		return
	}
	if task, changed := reconcileTaskPayloadWithOutcomes(entry.snapshots[activitySnapshotOrder[0]], outcomes); changed {
		entry.snapshots[activitySnapshotOrder[0]] = task
	}
	if entry.task == nil {
		return
	}
	for i := range entry.task.Tasks {
		row := &entry.task.Tasks[i]
		if outcome, vouched := outcomes[row.TaskID]; vouched && !terminalTaskStatuses[row.Status] {
			row.Status = outcome.status
		}
	}
}

func (m *Manager) evictOverviewLRULocked() {
	for len(m.overviewCache) > maxOverviewCacheEntries {
		var oldestID string
		var oldest uint64
		for id, entry := range m.overviewCache {
			if oldestID == "" || entry.used < oldest {
				oldestID, oldest = id, entry.used
			}
		}
		entry := m.overviewCache[oldestID]
		delete(m.overviewCache, oldestID)
		delete(m.overviewCurrent, entry.chatID)
	}
}

func (entry *overviewCacheEntry) summary(chatID, durableID string) Summary {
	return Summary{
		ChatID: chatID, DurableSessionID: durableID,
		ActivityPair: ActivityPair{
			Task: append(json.RawMessage(nil), entry.snapshots[activitySnapshotOrder[0]]...),
			Dag:  append(json.RawMessage(nil), entry.snapshots[activitySnapshotOrder[1]]...),
		},
		TaskOversized: entry.oversized[activitySnapshotOrder[0]],
		DagOversized:  entry.oversized[activitySnapshotOrder[1]],
		TaskDigest:    cloneTaskDigest(entry.task),
		DagDigest:     cloneDagDigest(entry.dag),
	}
}

// mergeOverviewIntoSessionLocked transfers cached child state while the
// caller holds Session.lifecycleMu followed by Manager.mu. That ordering makes
// route publication and cache eviction one atomic event-loop transition.
func (m *Manager) mergeOverviewIntoSessionLocked(s *Session) (Summary, []*overviewSubscriber) {
	m.activateIdentityLocked(s)

	entry := m.overviewCache[s.durableID]
	if entry == nil {
		return Summary{}, nil
	}
	delete(m.overviewCache, s.durableID)
	delete(m.overviewCurrent, entry.chatID)
	if entry.epoch == s.epoch {
		for _, name := range activitySnapshotOrder {
			if data := entry.snapshots[name]; len(data) > 0 {
				s.activitySnapshots[name] = append(json.RawMessage(nil), data...)
				s.publishLocked(Frame{Kind: FrameExtensionEvent, SessionID: s.durableID, Data: extensionFrameData(name, data, entry.oversized[name])})
			}
			s.activityOversized[name] = entry.oversized[name]
		}
		s.taskDigest = cloneTaskDigest(entry.task)
		s.dagDigest = cloneDagDigest(entry.dag)
	}
	// This replacement is the remap signal for subscribers that observed the
	// provisional durable-keyed row before its stable chat identity was known.
	snapshot := cloneSummary(s.summaryLocked())
	if entry.chatID != s.chatID {
		snapshot.ReplacesSessionID = entry.chatID
	}
	return snapshot, m.updateOverviewLocked(snapshot)
}
