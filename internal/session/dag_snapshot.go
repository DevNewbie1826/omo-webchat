package session

import (
	"crypto/sha256"
	"encoding/json"
	"maps"
	"regexp"
	"sort"
	"time"
)

// Hash keys keep even oversized run IDs from growing the compact high-water
// cache. Entries share the existing digest bound and their owner's lifetime.
type dagFreshness struct {
	millis                            int64
	known, terminal, present, partial bool
	used                              uint64
}

type dagSnapshotCache struct {
	runs                map[[sha256.Size]byte]dagFreshness
	countRuns           map[[sha256.Size]byte]dagCountRun
	runningCount        int
	countAuthorityKnown bool
	clock               uint64
	oversized           bool
}

type dagSnapshotResult struct {
	live, replay json.RawMessage
	digest       *DagDigest
	oversized    bool
	accepted     []json.RawMessage // Newly admitted rows only; replay is not new task-outcome evidence.
}

var dagTimestampPattern = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$`)

func dagTimestamp(raw json.RawMessage) (int64, bool) {
	var value string
	if json.Unmarshal(raw, &value) != nil || !dagTimestampPattern.MatchString(value) {
		return 0, false
	}
	// time.Parse accepts offset hour 24 and minute 60; RFC3339 does not.
	if value[len(value)-1] != 'Z' {
		offset := value[len(value)-5:]
		if offset[:2] > "23" || offset[3:] > "59" {
			return 0, false
		}
	}
	instant, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return 0, false
	}
	return instant.UnixMilli(), true
}

func dagRowIdentity(raw json.RawMessage) (string, dagFreshness) {
	var row struct {
		RunID     string          `json:"run_id"`
		Status    string          `json:"status"`
		UpdatedAt json.RawMessage `json:"updated_at"`
	}
	// Rows reach this helper only after parseDagDigest validates their shape.
	if err := json.Unmarshal(raw, &row); err != nil {
		return "", dagFreshness{}
	}
	millis, known := dagTimestamp(row.UpdatedAt)
	return row.RunID, dagFreshness{millis: millis, known: known, terminal: terminalDagStatuses[row.Status], present: true}
}

// merge chooses whole rows before deriving replay, digest and task outcomes.
// No raw graphs survive here: replay remains owned by the 64 KiB activity cache.
func (c *dagSnapshotCache) merge(data, previous json.RawMessage, previousDigest *DagDigest) (dagSnapshotResult, error) {
	if _, valid := parseDagDigest(data); !valid {
		// Preserve legacy opaque extension replay until there is authoritative
		// DAG state; malformed input cannot discard already accepted state.
		if len(c.runs) == 0 {
			result := dagSnapshotResult{live: data, replay: data, digest: previousDigest, oversized: len(data) > maxActivitySnapshotBytes}
			if result.oversized {
				result.replay = nil
			}
			return result, nil
		}
		return c.incumbent(previous, previousDigest), nil
	}
	var doc map[string]json.RawMessage
	if err := json.Unmarshal(data, &doc); err != nil {
		return dagSnapshotResult{}, err
	}
	var incoming []json.RawMessage
	if err := json.Unmarshal(doc["runs"], &incoming); err != nil {
		return dagSnapshotResult{}, err
	}
	incomingTruncated, _ := parseOptionalBool(doc, "truncated_runs")
	truncated := incomingTruncated
	// Provider-declared complete membership is the only basis for exact scalars;
	// webchat-side bounds never change it.
	fullMembership := !incomingTruncated
	c.mergeCountAuthority(incoming, fullMembership)
	if c.runs == nil {
		c.runs = make(map[[sha256.Size]byte]dagFreshness)
	}
	// Admission at capacity must not erase a later row's incumbent while this
	// same snapshot is still being compared. This temporary copy is bounded too.
	incumbents := maps.Clone(c.runs)
	changed := len(c.runs) == 0
	selected := make(map[[sha256.Size]byte]json.RawMessage)
	accepted := make(map[[sha256.Size]byte]bool)
	var old struct {
		Runs []json.RawMessage `json:"runs"`
	}
	if len(previous) > 0 && json.Unmarshal(previous, &old) == nil {
		for _, raw := range old.Runs {
			id, _ := dagRowIdentity(raw)
			selected[sha256.Sum256([]byte(id))] = raw
		}
	}
	present := make(map[[sha256.Size]byte]bool, len(incoming))
	for _, raw := range incoming {
		id, _ := dagRowIdentity(raw)
		present[sha256.Sum256([]byte(id))] = true
	}
	for key, current := range c.runs {
		if current.present && !present[key] && !truncated && !current.terminal {
			current.present = false
			c.runs[key] = current
			changed = true
		}
	}
	for _, raw := range incoming {
		id, next := dagRowIdentity(raw)
		key := sha256.Sum256([]byte(id))
		current, exists := c.runs[key]
		if !exists {
			current = incumbents[key]
		}
		if current.known && (!next.known || next.millis <= current.millis) {
			continue
		}
		if !exists && len(c.runs) == maxActivityDigestEntries {
			// Prefer evicting omitted high-water entries before visible rows.
			var oldestKey [sha256.Size]byte
			var oldest dagFreshness
			found := false
			for candidate, entry := range c.runs {
				if !found || (oldest.present && !entry.present) || (oldest.present == entry.present && entry.used < oldest.used) {
					oldestKey, oldest, found = candidate, entry, true
				}
			}
			delete(c.runs, oldestKey)
			truncated = truncated || oldest.present
		}
		c.clock++
		next.used = c.clock
		// Projection disclosure belongs to this accepted revision, not later envelopes.
		next.partial = incomingTruncated
		c.runs[key] = next
		selected[key] = raw
		accepted[key] = true
		changed = true
	}
	if !changed {
		return c.incumbent(previous, previousDigest), nil
	}
	// Stable acceptance order avoids random map iteration changing replay.
	keys := make([][sha256.Size]byte, 0, len(c.runs))
	for key, entry := range c.runs {
		if entry.present {
			keys = append(keys, key)
		}
	}
	sort.Slice(keys, func(i, j int) bool { return c.runs[keys[i]].used < c.runs[keys[j]].used })
	rows := make([]json.RawMessage, 0, len(keys))
	missing := make(map[[sha256.Size]byte]bool)
	for _, key := range keys {
		truncated = truncated || c.runs[key].partial
		if row := selected[key]; len(row) > 0 {
			rows = append(rows, row)
		} else {
			missing[key] = true
		}
	}
	encodedRows, err := json.Marshal(rows)
	if err != nil {
		return dagSnapshotResult{}, err
	}
	doc["runs"] = encodedRows
	if truncated || len(missing) > 0 {
		doc["truncated_runs"] = json.RawMessage("true")
	}
	live, err := json.Marshal(doc)
	if err != nil {
		return dagSnapshotResult{}, err
	}
	digest, _ := parseDagDigest(live)
	digest.RunningCount = c.runningCount
	if previousDigest != nil {
		for _, row := range previousDigest.Runs {
			if missing[sha256.Sum256([]byte(row.RunID))] {
				digest.Runs = append(digest.Runs, row)
			}
		}
	}
	if len(digest.Runs) > maxActivityDigestEntries {
		digest.Runs = digest.Runs[:maxActivityDigestEntries]
		digest.Truncated = true
	}
	remainingIDs := maxActivityDigestEntries
	for i := range digest.Runs {
		row := &digest.Runs[i]
		if len(row.RunningTaskIDs) > remainingIDs {
			row.RunningTaskIDs = row.RunningTaskIDs[:remainingIDs]
			digest.Truncated = true
		}
		remainingIDs -= len(row.RunningTaskIDs)
	}
	boundDagDigest(digest)
	c.oversized = len(live) > maxActivitySnapshotBytes
	result := dagSnapshotResult{live: live, replay: live, digest: digest, oversized: c.oversized}
	if c.oversized {
		result.replay = nil
	}
	for _, key := range keys {
		if accepted[key] {
			result.accepted = append(result.accepted, selected[key])
		}
	}
	return result, nil
}

func (c *dagSnapshotCache) incumbent(raw json.RawMessage, digest *DagDigest) dagSnapshotResult {
	live := raw
	if len(live) == 0 {
		live = json.RawMessage(`{"runs":[],"truncated_runs":true}`)
	}
	return dagSnapshotResult{live: live, replay: raw, digest: digest, oversized: c.oversized}
}
