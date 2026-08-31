package chat

import (
	"encoding/json"
)

// terminalTaskStatuses mirrors the frontend TERMINAL_TASK_STATUSES
// (activityShelfModel.ts): task statuses that never revert to running.
var terminalTaskStatuses = map[string]bool{
	"completed":   true,
	"failed":      true,
	"cancelled":   true,
	"lost":        true,
	"interrupted": true,
	"error":       true,
	"skipped":     true,
}

// terminalDagStatuses mirrors the frontend TERMINAL_DAG_STATUSES: dag run
// statuses after which the run's task rows can no longer make progress.
var terminalDagStatuses = map[string]bool{
	"completed": true,
	"failed":    true,
	"cancelled": true,
}

// reconcileActivityPair demotes ghost running rows in the pair's task payload:
// any non-terminal task whose task_id belongs to a node of a terminal dag run
// is rewritten to the node's terminal outcome, falling back to the run outcome.
// Both payloads are parsed minimally and guarded: any malformed piece leaves
// the pair untouched. When nothing changes, the ORIGINAL pair value is
// returned so the byte-identity persist dedup still suppresses the write.
func reconcileActivityPair(pair ActivitySnapshotPair) ActivitySnapshotPair {
	task, changed := reconcileTaskPayload(pair.Task, pair.Dag)
	if !changed {
		return pair
	}
	return ActivitySnapshotPair{Task: task, Dag: pair.Dag}
}

// reconcileTaskPayload applies the demotion to one task payload given the dag
// payload. It returns the rewritten payload and whether it changed. Task rows
// use RawMessage fields so unrelated values never pass through float64 or
// another lossy generic representation.
func reconcileTaskPayload(task, dag json.RawMessage) (json.RawMessage, bool) {
	outcomes := terminalDagRunTaskOutcomes(dag)
	if len(outcomes) == 0 || len(task) == 0 {
		return nil, false
	}
	var doc map[string]json.RawMessage
	if json.Unmarshal(task, &doc) != nil {
		return nil, false
	}
	rawTasks, ok := doc["tasks"]
	if !ok {
		return nil, false
	}
	var tasks []map[string]json.RawMessage
	if json.Unmarshal(rawTasks, &tasks) != nil || tasks == nil {
		return nil, false
	}
	changed := false
	for _, row := range tasks {
		rawID, hasID := row["task_id"]
		rawStatus, hasStatus := row["status"]
		if !hasID || !hasStatus {
			continue
		}
		var id, status string
		if json.Unmarshal(rawID, &id) != nil || id == "" || json.Unmarshal(rawStatus, &status) != nil {
			continue
		}
		outcome, vouched := outcomes[id]
		if terminalTaskStatuses[status] || !vouched {
			continue
		}
		row["status"], _ = json.Marshal(outcome.status)
		changed = true
	}
	if !changed {
		return nil, false
	}
	doc["tasks"], _ = json.Marshal(tasks)
	out, err := json.Marshal(doc)
	if err != nil {
		return nil, false
	}
	return out, true
}

type dagTaskOutcome struct {
	status   string
	fromNode bool
}

// terminalDagRunTaskOutcomes collects the terminal outcome for each task_id
// belonging to a terminal dag run. A node's own terminal state is more
// specific and wins over a run-level fallback regardless of payload order.
func terminalDagRunTaskOutcomes(dag json.RawMessage) map[string]dagTaskOutcome {
	if len(dag) == 0 {
		return nil
	}
	var doc struct {
		Runs []struct {
			Status string `json:"status"`
			Nodes  []struct {
				TaskID string `json:"task_id"`
				State  string `json:"state"`
			} `json:"nodes"`
		} `json:"runs"`
	}
	if json.Unmarshal(dag, &doc) != nil {
		return nil
	}
	var outcomes map[string]dagTaskOutcome
	for _, run := range doc.Runs {
		if !terminalDagStatuses[run.Status] {
			continue
		}
		for _, node := range run.Nodes {
			if node.TaskID == "" {
				continue
			}
			outcome := dagTaskOutcome{status: run.Status}
			if terminalDagStatuses[node.State] {
				outcome = dagTaskOutcome{status: node.State, fromNode: true}
			}
			if previous, exists := outcomes[node.TaskID]; exists && previous.fromNode && !outcome.fromNode {
				continue
			}
			if outcomes == nil {
				outcomes = make(map[string]dagTaskOutcome)
			}
			outcomes[node.TaskID] = outcome
		}
	}
	return outcomes
}

// dagHasTerminalRun reports whether the dag payload carries at least one
// terminal run. Malformed payloads report false.
func dagHasTerminalRun(dag json.RawMessage) bool {
	if len(dag) == 0 {
		return false
	}
	var doc struct {
		Runs []struct {
			Status string `json:"status"`
		} `json:"runs"`
	}
	if json.Unmarshal(dag, &doc) != nil {
		return false
	}
	for _, run := range doc.Runs {
		if terminalDagStatuses[run.Status] {
			return true
		}
	}
	return false
}

// reconcileActivityCacheLocked applies the sweep to the cached pair. The
// caller holds s.mu; only the task payload can change, and only when the dag
// payload vouches for a demotion.
func (s *Session) reconcileActivityCacheLocked(dag json.RawMessage) {
	task, changed := reconcileTaskPayload(s.lastActivitySnapshots[activitySnapshotOrder[0]], dag)
	if !changed {
		return
	}
	s.lastActivitySnapshots[activitySnapshotOrder[0]] = task
}
