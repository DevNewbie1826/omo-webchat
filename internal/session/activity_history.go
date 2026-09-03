package session

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sort"
	"time"
)

const (
	maxTaskStoreRecordBytes    = 4 << 20
	maxActivityHistoryBytes    = 32 << 20
	maxActivityHistoryFiles    = 2048
	activityHistoryReadRetries = 2
)

var errActivitySnapshotOversized = errors.New("activity snapshot exceeds replay limit")

// HistoricalActivity is the on-disk counterpart of the stage-8 live activity
// projection. ActivityPair carries only snapshots within the replay cap;
// digests remain available when a projected shelf is oversized.
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

type activityHistoryBudget struct {
	files int
	bytes int64
}

func (b *activityHistoryBudget) reserve(size int64) bool {
	if size < 0 || b.files == maxActivityHistoryFiles || b.bytes+size > maxActivityHistoryBytes {
		return false
	}
	b.files++
	b.bytes += size
	return true
}

type contextReader struct {
	ctx context.Context
	r   io.Reader
}

func (r contextReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.r.Read(p)
}

func sameFileState(left, right os.FileInfo) bool {
	return os.SameFile(left, right) && left.Mode().IsRegular() && right.Mode().IsRegular() &&
		left.Size() == right.Size() && left.ModTime() == right.ModTime()
}

// readStableJSON rejects symlinks and records that change identity, size, or
// mtime while being read. A single retry tolerates an atomic checkpoint write.
func readStableJSON(ctx context.Context, path string, expected os.FileInfo, target any) bool {
	for attempt := 0; attempt < activityHistoryReadRetries; attempt++ {
		if ctx.Err() != nil {
			return false
		}
		before, err := os.Lstat(path)
		if err != nil || before.Mode()&os.ModeSymlink != 0 || !sameFileState(expected, before) {
			return false
		}
		f, err := os.Open(path)
		if err != nil {
			return false
		}
		opened, statErr := f.Stat()
		data, readErr := io.ReadAll(io.LimitReader(contextReader{ctx: ctx, r: f}, maxTaskStoreRecordBytes+1))
		afterOpen, afterOpenErr := f.Stat()
		closeErr := f.Close()
		afterPath, pathErr := os.Lstat(path)
		stable := statErr == nil && afterOpenErr == nil && pathErr == nil && afterPath.Mode()&os.ModeSymlink == 0 &&
			sameFileState(before, opened) && sameFileState(opened, afterOpen) && sameFileState(afterOpen, afterPath)
		if readErr == nil && closeErr == nil && stable && len(data) <= maxTaskStoreRecordBytes {
			return json.Unmarshal(data, target) == nil
		}
		if ctx.Err() != nil || afterPath == nil || afterPath.Mode()&os.ModeSymlink != 0 || !afterPath.Mode().IsRegular() {
			return false
		}
		expected = afterPath
	}
	return false
}

func boundedActivitySnapshot(value any) (json.RawMessage, bool, error) {
	var out bytes.Buffer
	writer := &activitySnapshotWriter{buffer: &out}
	if err := json.NewEncoder(writer).Encode(value); err != nil {
		if errors.Is(err, errActivitySnapshotOversized) {
			return nil, true, nil
		}
		return nil, false, err
	}
	payload := bytes.TrimSuffix(out.Bytes(), []byte{'\n'})
	if len(payload) > maxActivitySnapshotBytes {
		return nil, true, nil
	}
	return json.RawMessage(payload), false, nil
}

type activitySnapshotWriter struct {
	buffer *bytes.Buffer
}

func (w *activitySnapshotWriter) Write(p []byte) (int, error) {
	// Encoder appends one newline outside the JSON value.
	if len(p) > maxActivitySnapshotBytes+1-w.buffer.Len() {
		return 0, errActivitySnapshotOversized
	}
	return w.buffer.Write(p)
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

type historicalTaskRow struct {
	createdAt string
	taskID    string
	status    string
	updatedAt string
	payload   map[string]json.RawMessage
}

type historicalDagRow struct {
	createdAt string
	run       activityDagRun
}

func readActivityDirectory(ctx context.Context, dir string, budget *activityHistoryBudget, visit func(string, os.FileInfo)) (bool, error) {
	if err := ctx.Err(); err != nil {
		return false, err
	}
	entries, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	for _, entry := range entries {
		if err := ctx.Err(); err != nil {
			return false, err
		}
		if filepath.Ext(entry.Name()) != ".json" || entry.Type()&os.ModeSymlink != 0 {
			continue
		}
		info, err := entry.Info()
		if err != nil || !info.Mode().IsRegular() || info.Size() < 0 || info.Size() > maxTaskStoreRecordBytes {
			continue
		}
		if !budget.reserve(info.Size()) {
			return true, nil
		}
		visit(filepath.Join(dir, entry.Name()), info)
	}
	if err := ctx.Err(); err != nil {
		return false, err
	}
	return false, nil
}

func newestTaskRows(rows []historicalTaskRow) ([]historicalTaskRow, bool) {
	sort.Slice(rows, func(i, j int) bool {
		if rows[i].createdAt == rows[j].createdAt {
			return rows[i].taskID > rows[j].taskID
		}
		return rows[i].createdAt > rows[j].createdAt
	})
	if len(rows) <= maxActivityDigestEntries {
		return rows, false
	}
	return rows[:maxActivityDigestEntries], true
}

func newestDagRows(rows []historicalDagRow) ([]historicalDagRow, bool) {
	sort.Slice(rows, func(i, j int) bool {
		if rows[i].createdAt == rows[j].createdAt {
			return rows[i].run.RunID > rows[j].run.RunID
		}
		return rows[i].createdAt > rows[j].createdAt
	})
	if len(rows) <= maxActivityDigestEntries {
		return rows, false
	}
	return rows[:maxActivityDigestEntries], true
}

// ReadHistoricalActivity reads the exact task-store directories observed under
// a validated chat cwd and returns only records linked to durableSessionID.
// Malformed or concurrently replaced records are skipped, while cancellation
// and aggregate scan budgets bound work over hostile or damaged stores.
func ReadHistoricalActivity(ctx context.Context, cwd, durableSessionID string) (HistoricalActivity, error) {
	base := filepath.Join(cwd, ".omo", "senpi-task")
	budget := &activityHistoryBudget{}
	tasks := make([]historicalTaskRow, 0)
	ownedRuns := make(map[string]bool)
	taskBudgetExhausted, err := readActivityDirectory(ctx, filepath.Join(base, "tasks"), budget, func(path string, info os.FileInfo) {
		var task storedTask
		if !readStableJSON(ctx, path, info, &task) || durableSessionID == "" || task.TaskID == "" || task.Status == "" || task.ParentSessionID != durableSessionID {
			return
		}
		if task.Owner.Kind == "dag" && task.Owner.RunID != "" {
			ownedRuns[task.Owner.RunID] = true
		}
		tasks = append(tasks, historicalTaskRow{
			createdAt: task.CreatedAt, taskID: task.TaskID, status: task.Status,
			updatedAt: rawString(task.Fields["updated_at"]), payload: projectStoredTask(task),
		})
	})
	if err != nil {
		return HistoricalActivity{}, err
	}
	tasks, taskRetentionTruncated := newestTaskRows(tasks)
	truncatedTasks := taskBudgetExhausted || taskRetentionTruncated
	taskRows := make([]map[string]json.RawMessage, len(tasks))
	taskDigestRows := make([]TaskDigestEntry, len(tasks))
	for i, task := range tasks {
		taskRows[i] = task.payload
		taskDigestRows[i] = TaskDigestEntry{TaskID: task.taskID, Status: task.status, UpdatedAt: task.updatedAt}
	}
	taskPayload, taskOversized, err := boundedActivitySnapshot(struct {
		ParentSessionID string                       `json:"parent_session_id"`
		Truncated       bool                         `json:"truncated_tasks"`
		Tasks           []map[string]json.RawMessage `json:"tasks"`
	}{durableSessionID, truncatedTasks, taskRows})
	if err != nil {
		return HistoricalActivity{}, err
	}

	runs := make([]historicalDagRow, 0)
	runBudgetExhausted := taskBudgetExhausted
	if !runBudgetExhausted {
		runBudgetExhausted, err = readActivityDirectory(ctx, filepath.Join(base, "dag", "runs"), budget, func(path string, info os.FileInfo) {
			var run storedDagRun
			if !readStableJSON(ctx, path, info, &run) || durableSessionID == "" || run.RunID == "" || run.Status == "" ||
				(run.ParentSessionID != durableSessionID && !(run.ParentSessionID == "" && ownedRuns[run.RunID])) {
				return
			}
			runs = append(runs, historicalDagRow{createdAt: run.CreatedAt, run: projectStoredDag(run)})
		})
		if err != nil {
			return HistoricalActivity{}, err
		}
	}
	runs, runRetentionTruncated := newestDagRows(runs)
	truncatedRuns := runBudgetExhausted || runRetentionTruncated
	dagRows := make([]activityDagRun, len(runs))
	for i, run := range runs {
		dagRows[i] = run.run
	}
	dagPayload, dagOversized, err := boundedActivitySnapshot(struct {
		ParentSessionID string           `json:"parent_session_id"`
		Truncated       bool             `json:"truncated_runs"`
		Runs            []activityDagRun `json:"runs"`
	}{durableSessionID, truncatedRuns, dagRows})
	if err != nil {
		return HistoricalActivity{}, err
	}

	receivedAt := time.Now().UTC().Format(time.RFC3339)
	taskDigest := &TaskDigest{Tasks: taskDigestRows, Truncated: truncatedTasks, ReceivedAt: receivedAt}
	dagDigest := historicalDagDigest(dagRows, truncatedRuns, receivedAt)
	return HistoricalActivity{
		ActivityPair: ActivityPair{Task: taskPayload, Dag: dagPayload},
		TaskDigest:   taskDigest, DagDigest: dagDigest,
		TaskOversized: taskOversized, DagOversized: dagOversized,
	}, nil
}

func rawString(raw json.RawMessage) string {
	var value string
	if json.Unmarshal(raw, &value) != nil {
		return ""
	}
	return value
}

func historicalDagDigest(rows []activityDagRun, truncated bool, receivedAt string) *DagDigest {
	digest := &DagDigest{Runs: make([]RunDigestEntry, 0, len(rows)), Truncated: truncated, ReceivedAt: receivedAt}
	retainedTaskIDs := 0
	for _, run := range rows {
		if terminalDagStatuses[run.Status] {
			continue
		}
		entry := RunDigestEntry{RunID: run.RunID, Status: run.Status, RunningTaskIDs: []string{}}
		for _, node := range run.Nodes {
			if node.State != "running" || node.TaskID == "" {
				continue
			}
			if retainedTaskIDs == maxActivityDigestEntries {
				digest.Truncated = true
				continue
			}
			entry.RunningTaskIDs = append(entry.RunningTaskIDs, node.TaskID)
			retainedTaskIDs++
		}
		digest.Runs = append(digest.Runs, entry)
	}
	return digest
}
