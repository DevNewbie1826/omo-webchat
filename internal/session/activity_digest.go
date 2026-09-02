package session

import (
	"bytes"
	"encoding/json"
	"time"
)

const maxActivityDigestEntries = 512

type ActivityPair struct {
	Task json.RawMessage
	Dag  json.RawMessage
}

type TaskDigestEntry struct {
	TaskID    string `json:"task_id"`
	Status    string `json:"status"`
	UpdatedAt string `json:"updated_at,omitempty"`
}

type TaskDigest struct {
	Tasks      []TaskDigestEntry `json:"tasks"`
	Truncated  bool              `json:"truncated"`
	ReceivedAt string            `json:"received_at,omitempty"`
}

func (d TaskDigest) MarshalJSON() ([]byte, error) {
	tasks := d.Tasks
	if tasks == nil {
		tasks = []TaskDigestEntry{}
	}
	type wire TaskDigest
	return json.Marshal(wire{Tasks: tasks, Truncated: d.Truncated, ReceivedAt: d.ReceivedAt})
}

type RunDigestEntry struct {
	RunID          string   `json:"run_id"`
	Status         string   `json:"status"`
	RunningTaskIDs []string `json:"running_task_ids"`
}

func (r RunDigestEntry) MarshalJSON() ([]byte, error) {
	ids := r.RunningTaskIDs
	if ids == nil {
		ids = []string{}
	}
	type wire RunDigestEntry
	return json.Marshal(wire{RunID: r.RunID, Status: r.Status, RunningTaskIDs: ids})
}

type DagDigest struct {
	Runs       []RunDigestEntry `json:"runs"`
	Truncated  bool             `json:"truncated"`
	ReceivedAt string           `json:"received_at,omitempty"`
}

func (d DagDigest) MarshalJSON() ([]byte, error) {
	runs := d.Runs
	if runs == nil {
		runs = []RunDigestEntry{}
	}
	type wire DagDigest
	return json.Marshal(wire{Runs: runs, Truncated: d.Truncated, ReceivedAt: d.ReceivedAt})
}

func parseRequiredString(doc map[string]json.RawMessage, key string) (string, bool) {
	raw, ok := doc[key]
	if !ok {
		return "", false
	}
	var value string
	return value, json.Unmarshal(raw, &value) == nil && value != ""
}

func parseOptionalString(doc map[string]json.RawMessage, key string) (string, bool) {
	raw, ok := doc[key]
	if !ok {
		return "", true
	}
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return "", false
	}
	var value string
	return value, json.Unmarshal(raw, &value) == nil
}

func parseOptionalBool(doc map[string]json.RawMessage, key string) (bool, bool) {
	raw, ok := doc[key]
	if !ok {
		return false, true
	}
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return false, false
	}
	var value bool
	return value, json.Unmarshal(raw, &value) == nil
}

func parseTaskDigest(data json.RawMessage) (*TaskDigest, bool) {
	var doc map[string]json.RawMessage
	if json.Unmarshal(data, &doc) != nil || doc == nil {
		return nil, false
	}
	truncated, ok := parseOptionalBool(doc, "truncated_tasks")
	if !ok {
		return nil, false
	}
	var rows []json.RawMessage
	if raw, exists := doc["tasks"]; !exists || json.Unmarshal(raw, &rows) != nil || rows == nil {
		return nil, false
	}
	tasks := make([]TaskDigestEntry, 0, min(len(rows), maxActivityDigestEntries))
	for _, raw := range rows {
		var row map[string]json.RawMessage
		if json.Unmarshal(raw, &row) != nil {
			return nil, false
		}
		id, idOK := parseRequiredString(row, "task_id")
		status, statusOK := parseRequiredString(row, "status")
		updated, updatedOK := parseOptionalString(row, "updated_at")
		if !idOK || !statusOK || !updatedOK {
			return nil, false
		}
		if len(tasks) == maxActivityDigestEntries {
			truncated = true
			continue
		}
		tasks = append(tasks, TaskDigestEntry{TaskID: id, Status: status, UpdatedAt: updated})
	}
	return &TaskDigest{Tasks: tasks, Truncated: truncated, ReceivedAt: time.Now().UTC().Format(time.RFC3339)}, true
}

var terminalTaskStatuses = map[string]bool{
	"completed": true, "failed": true, "cancelled": true, "canceled": true,
	"lost": true, "interrupted": true, "error": true, "skipped": true,
}

var terminalDagStatuses = map[string]bool{"completed": true, "failed": true, "cancelled": true, "canceled": true}

func parseDagDigest(data json.RawMessage) (*DagDigest, bool) {
	var doc map[string]json.RawMessage
	if json.Unmarshal(data, &doc) != nil || doc == nil {
		return nil, false
	}
	truncated, ok := parseOptionalBool(doc, "truncated_runs")
	if !ok {
		return nil, false
	}
	var rows []json.RawMessage
	if raw, exists := doc["runs"]; !exists || json.Unmarshal(raw, &rows) != nil || rows == nil {
		return nil, false
	}
	runs := make([]RunDigestEntry, 0, min(len(rows), maxActivityDigestEntries))
	retainedIDs := 0
	for _, raw := range rows {
		var row map[string]json.RawMessage
		if json.Unmarshal(raw, &row) != nil {
			return nil, false
		}
		id, idOK := parseRequiredString(row, "run_id")
		status, statusOK := parseRequiredString(row, "status")
		if !idOK || !statusOK {
			return nil, false
		}
		var nodes []json.RawMessage
		if rawNodes, exists := row["nodes"]; exists {
			if json.Unmarshal(rawNodes, &nodes) != nil || nodes == nil {
				return nil, false
			}
		}
		ids := make([]string, 0)
		for _, rawNode := range nodes {
			var node map[string]json.RawMessage
			if json.Unmarshal(rawNode, &node) != nil {
				return nil, false
			}
			state, stateOK := parseRequiredString(node, "state")
			taskID, taskOK := parseOptionalString(node, "task_id")
			if !stateOK || !taskOK {
				return nil, false
			}
			if state == "running" && taskID != "" && !terminalDagStatuses[status] {
				if retainedIDs == maxActivityDigestEntries {
					truncated = true
				} else {
					ids = append(ids, taskID)
					retainedIDs++
				}
			}
		}
		if terminalDagStatuses[status] {
			continue
		}
		if len(runs) == maxActivityDigestEntries {
			truncated = true
			continue
		}
		runs = append(runs, RunDigestEntry{RunID: id, Status: status, RunningTaskIDs: ids})
	}
	return &DagDigest{Runs: runs, Truncated: truncated, ReceivedAt: time.Now().UTC().Format(time.RFC3339)}, true
}

type dagTaskOutcome struct {
	status   string
	fromNode bool
}

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
			if terminalTaskStatuses[node.State] {
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

func reconcileTaskPayloadWithOutcomes(task json.RawMessage, outcomes map[string]dagTaskOutcome) (json.RawMessage, bool) {
	if len(outcomes) == 0 || len(task) == 0 {
		return nil, false
	}
	var doc map[string]json.RawMessage
	if json.Unmarshal(task, &doc) != nil {
		return nil, false
	}
	var tasks []map[string]json.RawMessage
	if raw, ok := doc["tasks"]; !ok || json.Unmarshal(raw, &tasks) != nil || tasks == nil {
		return nil, false
	}
	changed := false
	for _, row := range tasks {
		var id string
		var status *string
		if json.Unmarshal(row["task_id"], &id) != nil || id == "" ||
			json.Unmarshal(row["status"], &status) != nil || status == nil || *status == "" {
			continue
		}
		outcome, vouched := outcomes[id]
		if !vouched || terminalTaskStatuses[*status] {
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
	return out, err == nil
}

// reconcileActivityCacheLocked demotes stale task rows using terminal DAG
// outcomes. The caller holds lifecycleMu, which protects both projections.
func (s *Session) reconcileActivityCacheLocked(dag json.RawMessage) {
	outcomes := terminalDagRunTaskOutcomes(dag)
	if len(outcomes) == 0 {
		return
	}
	if task, changed := reconcileTaskPayloadWithOutcomes(s.activitySnapshots[activitySnapshotOrder[0]], outcomes); changed {
		s.activitySnapshots[activitySnapshotOrder[0]] = task
	}
	if s.taskDigest == nil {
		return
	}
	for i := range s.taskDigest.Tasks {
		row := &s.taskDigest.Tasks[i]
		outcome, vouched := outcomes[row.TaskID]
		if vouched && !terminalTaskStatuses[row.Status] {
			row.Status = outcome.status
		}
	}
}

func cloneTaskDigest(src *TaskDigest) *TaskDigest {
	if src == nil {
		return nil
	}
	out := *src
	out.Tasks = append([]TaskDigestEntry(nil), src.Tasks...)
	return &out
}

func cloneDagDigest(src *DagDigest) *DagDigest {
	if src == nil {
		return nil
	}
	out := *src
	out.Runs = make([]RunDigestEntry, len(src.Runs))
	for i, run := range src.Runs {
		out.Runs[i] = run
		out.Runs[i].RunningTaskIDs = append([]string(nil), run.RunningTaskIDs...)
	}
	return &out
}
