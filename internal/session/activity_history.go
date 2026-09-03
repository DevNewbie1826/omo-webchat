package session

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"sort"
)

const maxTaskStoreRecordBytes = 4 << 20

// HistoricalActivity is the on-disk counterpart of the stage-8 live activity
// projection. ActivityPair carries the full shelf snapshots; the digests are
// built by the same parsers used for live engine events.
type HistoricalActivity struct {
	ActivityPair  ActivityPair
	TaskDigest    *TaskDigest
	DagDigest     *DagDigest
	TaskOversized bool
	DagOversized  bool
}

type storedTask struct {
	TaskID          string `json:"task_id"`
	Status          string `json:"status"`
	ParentSessionID string `json:"parent_session_id"`
	CreatedAt       string `json:"created_at"`
	Owner           struct {
		Kind   string `json:"kind"`
		RunID  string `json:"runId"`
		NodeID string `json:"nodeId"`
	} `json:"owner"`
	Fields map[string]json.RawMessage `json:"-"`
}

func (t *storedTask) UnmarshalJSON(data []byte) error {
	type plain storedTask
	var decoded plain
	if err := json.Unmarshal(data, &decoded); err != nil {
		return err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return err
	}
	*t = storedTask(decoded)
	t.Fields = fields
	return nil
}

type storedDagNodeDefinition struct {
	ID        string   `json:"id"`
	Label     string   `json:"label"`
	Prompt    string   `json:"prompt"`
	DependsOn []string `json:"dependsOn"`
}

type storedDagNode struct {
	ID          string `json:"id"`
	Label       string `json:"label"`
	Prompt      string `json:"prompt"`
	State       string `json:"state"`
	Attempt     int    `json:"attempt"`
	TaskID      string `json:"taskId"`
	StartedAt   string `json:"startedAt"`
	CompletedAt string `json:"completedAt"`
}

type storedDagRun struct {
	SchemaVersion   int    `json:"schemaVersion"`
	RunID           string `json:"runId"`
	RunKey          string `json:"runKey"`
	Name            string `json:"name"`
	ParentSessionID string `json:"parentSessionId"`
	Status          string `json:"status"`
	CreatedAt       string `json:"createdAt"`
	UpdatedAt       string `json:"updatedAt"`
	Definition      struct {
		Nodes []storedDagNodeDefinition `json:"nodes"`
	} `json:"definition"`
	Nodes []storedDagNode `json:"nodes"`
}

type activityDagCounts struct {
	Total     int `json:"total"`
	Pending   int `json:"pending"`
	Blocked   int `json:"blocked"`
	Scheduled int `json:"scheduled"`
	Running   int `json:"running"`
	Completed int `json:"completed"`
	Failed    int `json:"failed"`
	Cancelled int `json:"cancelled"`
	Skipped   int `json:"skipped"`
}

type activityDagNode struct {
	ID          string   `json:"id"`
	Label       string   `json:"label,omitempty"`
	Prompt      string   `json:"prompt"`
	DependsOn   []string `json:"depends_on"`
	State       string   `json:"state"`
	Attempt     int      `json:"attempt,omitempty"`
	TaskID      string   `json:"task_id,omitempty"`
	StartedAt   string   `json:"started_at,omitempty"`
	CompletedAt string   `json:"completed_at,omitempty"`
}

type activityDagEdge struct {
	From string `json:"from"`
	To   string `json:"to"`
}

type activityDagWave struct {
	Index   int      `json:"index"`
	NodeIDs []string `json:"node_ids"`
}

type activityDagRun struct {
	RunID     string            `json:"run_id"`
	RunKey    string            `json:"run_key"`
	Name      string            `json:"name"`
	Status    string            `json:"status"`
	CreatedAt string            `json:"created_at,omitempty"`
	UpdatedAt string            `json:"updated_at,omitempty"`
	Counts    activityDagCounts `json:"counts"`
	Nodes     []activityDagNode `json:"nodes"`
	Edges     []activityDagEdge `json:"edges"`
	Waves     []activityDagWave `json:"waves"`
}

var taskSnapshotFields = [...]string{
	"task_id", "child_session_id", "status", "task_summary", "name", "agent_type",
	"category", "execution_mode", "model", "residency_state", "depth", "created_at",
	"updated_at", "run_stats", "live_progress", "final_response", "error_message",
}

func readBoundedJSON(path string, target any) bool {
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, maxTaskStoreRecordBytes+1))
	if err != nil || len(data) > maxTaskStoreRecordBytes {
		return false
	}
	return json.Unmarshal(data, target) == nil
}

func projectStoredTask(task storedTask) map[string]json.RawMessage {
	projected := make(map[string]json.RawMessage, len(taskSnapshotFields))
	for _, key := range taskSnapshotFields {
		if value := task.Fields[key]; len(bytes.TrimSpace(value)) > 0 {
			projected[key] = value
		}
	}
	if _, ok := projected["name"]; !ok {
		projected["name"], _ = json.Marshal(task.TaskID)
	}
	return projected
}

func dagCounts(nodes []activityDagNode) activityDagCounts {
	counts := activityDagCounts{Total: len(nodes)}
	for _, node := range nodes {
		switch node.State {
		case "pending":
			counts.Pending++
		case "blocked":
			counts.Blocked++
		case "scheduled":
			counts.Scheduled++
		case "running":
			counts.Running++
		case "completed":
			counts.Completed++
		case "failed", "error":
			counts.Failed++
		case "cancelled", "canceled":
			counts.Cancelled++
		case "skipped":
			counts.Skipped++
		}
	}
	return counts
}

func dagWaves(nodes []activityDagNode) []activityDagWave {
	remaining := make(map[string]activityDagNode, len(nodes))
	for _, node := range nodes {
		remaining[node.ID] = node
	}
	seen := make(map[string]bool, len(nodes))
	waves := make([]activityDagWave, 0)
	for len(remaining) > 0 {
		ids := make([]string, 0)
		for id, node := range remaining {
			ready := true
			for _, dependency := range node.DependsOn {
				if !seen[dependency] {
					ready = false
					break
				}
			}
			if ready {
				ids = append(ids, id)
			}
		}
		if len(ids) == 0 { // Corrupt dependency cycle: retain all nodes honestly.
			for id := range remaining {
				ids = append(ids, id)
			}
		}
		sort.Strings(ids)
		waves = append(waves, activityDagWave{Index: len(waves), NodeIDs: ids})
		for _, id := range ids {
			seen[id] = true
			delete(remaining, id)
		}
	}
	return waves
}

func projectStoredDag(run storedDagRun) activityDagRun {
	definitions := make(map[string]storedDagNodeDefinition, len(run.Definition.Nodes))
	for _, node := range run.Definition.Nodes {
		definitions[node.ID] = node
	}
	nodes := make([]activityDagNode, 0, len(run.Nodes))
	edges := make([]activityDagEdge, 0)
	for _, stored := range run.Nodes {
		definition := definitions[stored.ID]
		label, prompt := stored.Label, stored.Prompt
		if label == "" {
			label = definition.Label
		}
		if prompt == "" {
			prompt = definition.Prompt
		}
		depends := append([]string(nil), definition.DependsOn...)
		if depends == nil {
			depends = []string{}
		}
		node := activityDagNode{ID: stored.ID, Label: label, Prompt: prompt, DependsOn: depends, State: stored.State, Attempt: stored.Attempt, TaskID: stored.TaskID, StartedAt: stored.StartedAt, CompletedAt: stored.CompletedAt}
		nodes = append(nodes, node)
		for _, dependency := range depends {
			edges = append(edges, activityDagEdge{From: dependency, To: stored.ID})
		}
	}
	return activityDagRun{RunID: run.RunID, RunKey: run.RunKey, Name: run.Name, Status: run.Status, CreatedAt: run.CreatedAt, UpdatedAt: run.UpdatedAt, Counts: dagCounts(nodes), Nodes: nodes, Edges: edges, Waves: dagWaves(nodes)}
}

// ReadHistoricalActivity reads the task store observed under a chat's cwd and
// returns only records linked to durableSessionID. Malformed or concurrently
// replaced records are skipped, so partial stores degrade to an honest subset.
func ReadHistoricalActivity(cwd, durableSessionID string) (HistoricalActivity, error) {
	base := filepath.Join(cwd, ".omo", "senpi-task")
	taskPaths, err := filepath.Glob(filepath.Join(base, "tasks", "*.json"))
	if err != nil {
		return HistoricalActivity{}, err
	}
	tasks := make([]storedTask, 0)
	ownedRuns := make(map[string]bool)
	truncatedTasks := false
	for _, path := range taskPaths {
		var task storedTask
		if !readBoundedJSON(path, &task) || durableSessionID == "" || task.TaskID == "" || task.Status == "" || task.ParentSessionID != durableSessionID {
			continue
		}
		if task.Owner.Kind == "dag" && task.Owner.RunID != "" {
			ownedRuns[task.Owner.RunID] = true
		}
		if len(tasks) == maxActivityDigestEntries {
			truncatedTasks = true
			continue
		}
		tasks = append(tasks, task)
	}
	sort.Slice(tasks, func(i, j int) bool {
		if tasks[i].CreatedAt == tasks[j].CreatedAt {
			return tasks[i].TaskID < tasks[j].TaskID
		}
		return tasks[i].CreatedAt < tasks[j].CreatedAt
	})
	taskRows := make([]map[string]json.RawMessage, len(tasks))
	for i, task := range tasks {
		taskRows[i] = projectStoredTask(task)
	}
	taskPayload, err := json.Marshal(struct {
		ParentSessionID string                       `json:"parent_session_id"`
		Truncated       bool                         `json:"truncated_tasks"`
		Tasks           []map[string]json.RawMessage `json:"tasks"`
	}{durableSessionID, truncatedTasks, taskRows})
	if err != nil {
		return HistoricalActivity{}, err
	}

	runPaths, err := filepath.Glob(filepath.Join(base, "dag", "runs", "*.json"))
	if err != nil {
		return HistoricalActivity{}, err
	}
	runs := make([]storedDagRun, 0)
	truncatedRuns := false
	for _, path := range runPaths {
		var run storedDagRun
		if !readBoundedJSON(path, &run) || durableSessionID == "" || run.RunID == "" || run.Status == "" || (run.ParentSessionID != durableSessionID && !ownedRuns[run.RunID]) {
			continue
		}
		if len(runs) == maxActivityDigestEntries {
			truncatedRuns = true
			continue
		}
		runs = append(runs, run)
	}
	sort.Slice(runs, func(i, j int) bool {
		if runs[i].CreatedAt == runs[j].CreatedAt {
			return runs[i].RunID < runs[j].RunID
		}
		return runs[i].CreatedAt < runs[j].CreatedAt
	})
	dagRows := make([]activityDagRun, len(runs))
	for i, run := range runs {
		dagRows[i] = projectStoredDag(run)
	}
	dagPayload, err := json.Marshal(struct {
		ParentSessionID string           `json:"parent_session_id"`
		Truncated       bool             `json:"truncated_runs"`
		Runs            []activityDagRun `json:"runs"`
	}{durableSessionID, truncatedRuns, dagRows})
	if err != nil {
		return HistoricalActivity{}, err
	}

	taskDigest, _ := parseTaskDigest(taskPayload)
	dagDigest, _ := parseDagDigest(dagPayload)
	return HistoricalActivity{ActivityPair: ActivityPair{Task: taskPayload, Dag: dagPayload}, TaskDigest: taskDigest, DagDigest: dagDigest}, nil
}
