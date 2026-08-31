package chat

import (
	"encoding/json"
)

// statusCompleted is the demoted status a ghost running row receives when the
// dag run it belongs to has already finished.
const statusCompleted = "completed"

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
// is rewritten to "completed". Both payloads are parsed minimally and guarded:
// any malformed piece leaves the pair untouched. When nothing changes, the
// ORIGINAL pair value is returned so the byte-identity persist dedup still
// suppresses the write.
func reconcileActivityPair(pair ActivitySnapshotPair) ActivitySnapshotPair {
	task, changed := reconcileTaskPayload(pair.Task, pair.Dag)
	if !changed {
		return pair
	}
	return ActivitySnapshotPair{Task: task, Dag: pair.Dag}
}

// reconcileTaskPayload applies the demotion to one task payload given the dag
// payload. It returns the rewritten payload and whether it changed.
func reconcileTaskPayload(task, dag json.RawMessage) (json.RawMessage, bool) {
	ids := terminalDagRunTaskIDs(dag)
	if len(ids) == 0 || len(task) == 0 {
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
	var tasks []map[string]any
	if json.Unmarshal(rawTasks, &tasks) != nil || tasks == nil {
		return nil, false
	}
	changed := false
	for _, row := range tasks {
		id, ok := row["task_id"].(string)
		if !ok || id == "" {
			continue
		}
		status, _ := row["status"].(string)
		if terminalTaskStatuses[status] || !ids[id] {
			continue
		}
		row["status"] = statusCompleted
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

// terminalDagRunTaskIDs collects the task_ids of nodes belonging to terminal
// dag runs. Malformed dag payloads yield no ids, disabling demotion.
func terminalDagRunTaskIDs(dag json.RawMessage) map[string]bool {
	if len(dag) == 0 {
		return nil
	}
	var doc struct {
		Runs []struct {
			Status string `json:"status"`
			Nodes  []struct {
				TaskID string `json:"task_id"`
			} `json:"nodes"`
		} `json:"runs"`
	}
	if json.Unmarshal(dag, &doc) != nil {
		return nil
	}
	var ids map[string]bool
	for _, run := range doc.Runs {
		if !terminalDagStatuses[run.Status] {
			continue
		}
		for _, node := range run.Nodes {
			if node.TaskID == "" {
				continue
			}
			if ids == nil {
				ids = make(map[string]bool)
			}
			ids[node.TaskID] = true
		}
	}
	return ids
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

// reconcileCachedActivity applies the sweep to the cached pair before it is
// handed to persistence. Called with no session locks held; persistence itself
// stays settle-driven and unchanged.
func (s *Session) reconcileCachedActivity() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.reconcileActivityCacheLocked(s.lastActivitySnapshots[activitySnapshotOrder[1]])
}
