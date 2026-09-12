package session

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
)

type taskCountMember struct {
	millis         int64
	known, present bool
	status         string
}

type agentWorkKey struct {
	hash [sha256.Size]byte
	task bool
}

type dagCountWork struct {
	key     agentWorkKey
	running bool
}

type dagCountRun struct {
	millis                   int64
	known, present, terminal bool
	observable               bool // Revision-fenced run membership, separate from node/agent presence.
	works                    []dagCountWork
}

func taskCountRevision(row map[string]json.RawMessage) (string, taskCountMember, bool) {
	id, _, ok := taskRowIdentity(row)
	if !ok {
		return "", taskCountMember{}, false
	}
	millis, known := dagTimestamp(row["updated_at"])
	return id, taskCountMember{millis: millis, known: known, present: true, status: rawString(row["status"])}, true
}

func (c *taskSnapshotCache) finishCountAuthority() {
	c.countAuthorityKnown = true
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

func (c *taskSnapshotCache) mergeCountAuthority(incoming []map[string]json.RawMessage, complete bool) {
	if c.countMembers == nil {
		c.countMembers = make(map[[sha256.Size]byte]taskCountMember)
	}
	present := make(map[[sha256.Size]byte]bool, len(incoming))
	for _, row := range incoming {
		id, next, ok := taskCountRevision(row)
		if !ok {
			complete = false
			continue
		}
		key := sha256.Sum256([]byte(id))
		present[key] = true
		current, exists := c.countMembers[key]
		if exists && current.known && (!next.known || next.millis <= current.millis) {
			c.countMembers[key] = current
			continue
		}
		c.countMembers[key] = next
	}
	if complete {
		for key, current := range c.countMembers {
			if current.present && !present[key] && !terminalTaskStatuses[current.status] {
				current.present = false
				c.countMembers[key] = current
			}
		}
		c.countAuthorityKnown = true
	}
	if c.countAuthorityKnown {
		c.finishCountAuthority()
	}
}

func dagCountRevision(raw json.RawMessage) (string, dagCountRun) {
	var row struct {
		RunID     string          `json:"run_id"`
		Status    string          `json:"status"`
		UpdatedAt json.RawMessage `json:"updated_at"`
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

func exactAgentCounts(tasks *taskSnapshotCache, dags *dagSnapshotCache) (running, total int) {
	seen := make(map[agentWorkKey]bool)
	if tasks != nil {
		for key, member := range tasks.countMembers {
			if !member.present {
				continue
			}
			seen[agentWorkKey{hash: key, task: true}] = true
			total++
			if member.status == "running" {
				running++
			}
		}
	}
	if dags == nil {
		return running, total
	}
	dagWork := make(map[agentWorkKey]bool)
	for _, run := range dags.countRuns {
		if !run.present {
			continue
		}
		for _, work := range run.works {
			dagWork[work.key] = dagWork[work.key] || work.running
		}
	}
	for key, isRunning := range dagWork {
		if seen[key] {
			continue
		}
		total++
		if isRunning {
			running++
		}
	}
	return running, total
}

func setAgentCounts(task *TaskDigest, dag *DagDigest, running, total int) {
	if task != nil {
		task.AgentRunningCount, task.AgentTotalCount = running, total
	}
	if dag != nil {
		dag.AgentRunningCount, dag.AgentTotalCount = running, total
	}
}

func addActivityCounts(raw json.RawMessage, name string, task *taskSnapshotCache, dag *dagSnapshotCache, running, total int) json.RawMessage {
	var doc map[string]json.RawMessage
	if len(raw) == 0 || json.Unmarshal(raw, &doc) != nil || doc == nil {
		return raw
	}
	if name == activitySnapshotOrder[0] && task != nil && task.countAuthorityKnown {
		doc["running_count"], _ = json.Marshal(task.runningCount)
		doc["total_count"], _ = json.Marshal(task.totalCount)
	}
	if name == activitySnapshotOrder[1] && dag != nil {
		setDagRunAvailability(doc, dag)
		if dag.countAuthorityKnown {
			doc["running_count"], _ = json.Marshal(dag.runningCount)
		}
		var authority DagDigest
		publishDagRunCountAuthority(&authority, dag)
		if authority.RunRunningCount != nil {
			doc["run_running_count"], _ = json.Marshal(authority.RunRunningCount)
			doc["run_total_count"], _ = json.Marshal(authority.RunTotalCount)
		}
	}
	doc["agent_running_count"], _ = json.Marshal(running)
	doc["agent_total_count"], _ = json.Marshal(total)
	out, err := json.Marshal(doc)
	if err != nil {
		return raw
	}
	return out
}

// Publish run authority even when no rich row changed. Nil distinguishes
// unknown membership from an authoritative empty session.
func publishDagRunCountAuthority(digest *DagDigest, dag *dagSnapshotCache) {
	if digest == nil {
		return
	}
	digest.RunRunningCount, digest.RunTotalCount = nil, nil
	digest.RunCountsUnavailable = !dag.countAuthorityKnown || dag.runMembershipUnknown
	if !digest.RunCountsUnavailable {
		running, total := int64(dag.runRunningCount), int64(dag.runTotalCount)
		digest.RunRunningCount, digest.RunTotalCount = &running, &total
	}
}

// Keep withdrawal in retained replay as well as enriched outgoing frames.
func setDagRunAvailability(doc map[string]json.RawMessage, dag *dagSnapshotCache) {
	_, hadRunning := doc["run_running_count"]
	_, hadTotal := doc["run_total_count"]
	delete(doc, "run_counts_unavailable")
	if !dag.countAuthorityKnown || dag.runMembershipUnknown {
		delete(doc, "run_running_count")
		delete(doc, "run_total_count")
		doc["run_counts_unavailable"] = json.RawMessage("true")
	} else if hadRunning || hadTotal {
		// Preserve enriched replay shape, but never carry stale input scalars.
		doc["run_running_count"], _ = json.Marshal(dag.runRunningCount)
		doc["run_total_count"], _ = json.Marshal(dag.runTotalCount)
	}
}

func (s *Session) exactActivityFrameDataLocked(name string, raw json.RawMessage, oversized bool) map[string]any {
	running, total := exactAgentCounts(&s.taskSnapshots, &s.dagSnapshots)
	enriched := addActivityCounts(raw, name, &s.taskSnapshots, &s.dagSnapshots, running, total)
	return extensionFrameData(name, enriched, oversized || len(enriched) > maxActivitySnapshotBytes)
}

func (s *Session) refreshExactCountsLocked() (running, total int) {
	running, total = exactAgentCounts(&s.taskSnapshots, &s.dagSnapshots)
	setAgentCounts(s.taskDigest, s.dagDigest, running, total)
	publishTaskCountAuthority(s.taskDigest, &s.taskSnapshots)
	return running, total
}

func refreshOverviewExactCounts(entry *overviewCacheEntry) {
	running, total := exactAgentCounts(&entry.taskSnapshots, &entry.dagSnapshots)
	setAgentCounts(entry.task, entry.dag, running, total)
	publishTaskCountAuthority(entry.task, &entry.taskSnapshots)
}

// Task running/total authority is the full count membership, which survives
// bounded rich-row eviction. Publish it on the digest independent of any
// retained-row mutation: a DAG outcome that completes an already-evicted task
// corrects the member without a row to reconcile, and the digest must not keep
// the stale scalar until some unrelated row change rebuilds it.
func publishTaskCountAuthority(digest *TaskDigest, task *taskSnapshotCache) {
	if digest == nil || !task.countAuthorityKnown {
		return
	}
	digest.RunningCount, digest.TotalCount = task.runningCount, task.totalCount
}
