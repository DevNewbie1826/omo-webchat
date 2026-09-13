package session

import (
	"crypto/sha256"
	"encoding/json"
	"maps"
	"sort"
)

// Task authority survives rich-payload eviction, but only within this owner's
// bounded lifetime. Activity/receipt clocks never enter the raw high-water mark.
type taskFreshness struct {
	dagFreshness
	cutoff     uint64
	correction string
}

type taskOutcomeKey struct {
	run, task [sha256.Size]byte
}

type taskOutcomeEvidence struct {
	dagTaskOutcome
	serial uint64
}

type taskSnapshotCache struct {
	tasks                    map[[sha256.Size]byte]taskFreshness
	countMembers             map[[sha256.Size]byte]taskCountMember
	runningCount, totalCount int
	countAuthorityKnown      bool
	outcomes                 map[taskOutcomeKey]taskOutcomeEvidence
	clock, evidenceClock     uint64
	oversized                bool
}

type taskSnapshotResult struct {
	live, replay json.RawMessage
	digest       *TaskDigest
	oversized    bool
}

func taskRowIdentity(row map[string]json.RawMessage) (string, taskFreshness, bool) {
	id, idOK := parseRequiredString(row, "task_id")
	status, statusOK := parseRequiredString(row, "status")
	millis, known := dagTimestamp(row["updated_at"])
	return id, taskFreshness{dagFreshness: dagFreshness{millis: millis, known: known, terminal: terminalTaskStatuses[status], present: true}}, idOK && statusOK
}

// merge accepts raw provider rows, not webchat projections. Provenance supplied
// by a provider or task store is never trusted as a webchat outcome binding.
func (c *taskSnapshotCache) merge(data, previous json.RawMessage, previousDigest *TaskDigest) taskSnapshotResult {
	var doc map[string]json.RawMessage
	var incoming []map[string]json.RawMessage
	valid := json.Unmarshal(data, &doc) == nil && doc != nil
	partial, partialOK := parseOptionalBool(doc, "truncated_tasks")
	if !valid || !partialOK || json.Unmarshal(doc["tasks"], &incoming) != nil || incoming == nil {
		if len(data) > maxActivitySnapshotBytes {
			c.oversized = true
		}
		if partialOK && len(c.tasks) == 0 && previousDigest == nil {
			// Preserve legacy opaque replay before any authoritative task state, but
			// never forward provider-supplied provenance even in a malformed row set.
			var rows []json.RawMessage
			if json.Unmarshal(doc["tasks"], &rows) == nil && rows != nil {
				for i, raw := range rows {
					var row map[string]json.RawMessage
					if json.Unmarshal(raw, &row) == nil && row != nil {
						delete(row, "raw_status")
						rows[i], _ = json.Marshal(row)
					}
				}
				doc["tasks"], _ = json.Marshal(rows)
				data, _ = json.Marshal(doc)
			}
			c.oversized = len(data) > maxActivitySnapshotBytes
			replay := data
			if c.oversized {
				replay = nil
			}
			return taskSnapshotResult{live: data, replay: replay, oversized: c.oversized}
		}
		return c.incumbent(previous, previousDigest)
	}
	// A provider flag of false declares complete membership, so scalars derived
	// from these rows are exact no matter which rows the digest later drops.
	// Webchat-side size bounds never change that declaration.
	fullMembership := !partial
	partial = partial || len(data) > maxActivitySnapshotBytes || len(incoming) > maxActivityDigestEntries
	// Structural row loss is incomplete membership. Invalid clocks are not row loss.
	present := make(map[[sha256.Size]byte]bool, len(incoming))
	for _, row := range incoming {
		id, _, ok := taskRowIdentity(row)
		if !ok {
			partial = true
			fullMembership = false
			continue
		}
		present[sha256.Sum256([]byte(id))] = true
	}
	c.mergeCountAuthority(incoming, fullMembership)
	if c.tasks == nil {
		c.tasks = make(map[[sha256.Size]byte]taskFreshness)
	}
	incumbents := maps.Clone(c.tasks)
	selected := make(map[[sha256.Size]byte]map[string]json.RawMessage)
	var old struct {
		Tasks []map[string]json.RawMessage `json:"tasks"`
	}
	if json.Unmarshal(previous, &old) == nil {
		for _, row := range old.Tasks {
			id, _, ok := taskRowIdentity(row)
			if ok {
				selected[sha256.Sum256([]byte(id))] = row
			}
		}
	}
	compact := make(map[[sha256.Size]byte]TaskDigestEntry)
	if previousDigest != nil {
		for _, row := range previousDigest.Tasks {
			compact[sha256.Sum256([]byte(row.TaskID))] = row
		}
	}
	changed := len(c.tasks) == 0
	for key, current := range c.tasks {
		if current.present && !present[key] && !partial && !current.terminal {
			current.present = false
			c.tasks[key] = current
			changed = true
		}
	}
	for _, row := range incoming {
		id, next, ok := taskRowIdentity(row)
		if !ok {
			continue
		}
		key := sha256.Sum256([]byte(id))
		current, exists := c.tasks[key]
		if !exists {
			current = incumbents[key]
			// Selection can outlive a capacity eviction within this input. A later
			// duplicate must still compare against the winner already selected here.
			if selectedRow := selected[key]; selectedRow != nil {
				_, selectedVersion, _ := taskRowIdentity(selectedRow)
				if selectedVersion.known && (!current.known || selectedVersion.millis > current.millis) {
					current = selectedVersion
				}
			}
		}
		delete(row, "raw_status")
		if current.known && (!next.known || next.millis <= current.millis) {
			// Equal rich input can refill missing descriptions, never compact authority
			// or an omitted row. Keep the original clock spelling and derived outcome.
			if exists && current.present && next.known && next.millis == current.millis && selected[key] == nil {
				if winner, ok := compact[key]; ok {
					row["status"], _ = json.Marshal(winner.Status)
					row["updated_at"], _ = json.Marshal(winner.UpdatedAt)
					if winner.RawStatus != "" {
						row["raw_status"], _ = json.Marshal(winner.RawStatus)
					}
					selected[key] = row
					changed = true
				}
			}
			continue
		}
		if !exists && len(c.tasks) == maxActivityDigestEntries {
			var oldestKey [sha256.Size]byte
			var oldest taskFreshness
			found := false
			for candidate, entry := range c.tasks {
				if !found || (oldest.present && !entry.present) || (oldest.present == entry.present && entry.used < oldest.used) {
					oldestKey, oldest, found = candidate, entry, true
				}
			}
			delete(c.tasks, oldestKey)
			partial = partial || oldest.present
		}
		c.clock++
		next.used = c.clock
		// A first task may still be reconciled at settlement by pre-task DAG
		// evidence. Every later raw admission invalidates everything observed so far.
		if exists || current.used != 0 {
			next.cutoff = c.evidenceClock
		}
		encoded, _ := json.Marshal(row)
		next.partial = partial || len(encoded) > maxActivitySnapshotBytes
		c.tasks[key] = next
		selected[key] = row
		changed = true
	}
	if !changed {
		return c.incumbent(previous, previousDigest)
	}
	keys := make([][sha256.Size]byte, 0, len(c.tasks))
	for key, entry := range c.tasks {
		if entry.present {
			keys = append(keys, key)
		}
	}
	sort.Slice(keys, func(i, j int) bool { return c.tasks[keys[i]].used < c.tasks[keys[j]].used })
	rows := make([]map[string]json.RawMessage, 0, len(keys))
	digest := &TaskDigest{Tasks: make([]TaskDigestEntry, 0, len(keys))}
	for _, key := range keys {
		partial = partial || c.tasks[key].partial
		if row := selected[key]; row != nil {
			rows = append(rows, row)
			digest.Tasks = append(digest.Tasks, taskDigestRow(row))
		} else {
			partial = true
			if row, ok := compact[key]; ok {
				digest.Tasks = append(digest.Tasks, row)
			}
		}
	}
	doc["tasks"], _ = json.Marshal(rows)
	digest.RunningCount, digest.TotalCount = c.runningCount, c.totalCount
	if partial {
		doc["truncated_tasks"] = json.RawMessage("true")
	}
	live, _ := json.Marshal(doc)
	c.oversized = len(live) > maxActivitySnapshotBytes
	digest.Truncated = partial || c.oversized
	// Parse only after selection, so rejected envelopes do not advance receipts.
	if parsed, ok := parseTaskDigest(live); ok {
		digest.ReceivedAt, digest.liveLastLine = parsed.ReceivedAt, parsed.liveLastLine
		digest.liveRosterComplete = parsed.liveRosterComplete
	}
	boundTaskDigest(digest)
	result := taskSnapshotResult{live: live, replay: live, digest: digest, oversized: c.oversized}
	if c.oversized {
		result.replay = nil
	}
	return result
}

func (c *taskSnapshotCache) incumbent(raw json.RawMessage, digest *TaskDigest) taskSnapshotResult {
	live := raw
	if len(live) == 0 {
		live = json.RawMessage(`{"tasks":[],"truncated_tasks":true}`)
	}
	return taskSnapshotResult{live: live, replay: raw, digest: digest, oversized: c.oversized}
}
