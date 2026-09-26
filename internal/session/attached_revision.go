package session

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
)

// Content and its authority travel together. In particular, replay cannot
// re-enrich an old task snapshot with current DAG counts and a delivery clock.
type activityContent struct {
	raw       json.RawMessage
	oversized bool
	revision  int64
}

type activityContentCache map[string]activityContent

// Rich live frames can exceed the replay budget. Retain only their last
// fingerprint, not another unbounded copy, to recognize identical delivery.
type activityContentStamp struct {
	hash      [sha256.Size]byte
	oversized bool
	revision  int64
}

// Manager.mu is held by production callers; accessors never call this method.
func (m *Manager) stampActivityContent(previous activityContent, raw json.RawMessage, oversized bool) activityContent {
	if previous.raw != nil && previous.oversized == oversized && bytes.Equal(previous.raw, raw) {
		return previous
	}
	next := activityContent{raw: append(json.RawMessage(nil), raw...), oversized: oversized}
	if m != nil {
		next.revision = m.issueOverviewRevisionLocked()
	}
	return next
}

// Refresh both projections at the mutation boundary because either channel
// can change their shared exact counts. Manager.mu is already held.
func (c *activityContentCache) refresh(m *Manager, snapshots map[string]json.RawMessage, oversized map[string]bool, tasks *taskSnapshotCache, dags *dagSnapshotCache) {
	if *c == nil {
		*c = make(activityContentCache)
	}
	running, total := exactAgentCounts(tasks, dags)
	for _, name := range activitySnapshotOrder {
		raw := snapshots[name]
		if len(raw) == 0 {
			delete(*c, name)
			continue
		}
		enriched := addActivityCounts(raw, name, tasks, dags, running, total)
		(*c)[name] = m.stampActivityContent((*c)[name], enriched, oversized[name] || len(enriched) > maxActivitySnapshotBytes)
	}
}

func (content activityContent) frame(name, durable, binding string) Frame {
	return Frame{
		Kind: FrameExtensionEvent, SessionID: durable, BindingID: binding, Revision: content.revision,
		Data: extensionFrameData(name, content.raw, content.oversized),
	}
}

// lifecycleMu is held. Stamp before broadcaster/hydration/transport queues,
// preserving the lifecycleMu -> Manager.mu lock order used by overview.
func (s *Session) produceExtensionFrameLocked(name string, raw json.RawMessage, oversized bool) Frame {
	var index int
	switch name {
	case activitySnapshotOrder[0]:
		index = 0
	case activitySnapshotOrder[1]:
		index = 1
	case "omo.dag.activity":
		index = 2
	default:
		return (activityContent{raw: raw, oversized: oversized}).frame(name, s.durableID, s.bindingID)
	}
	if s.manager != nil {
		s.manager.mu.Lock()
		defer s.manager.mu.Unlock()
	}
	s.activityContent.refresh(s.manager, s.activitySnapshots, s.activityOversized, &s.taskSnapshots, &s.dagSnapshots)
	content := activityContent{raw: raw, oversized: oversized}
	hash := sha256.Sum256(raw)
	previous := s.activityLast[index]
	cached := s.activityContent[name]
	switch {
	case cached.raw != nil && bytes.Equal(cached.raw, raw) && cached.oversized == oversized:
		content.revision = cached.revision
	case previous.revision != 0 && previous.hash == hash && previous.oversized == oversized:
		content.revision = previous.revision
	case s.manager != nil:
		content.revision = s.manager.issueOverviewRevisionLocked()
	}
	s.activityLast[index] = activityContentStamp{hash: hash, oversized: oversized, revision: content.revision}
	return content.frame(name, s.durableID, s.bindingID)
}

func (s *Session) replayActivityFrameLocked(name string, raw json.RawMessage) Frame {
	if content, ok := s.activityContent[name]; ok {
		return content.frame(name, s.durableID, s.bindingID)
	}
	// Unversioned fixtures/legacy state remain unversioned, never freshly
	// authorized at read time. Production caches are stamped on mutation.
	return Frame{
		Kind: FrameExtensionEvent, SessionID: s.durableID, BindingID: s.bindingID,
		Data: s.exactActivityFrameDataLocked(name, raw, s.activityOversized[name]),
	}
}
