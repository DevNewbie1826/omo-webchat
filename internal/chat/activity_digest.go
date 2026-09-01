package chat

import (
	"bytes"
	"encoding/json"
)

// maxActivityDigestEntries bounds compact activity digests so a runaway
// provider payload cannot pin unbounded task/run rows to a session.
const maxActivityDigestEntries = 512

// TaskDigestEntry is one compact task row extracted for live-session counts.
type TaskDigestEntry struct {
	TaskID    string `json:"task_id"`
	Status    string `json:"status"`
	UpdatedAt string `json:"updated_at,omitempty"`
}

// ActivityTaskDigest is the in-memory task-count summary of one session.
type ActivityTaskDigest struct {
	Tasks     []TaskDigestEntry `json:"tasks"`
	Truncated bool              `json:"truncated"`
}

func (d ActivityTaskDigest) MarshalJSON() ([]byte, error) {
	tasks := d.Tasks
	if tasks == nil {
		tasks = make([]TaskDigestEntry, 0)
	}
	return json.Marshal(struct {
		Tasks     []TaskDigestEntry `json:"tasks"`
		Truncated bool              `json:"truncated"`
	}{Tasks: tasks, Truncated: d.Truncated})
}

// RunDigestEntry is one compact non-terminal dag run extracted for counts.
type RunDigestEntry struct {
	RunID          string   `json:"run_id"`
	Status         string   `json:"status"`
	RunningTaskIDs []string `json:"running_task_ids"`
}

func (r RunDigestEntry) MarshalJSON() ([]byte, error) {
	ids := r.RunningTaskIDs
	if ids == nil {
		ids = make([]string, 0)
	}
	return json.Marshal(struct {
		RunID          string   `json:"run_id"`
		Status         string   `json:"status"`
		RunningTaskIDs []string `json:"running_task_ids"`
	}{RunID: r.RunID, Status: r.Status, RunningTaskIDs: ids})
}

// ActivityDagDigest is the in-memory dag-count summary of one session.
type ActivityDagDigest struct {
	Runs      []RunDigestEntry `json:"runs"`
	Truncated bool             `json:"truncated"`
}

func (d ActivityDagDigest) MarshalJSON() ([]byte, error) {
	runs := d.Runs
	if runs == nil {
		runs = make([]RunDigestEntry, 0)
	}
	return json.Marshal(struct {
		Runs      []RunDigestEntry `json:"runs"`
		Truncated bool             `json:"truncated"`
	}{Runs: runs, Truncated: d.Truncated})
}

// rememberActivityDigestLocked extracts a compact count digest from a
// recognized activity payload. The caller holds s.mu. Malformed JSON leaves
// the previous digest in place.
func (s *Session) rememberActivityDigestLocked(name string, data json.RawMessage) {
	switch name {
	case activitySnapshotOrder[0]:
		digest, ok := parseActivityTaskDigest(data)
		if ok {
			s.taskDigest = digest
		}
	case activitySnapshotOrder[1]:
		digest, ok := parseActivityDagDigest(data)
		if ok {
			s.dagDigest = digest
		}
	}
}

func parseRequiredString(doc map[string]json.RawMessage, key string) (string, bool) {
	raw, ok := doc[key]
	if !ok {
		return "", false
	}
	var value string
	if json.Unmarshal(raw, &value) != nil || value == "" {
		return "", false
	}
	return value, true
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
	if json.Unmarshal(raw, &value) != nil {
		return "", false
	}
	return value, true
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
	if json.Unmarshal(raw, &value) != nil {
		return false, false
	}
	return value, true
}

func parseActivityTaskDigest(data json.RawMessage) (*ActivityTaskDigest, bool) {
	var doc map[string]json.RawMessage
	if json.Unmarshal(data, &doc) != nil || doc == nil {
		return nil, false
	}
	truncated, ok := parseOptionalBool(doc, "truncated_tasks")
	if !ok {
		return nil, false
	}
	rawTasks, ok := doc["tasks"]
	if !ok {
		return nil, false
	}
	var rows []json.RawMessage
	if json.Unmarshal(rawTasks, &rows) != nil || rows == nil {
		return nil, false
	}
	tasks := make([]TaskDigestEntry, 0, min(len(rows), maxActivityDigestEntries))
	for _, raw := range rows {
		var row map[string]json.RawMessage
		if json.Unmarshal(raw, &row) != nil || row == nil {
			return nil, false
		}
		taskID, validID := parseRequiredString(row, "task_id")
		status, validStatus := parseRequiredString(row, "status")
		updatedAt, validUpdatedAt := parseOptionalString(row, "updated_at")
		if !validID || !validStatus || !validUpdatedAt {
			return nil, false
		}
		if len(tasks) >= maxActivityDigestEntries {
			truncated = true
			continue
		}
		tasks = append(tasks, TaskDigestEntry{TaskID: taskID, Status: status, UpdatedAt: updatedAt})
	}
	return &ActivityTaskDigest{Tasks: tasks, Truncated: truncated}, true
}

func parseActivityDagDigest(data json.RawMessage) (*ActivityDagDigest, bool) {
	var doc map[string]json.RawMessage
	if json.Unmarshal(data, &doc) != nil || doc == nil {
		return nil, false
	}
	truncated, ok := parseOptionalBool(doc, "truncated_runs")
	if !ok {
		return nil, false
	}
	rawRuns, ok := doc["runs"]
	if !ok {
		return nil, false
	}
	var rows []json.RawMessage
	if json.Unmarshal(rawRuns, &rows) != nil || rows == nil {
		return nil, false
	}
	runs := make([]RunDigestEntry, 0, min(len(rows), maxActivityDigestEntries))
	retainedIDs := 0
	for _, raw := range rows {
		var row map[string]json.RawMessage
		if json.Unmarshal(raw, &row) != nil || row == nil {
			return nil, false
		}
		runID, validID := parseRequiredString(row, "run_id")
		status, validStatus := parseRequiredString(row, "status")
		if !validID || !validStatus {
			return nil, false
		}
		var nodes []json.RawMessage
		if rawNodes, present := row["nodes"]; present {
			if json.Unmarshal(rawNodes, &nodes) != nil || nodes == nil {
				return nil, false
			}
		} else {
			nodes = make([]json.RawMessage, 0)
		}
		runningIDs := make([]string, 0)
		for _, rawNode := range nodes {
			var node map[string]json.RawMessage
			if json.Unmarshal(rawNode, &node) != nil || node == nil {
				return nil, false
			}
			state, validState := parseRequiredString(node, "state")
			taskID, validTaskID := parseOptionalString(node, "task_id")
			if !validState || !validTaskID {
				return nil, false
			}
			if taskID == "" || state != "running" || terminalDagStatuses[status] {
				continue
			}
			if retainedIDs >= maxActivityDigestEntries {
				truncated = true
				continue
			}
			runningIDs = append(runningIDs, taskID)
			retainedIDs++
		}
		if terminalDagStatuses[status] {
			continue
		}
		if len(runs) >= maxActivityDigestEntries {
			truncated = true
			continue
		}
		runs = append(runs, RunDigestEntry{RunID: runID, Status: status, RunningTaskIDs: runningIDs})
	}
	return &ActivityDagDigest{Runs: runs, Truncated: truncated}, true
}

func cloneActivityTaskDigest(src *ActivityTaskDigest) *ActivityTaskDigest {
	if src == nil {
		return nil
	}
	tasks := make([]TaskDigestEntry, len(src.Tasks))
	copy(tasks, src.Tasks)
	return &ActivityTaskDigest{Tasks: tasks, Truncated: src.Truncated}
}

func cloneActivityDagDigest(src *ActivityDagDigest) *ActivityDagDigest {
	if src == nil {
		return nil
	}
	runs := make([]RunDigestEntry, len(src.Runs))
	for i, run := range src.Runs {
		ids := make([]string, len(run.RunningTaskIDs))
		copy(ids, run.RunningTaskIDs)
		runs[i] = RunDigestEntry{RunID: run.RunID, Status: run.Status, RunningTaskIDs: ids}
	}
	return &ActivityDagDigest{Runs: runs, Truncated: src.Truncated}
}
