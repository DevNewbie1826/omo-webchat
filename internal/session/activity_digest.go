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
