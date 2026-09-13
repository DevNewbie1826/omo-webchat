package session

import (
	"crypto/sha256"
	"encoding/json"
	"sort"
)

// observe consumes the DAG cache's acceptance receipt, not its merged replay.
// Replaying an old terminal beside an unrelated accepted run is not evidence.
func (c *taskSnapshotCache) observe(accepted []json.RawMessage) {
	if len(accepted) == 0 {
		return
	}
	if c.outcomes == nil {
		c.outcomes = make(map[taskOutcomeKey]taskOutcomeEvidence)
	}
	for _, raw := range accepted {
		id, _ := dagRowIdentity(raw)
		runKey := sha256.Sum256([]byte(id))
		// A genuinely accepted replacement retires the old run's pending evidence,
		// including terminal-to-running transitions. Already bound corrections stay.
		for key := range c.outcomes {
			if key.run == runKey {
				delete(c.outcomes, key)
			}
		}
		data, _ := json.Marshal(struct {
			Runs []json.RawMessage `json:"runs"`
		}{[]json.RawMessage{raw}})
		outcomes := terminalDagRunTaskOutcomes(data)
		ids := make([]string, 0, len(outcomes))
		for id := range outcomes {
			ids = append(ids, id)
		}
		sort.Strings(ids)
		for _, id := range ids {
			if len(c.outcomes) == maxActivityDigestEntries {
				var oldestKey taskOutcomeKey
				oldest := ^uint64(0)
				for key, evidence := range c.outcomes {
					if evidence.serial < oldest {
						oldestKey, oldest = key, evidence.serial
					}
				}
				delete(c.outcomes, oldestKey)
			}
			c.evidenceClock++
			key := taskOutcomeKey{run: runKey, task: sha256.Sum256([]byte(id))}
			c.outcomes[key] = taskOutcomeEvidence{dagTaskOutcome: outcomes[id], serial: c.evidenceClock}
			memberKey := sha256.Sum256([]byte(id))
			if member, ok := c.countMembers[memberKey]; ok && member.present && !terminalTaskStatuses[member.status] && terminalTaskStatuses[outcomes[id].status] {
				member.status = outcomes[id].status
				c.countMembers[memberKey] = member
				if c.countAuthorityKnown {
					c.finishCountAuthority()
				}
			}
		}
	}
}

// reconcile binds an eligible terminal outcome once to the current raw row.
// Neither a settlement nor an equal raw replay creates a new evidence receipt.
func (c *taskSnapshotCache) reconcile(raw json.RawMessage, digest *TaskDigest) (json.RawMessage, *TaskDigest, bool) {
	eligible := make(map[[sha256.Size]byte]taskOutcomeEvidence)
	for key, evidence := range c.outcomes {
		current := c.tasks[key.task]
		if !current.present || current.terminal || evidence.serial <= current.cutoff {
			continue
		}
		previous, exists := eligible[key.task]
		if !exists || (!previous.fromNode && evidence.fromNode) || (previous.fromNode == evidence.fromNode && evidence.serial > previous.serial) {
			eligible[key.task] = evidence
		}
	}
	changed := false
	for key, evidence := range eligible {
		current := c.tasks[key]
		current.correction, current.terminal = evidence.status, true
		c.tasks[key] = current
		if counted, ok := c.countMembers[key]; ok && counted.present && !terminalTaskStatuses[counted.status] {
			counted.status = evidence.status
			c.countMembers[key] = counted
		}
		changed = true
	}
	if changed && c.countAuthorityKnown {
		c.runningCount, c.totalCount = 0, 0
		for _, member := range c.countMembers {
			if member.present {
				c.totalCount++
				if member.status == "running" {
					c.runningCount++
				}
			}
		}
	}
	if !changed {
		return raw, digest, false
	}
	digest = cloneTaskDigest(digest)
	if digest != nil {
		for i := range digest.Tasks {
			row := &digest.Tasks[i]
			correction := c.tasks[sha256.Sum256([]byte(row.TaskID))].correction
			if correction != "" && !terminalTaskStatuses[row.Status] {
				row.RawStatus, row.Status = row.Status, correction
			}
		}
		digest.RunningCount = c.runningCount
		boundTaskDigest(digest)
	}
	var doc map[string]json.RawMessage
	var rows []map[string]json.RawMessage
	if len(raw) > 0 && json.Unmarshal(raw, &doc) == nil && json.Unmarshal(doc["tasks"], &rows) == nil {
		for _, row := range rows {
			id, _, ok := taskRowIdentity(row)
			correction := c.tasks[sha256.Sum256([]byte(id))].correction
			status := rawString(row["status"])
			if ok && correction != "" && !terminalTaskStatuses[status] {
				row["raw_status"] = row["status"]
				row["status"], _ = json.Marshal(correction)
			}
		}
		doc["tasks"], _ = json.Marshal(rows)
		raw, _ = json.Marshal(doc)
	}
	if len(raw) > maxActivitySnapshotBytes {
		c.oversized = true
		if digest != nil {
			digest.Truncated = true
		}
	}
	return raw, digest, true
}

func (s *Session) reconcileActivityCacheLocked() {
	name := activitySnapshotOrder[0]
	raw, digest, changed := s.taskSnapshots.reconcile(s.activitySnapshots[name], s.taskDigest)
	if !changed {
		return
	}
	s.taskDigest = digest
	// Adding provenance can itself cross the rich replay bound.
	if len(raw) > maxActivitySnapshotBytes {
		s.taskSnapshots.oversized = true
		s.activityOversized[name] = true
		s.activitySnapshots[name] = nil
	} else {
		s.activitySnapshots[name] = raw
	}
	// Rich replay can retain only a prefix (or nothing). Publish every missing
	// corrected compact winner as well, but never cache these description-less
	// rows as rich data: an equal raw row must still be able to enrich the cache.
	if digest != nil {
		doc := make(map[string]json.RawMessage)
		var rows []map[string]json.RawMessage
		if len(raw) > 0 {
			_ = json.Unmarshal(raw, &doc)
			_ = json.Unmarshal(doc["tasks"], &rows)
		}
		present := make(map[string]bool, len(rows))
		for _, row := range rows {
			present[rawString(row["task_id"])] = true
		}
		added := false
		for _, row := range digest.Tasks {
			if row.RawStatus == "" || present[row.TaskID] {
				continue
			}
			encoded, _ := json.Marshal(row)
			var compact map[string]json.RawMessage
			_ = json.Unmarshal(encoded, &compact)
			rows = append(rows, compact)
			added = true
		}
		if added {
			doc["tasks"], _ = json.Marshal(rows)
			doc["truncated_tasks"] = json.RawMessage("true")
			raw, _ = json.Marshal(doc)
		}
	}
	if len(raw) > 0 {
		running, total := s.refreshExactCountsLocked()
		raw = addActivityCounts(raw, name, &s.taskSnapshots, &s.dagSnapshots, running, total)
		s.publishLocked(Frame{Kind: FrameExtensionEvent, SessionID: s.durableID, Data: extensionFrameData(name, raw, s.activityOversized[name])})
	}
	if s.manager != nil {
		s.manager.notifySessionOverviewLocked(s)
	}
}
