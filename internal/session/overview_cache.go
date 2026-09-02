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
	snapshots map[string]json.RawMessage
	oversized map[string]bool
	task      *TaskDigest
	dag       *DagDigest
	used      uint64
}

type overviewSubscriber struct {
	onSnapshot func(Summary)
	allLive    bool
	sessionIDs map[string]struct{}
	queue      chan Summary
	stop       chan struct{}
}

func (s *overviewSubscriber) run() {
	for {
		select {
		case <-s.stop:
			return
		case snapshot := <-s.queue:
			s.onSnapshot(snapshot)
		}
	}
}

// SubscribeActivity atomically registers an activity observer and captures
// its initial snapshot. Delivery is serialized per observer through a bounded
// latest-value queue, so subscriber code never runs on the manager event loop.
func (m *Manager) SubscribeActivity(allLive bool, sessionIDs []string, onSnapshot func(Summary)) ([]Summary, func()) {
	if onSnapshot == nil {
		return nil, func() {}
	}
	ids := make(map[string]struct{}, len(sessionIDs))
	for _, id := range sessionIDs {
		ids[id] = struct{}{}
	}
	sub := &overviewSubscriber{onSnapshot: onSnapshot, allLive: allLive, sessionIDs: ids, queue: make(chan Summary, overviewSubscriberQueue), stop: make(chan struct{})}
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		close(sub.stop)
		return nil, func() {}
	}
	initial := make([]Summary, 0, len(m.overviewCurrent))
	for _, snapshot := range m.overviewCurrent {
		if sub.matches(snapshot.ChatID) {
			initial = append(initial, cloneSummary(snapshot))
		}
	}
	sort.Slice(initial, func(i, j int) bool { return initial[i].ChatID < initial[j].ChatID })
	m.overviewSubscriberID++
	id := m.overviewSubscriberID
	m.overviewSubscribers[id] = sub
	m.mu.Unlock()
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
	_, unsubscribe := m.SubscribeActivity(true, nil, onSnapshot)
	return unsubscribe
}

func (s *overviewSubscriber) matches(id string) bool {
	if s.allLive {
		return true
	}
	_, ok := s.sessionIDs[id]
	return ok
}

func (m *Manager) notifyOverviewLocked(snapshot Summary) {
	if snapshot.ChatID == "" {
		return
	}
	snapshot = cloneSummary(snapshot)
	if m.overviewCurrent == nil {
		m.overviewCurrent = make(map[string]Summary)
	}
	m.overviewCurrent[snapshot.ChatID] = snapshot
	for _, sub := range m.overviewSubscribers {
		if !sub.matches(snapshot.ChatID) {
			continue
		}
		queued := cloneSummary(snapshot)
		select {
		case sub.queue <- queued:
			continue
		default:
		}
		// Keep recent state without ever waiting for a slow observer.
		select {
		case <-sub.queue:
		default:
		}
		select {
		case sub.queue <- queued:
		default:
		}
	}
}

func (m *Manager) notifySessionOverviewLocked(s *Session) {
	m.mu.Lock()
	m.notifyOverviewLocked(s.summaryLocked())
	m.mu.Unlock()
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

// ingestUnboundOverviewLocked records one unbound task/dag snapshot. The
// caller holds Manager.mu and has already proved no route is bound in epoch.
func (m *Manager) ingestUnboundOverviewLocked(epoch omorpc.EpochToken, ev *omorpc.Event) {
	durableID, name, data, ok := decodeOverviewEvent(ev)
	if !ok {
		return
	}
	entry := m.overviewCache[durableID]
	if entry == nil || entry.epoch != epoch {
		entry = &overviewCacheEntry{epoch: epoch, snapshots: make(map[string]json.RawMessage), oversized: make(map[string]bool)}
		m.overviewCache[durableID] = entry
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
	m.notifyOverviewLocked(entry.summary(durableID))
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
		delete(m.overviewCache, oldestID)
		delete(m.overviewCurrent, oldestID)
	}
}

func (entry *overviewCacheEntry) summary(durableID string) Summary {
	return Summary{
		ChatID: durableID, DurableSessionID: durableID,
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
func (m *Manager) mergeOverviewIntoSessionLocked(s *Session) {
	entry := m.overviewCache[s.durableID]
	if entry == nil {
		return
	}
	delete(m.overviewCache, s.durableID)
	delete(m.overviewCurrent, s.durableID)
	if entry.epoch != s.epoch {
		return
	}
	for _, name := range activitySnapshotOrder {
		if data := entry.snapshots[name]; len(data) > 0 {
			s.activitySnapshots[name] = append(json.RawMessage(nil), data...)
			s.publishLocked(Frame{Kind: FrameExtensionEvent, SessionID: s.durableID, Data: extensionFrameData(name, data, entry.oversized[name])})
		}
		s.activityOversized[name] = entry.oversized[name]
	}
	s.taskDigest = cloneTaskDigest(entry.task)
	s.dagDigest = cloneDagDigest(entry.dag)
	m.overviewCurrent[s.chatID] = s.summaryLocked()
}
