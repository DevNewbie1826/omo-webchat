package chat

import (
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

// RunDigestEntry is one compact non-terminal dag run extracted for counts.
type RunDigestEntry struct {
	RunID          string   `json:"run_id"`
	Status         string   `json:"status"`
	RunningTaskIDs []string `json:"running_task_ids"`
}

// ActivityDagDigest is the in-memory dag-count summary of one session.
type ActivityDagDigest struct {
	Runs      []RunDigestEntry `json:"runs"`
	Truncated bool             `json:"truncated"`
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

func parseActivityTaskDigest(data json.RawMessage) (*ActivityTaskDigest, bool) {
	var payload struct {
		TruncatedTasks bool `json:"truncated_tasks"`
		Tasks          []struct {
			TaskID    string `json:"task_id"`
			Status    string `json:"status"`
			UpdatedAt string `json:"updated_at"`
		} `json:"tasks"`
	}
	if json.Unmarshal(data, &payload) != nil {
		return nil, false
	}
	n := len(payload.Tasks)
	truncated := payload.TruncatedTasks
	if n > maxActivityDigestEntries {
		n = maxActivityDigestEntries
		truncated = true
	}
	tasks := make([]TaskDigestEntry, n)
	for i, row := range payload.Tasks[:n] {
		tasks[i] = TaskDigestEntry{TaskID: row.TaskID, Status: row.Status, UpdatedAt: row.UpdatedAt}
	}
	return &ActivityTaskDigest{Tasks: tasks, Truncated: truncated}, true
}

func parseActivityDagDigest(data json.RawMessage) (*ActivityDagDigest, bool) {
	var payload struct {
		Truncated bool `json:"truncated"`
		Runs      []struct {
			RunID  string `json:"run_id"`
			Status string `json:"status"`
			Nodes  []struct {
				TaskID string `json:"task_id"`
				State  string `json:"state"`
			} `json:"nodes"`
		} `json:"runs"`
	}
	if json.Unmarshal(data, &payload) != nil {
		return nil, false
	}
	runs := make([]RunDigestEntry, 0, min(len(payload.Runs), maxActivityDigestEntries))
	truncated := payload.Truncated
	for _, run := range payload.Runs {
		if terminalDagStatuses[run.Status] {
			continue
		}
		if len(runs) >= maxActivityDigestEntries {
			truncated = true
			break
		}
		runningIDs := make([]string, 0)
		for _, node := range run.Nodes {
			if node.TaskID != "" && node.State == "running" {
				runningIDs = append(runningIDs, node.TaskID)
			}
		}
		runs = append(runs, RunDigestEntry{RunID: run.RunID, Status: run.Status, RunningTaskIDs: runningIDs})
	}
	return &ActivityDagDigest{Runs: runs, Truncated: truncated}, true
}

func cloneActivityTaskDigest(src *ActivityTaskDigest) *ActivityTaskDigest {
	if src == nil {
		return nil
	}
	return &ActivityTaskDigest{
		Tasks:     append([]TaskDigestEntry(nil), src.Tasks...),
		Truncated: src.Truncated,
	}
}

func cloneActivityDagDigest(src *ActivityDagDigest) *ActivityDagDigest {
	if src == nil {
		return nil
	}
	runs := make([]RunDigestEntry, len(src.Runs))
	for i, run := range src.Runs {
		runs[i] = RunDigestEntry{
			RunID:          run.RunID,
			Status:         run.Status,
			RunningTaskIDs: append([]string(nil), run.RunningTaskIDs...),
		}
	}
	return &ActivityDagDigest{Runs: runs, Truncated: src.Truncated}
}
