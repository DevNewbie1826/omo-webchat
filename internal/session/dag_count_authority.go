package session

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
)

type dagCountWork struct {
	key     agentWorkKey
	running bool
}

type dagCountRun struct {
	completed, total         int
	countsIncomplete         bool
	millis                   int64
	known, present, terminal bool
	observable               bool // Revision-fenced run membership, separate from node/agent presence.
	works                    []dagCountWork
}

func dagCountRevision(raw json.RawMessage) (string, dagCountRun) {
	var row struct {
		RunID     string          `json:"run_id"`
		Status    string          `json:"status"`
		UpdatedAt json.RawMessage `json:"updated_at"`
		Counts    json.RawMessage `json:"counts"`
		Nodes     []struct {
			ID     string `json:"id"`
			TaskID string `json:"task_id"`
			State  string `json:"state"`
		} `json:"nodes"`
	}
	_ = json.Unmarshal(raw, &row)
	millis, known := dagTimestamp(row.UpdatedAt)
	terminal := terminalDagStatuses[row.Status]
	run := dagCountRun{millis: millis, known: known, present: true, terminal: terminal, works: make([]dagCountWork, 0, len(row.Nodes))}
	if len(row.Counts) > 0 {
		var counts *struct {
			Completed *int64 `json:"completed"`
			Total     *int64 `json:"total"`
		}
		if err := json.Unmarshal(row.Counts, &counts); err != nil || counts == nil ||
			counts.Completed == nil || counts.Total == nil ||
			*counts.Completed < 0 || *counts.Total < *counts.Completed || *counts.Total > maxLiveInteger {
			run.countsIncomplete = true
		} else {
			run.completed, run.total = int(*counts.Completed), int(*counts.Total)
		}
	}
	for i, node := range row.Nodes {
		work := dagCountWork{running: !terminal && node.State == "running"}
		if node.TaskID != "" {
			work.key = agentWorkKey{hash: sha256.Sum256([]byte(node.TaskID)), task: true}
		} else {
			identity := node.ID
			if identity == "" {
				identity = fmt.Sprintf("#%d", i)
			}
			work.key = agentWorkKey{hash: sha256.Sum256([]byte(row.RunID + "\x00" + identity))}
		}
		run.works = append(run.works, work)
	}
	return row.RunID, run
}

func (c *dagSnapshotCache) finishCountAuthority() {
	c.countAuthorityKnown = true
	c.runningCount = 0
	c.runRunningCount, c.runTotalCount = 0, 0
	for _, run := range c.countRuns {
		// Total membership is session-cumulative; running membership requires
		// an observable nonterminal run. Node/agent presence is independent.
		c.runTotalCount++
		if run.observable && !run.terminal {
			c.runRunningCount++
		}
		if !run.present {
			continue
		}
		for _, work := range run.works {
			if work.running {
				c.runningCount++
			}
		}
	}
}

func (c *dagSnapshotCache) mergeCountAuthority(incoming []json.RawMessage, complete bool) {
	if c.countRuns == nil {
		c.countRuns = make(map[[sha256.Size]byte]dagCountRun)
	}
	present := make(map[[sha256.Size]byte]bool, len(incoming))
	observations := make(map[[sha256.Size]byte]bool)
	// Row freshness rejects provably stale deliveries. Membership additionally
	// needs session-level evidence: a new high-water revision, or an identical
	// steady-state inventory. Ambiguity cannot be cleared by an equal replay.
	stale, unordered := false, false
	var newest int64
	newestKnown := false
	for _, raw := range incoming {
		id, next := dagCountRevision(raw)
		key := sha256.Sum256([]byte(id))
		present[key] = true
		if next.known && (!newestKnown || next.millis > newest) {
			newest, newestKnown = next.millis, true
		}
		current, exists := c.countRuns[key]
		if exists {
			if !current.known || !next.known {
				unordered = true
			} else if next.millis < current.millis {
				stale = true
			}
		}
		// Row/status admission cannot change accepted membership. Partial
		// re-observations must also postdate the session membership fence,
		// not just this run's last row (which may predate its omission).
		next.observable = current.observable
		if !complete && !current.observable {
			if !exists || (next.known && c.runRevisionKnown && next.millis > c.runRevision) {
				observations[key] = true
			} else if !current.known || !next.known || next.millis >= current.millis {
				unordered = true
			}
		}
		if exists && current.known && (!next.known || next.millis <= current.millis) {
			c.countRuns[key] = current
			continue
		}
		c.countRuns[key] = next
	}
	if unordered && !stale {
		c.runMembershipUnknown = true
	}
	// A stale sibling rejects a complete inventory, but cannot veto an
	// independently admitted partial observation. Wholly stale replays queue
	// no observations; ambiguous re-observations remain fenced above.
	if !complete && !unordered {
		for key := range observations {
			current := c.countRuns[key]
			current.observable = true
			c.countRuns[key] = current
		}
	}
	if complete {
		sameMembership := len(present) == len(c.runMembership)
		for key := range present {
			sameMembership = sameMembership && c.runMembership[key]
		}
		newer := newestKnown && (!c.runRevisionKnown || newest > c.runRevision)
		steady := !c.runMembershipUnknown && sameMembership &&
			((newestKnown && c.runRevisionKnown && newest == c.runRevision) || (!newestKnown && len(c.countRuns) == 0))
		initialCompletion := !c.countAuthorityKnown && !c.runMembershipUnknown && newestKnown &&
			len(present) == len(c.countRuns) && (!c.runRevisionKnown || newest >= c.runRevision)
		membershipAccepted := !stale && !unordered && (newer || steady || initialCompletion)
		if membershipAccepted {
			c.runMembershipUnknown = false
			c.runMembership = present
		} else if !stale || !c.countAuthorityKnown {
			// A strictly stale row proves a replay and leaves prior authority
			// intact; unchanged survivors or empty inventories prove nothing.
			c.runMembershipUnknown = true
		}
		for key, current := range c.countRuns {
			if membershipAccepted {
				current.observable = present[key]
			}
			if !present[key] {
				current.present = false
			}
			c.countRuns[key] = current
		}
		c.countAuthorityKnown = true
	}
	if newestKnown && (!c.runRevisionKnown || newest > c.runRevision) {
		c.runRevision, c.runRevisionKnown = newest, true
	}
	if c.countAuthorityKnown {
		c.finishCountAuthority()
	}
}
