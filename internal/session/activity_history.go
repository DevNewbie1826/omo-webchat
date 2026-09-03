package session

import (
	"container/heap"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sort"
	"syscall"
	"time"
	"unicode/utf8"
)

const (
	maxTaskStoreRecordBytes     = 4 << 20
	maxActivityHistoryBytes     = 32 << 20
	maxActivityHistoryFiles     = 2048
	maxActivityDirectoryEntries = maxActivityHistoryFiles * 4
	activityDirectoryBatchSize  = 128
	maxActivityTextBytes        = 512
	activityHistoryReadRetries  = 2
)

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

type activityHistoryBudget struct {
	entries int
	files   int
	bytes   int64
}

func (b *activityHistoryBudget) examine() bool {
	if b.entries == maxActivityDirectoryEntries {
		return false
	}
	b.entries++
	return true
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

func truncateActivityText(value string) string {
	if len(value) <= maxActivityTextBytes {
		return value
	}
	value = value[:maxActivityTextBytes]
	for !utf8.ValidString(value) {
		value = value[:len(value)-1]
	}
	return value
}

func projectedString(raw json.RawMessage) (json.RawMessage, bool) {
	var value string
	if json.Unmarshal(raw, &value) != nil {
		return nil, false
	}
	encoded, _ := json.Marshal(truncateActivityText(value))
	return encoded, true
}

func projectLiveProgress(raw json.RawMessage) json.RawMessage {
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil {
		return nil
	}
	projected := make(map[string]json.RawMessage)
	for _, key := range []string{"activity", "current_tool", "last_assistant_line"} {
		if value, ok := projectedString(fields[key]); ok {
			projected[key] = value
		}
	}
	if value, ok := projectedString(fields["started_at"]); ok {
		projected["started_at"] = value
	} else {
		var value float64
		if raw := fields["started_at"]; json.Unmarshal(raw, &value) == nil {
			projected["started_at"] = raw
		}
	}
	for _, key := range []string{"turns", "tool_calls", "total_tokens", "tokens_per_second"} {
		var value float64
		if raw := fields[key]; json.Unmarshal(raw, &value) == nil {
			projected[key] = raw
		}
	}
	if len(projected) == 0 {
		return nil
	}
	encoded, _ := json.Marshal(projected)
	return encoded
}

func projectStoredTask(task storedTask) map[string]json.RawMessage {
	projected := make(map[string]json.RawMessage, 12)
	for _, key := range []string{"task_summary", "agent_type", "category", "model", "created_at", "updated_at", "final_response", "error_message"} {
		if value, ok := projectedString(task.Fields[key]); ok {
			projected[key] = value
		}
	}
	if progress := projectLiveProgress(task.Fields["live_progress"]); progress != nil {
		projected["live_progress"] = progress
	}
	for key, value := range map[string]string{
		"task_id": task.TaskID,
		"status":  task.Status,
		"name":    rawString(task.Fields["name"]),
	} {
		if key == "name" && value == "" {
			value = task.TaskID
		}
		projected[key], _ = json.Marshal(truncateActivityText(value))
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

func truncateActivityStrings(values []string) []string {
	out := make([]string, len(values))
	for i, value := range values {
		out[i] = truncateActivityText(value)
	}
	return out
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
		depends := truncateActivityStrings(definition.DependsOn)
		if depends == nil {
			depends = []string{}
		}
		node := activityDagNode{
			ID: truncateActivityText(stored.ID), Label: truncateActivityText(label), Prompt: truncateActivityText(prompt),
			DependsOn: depends, State: truncateActivityText(stored.State), Attempt: stored.Attempt,
			TaskID: truncateActivityText(stored.TaskID), StartedAt: truncateActivityText(stored.StartedAt), CompletedAt: truncateActivityText(stored.CompletedAt),
		}
		nodes = append(nodes, node)
		for _, dependency := range depends {
			edges = append(edges, activityDagEdge{From: dependency, To: node.ID})
		}
	}
	return activityDagRun{
		RunID: truncateActivityText(run.RunID), RunKey: truncateActivityText(run.RunKey), Name: truncateActivityText(run.Name),
		Status: truncateActivityText(run.Status), CreatedAt: truncateActivityText(run.CreatedAt), UpdatedAt: truncateActivityText(run.UpdatedAt),
		Counts: dagCounts(nodes), Nodes: nodes, Edges: edges, Waves: dagWaves(nodes),
	}
}

type historicalTaskRow struct {
	createdAt string
	taskID    string
	payload   map[string]json.RawMessage
}

type historicalDagRow struct {
	createdAt string
	run       activityDagRun
}

type activityCandidateHeap []string

func (h activityCandidateHeap) Len() int           { return len(h) }
func (h activityCandidateHeap) Less(i, j int) bool { return h[i] < h[j] }
func (h activityCandidateHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *activityCandidateHeap) Push(value any)    { *h = append(*h, value.(string)) }
func (h *activityCandidateHeap) Pop() any {
	old := *h
	value := old[len(old)-1]
	*h = old[:len(old)-1]
	return value
}

func readActivityDirectory(ctx context.Context, dir string, budget *activityHistoryBudget, visit func(string, os.FileInfo)) (bool, error) {
	if err := ctx.Err(); err != nil {
		return false, err
	}
	info, err := os.Lstat(dir)
	if errors.Is(err, os.ErrNotExist) || errors.Is(err, syscall.ENOTDIR) || (err == nil && !info.IsDir()) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	f, err := os.Open(dir)
	if errors.Is(err, os.ErrNotExist) || errors.Is(err, syscall.ENOTDIR) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	defer f.Close()

	candidates := &activityCandidateHeap{}
	heap.Init(candidates)
	truncated := false
	for {
		remaining := maxActivityDirectoryEntries - budget.entries
		if remaining == 0 {
			truncated = true
			break
		}
		batchSize := min(activityDirectoryBatchSize, remaining)
		entries, readErr := f.ReadDir(batchSize)
		for _, entry := range entries {
			if err := ctx.Err(); err != nil {
				return false, err
			}
			if !budget.examine() {
				return true, nil
			}
			if filepath.Ext(entry.Name()) != ".json" || entry.Type()&os.ModeSymlink != 0 {
				continue
			}
			heap.Push(candidates, entry.Name())
			if candidates.Len() > maxActivityHistoryFiles {
				heap.Pop(candidates)
				truncated = true
			}
		}
		if errors.Is(readErr, io.EOF) {
			break
		}
		if readErr != nil {
			return false, readErr
		}
	}

	names := make([]string, candidates.Len())
	for i := len(names) - 1; i >= 0; i-- {
		names[i] = heap.Pop(candidates).(string)
	}
	sort.Sort(sort.Reverse(sort.StringSlice(names)))
	for _, name := range names {
		if err := ctx.Err(); err != nil {
			return false, err
		}
		path := filepath.Join(dir, name)
		info, err := os.Lstat(path)
		if err != nil || info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() || info.Size() < 0 || info.Size() > maxTaskStoreRecordBytes {
			continue
		}
		if !budget.reserve(info.Size()) {
			return true, nil
		}
		visit(path, info)
	}
	return truncated, nil
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

type historicalTaskSnapshot struct {
	ParentSessionID string                       `json:"parent_session_id"`
	Truncated       bool                         `json:"truncated_tasks"`
	Tasks           []map[string]json.RawMessage `json:"tasks"`
}

type historicalDagSnapshot struct {
	ParentSessionID string           `json:"parent_session_id"`
	Truncated       bool             `json:"truncated_runs"`
	Runs            []activityDagRun `json:"runs"`
}

func packTaskSnapshot(parent string, rows []historicalTaskRow, truncated bool) (json.RawMessage, bool, error) {
	out := historicalTaskSnapshot{ParentSessionID: truncateActivityText(parent), Tasks: make([]map[string]json.RawMessage, 0, len(rows))}
	omitted := false
	for _, row := range rows {
		out.Tasks = append(out.Tasks, row.payload)
		candidate, err := json.Marshal(out)
		if err != nil {
			return nil, false, err
		}
		if len(candidate) > maxActivitySnapshotBytes {
			out.Tasks = out.Tasks[:len(out.Tasks)-1]
			omitted = true
			break
		}
	}
	out.Truncated = truncated || omitted
	payload, err := json.Marshal(out)
	return json.RawMessage(payload), omitted, err
}

func packDagSnapshot(parent string, rows []historicalDagRow, truncated bool) (json.RawMessage, bool, error) {
	out := historicalDagSnapshot{ParentSessionID: truncateActivityText(parent), Runs: make([]activityDagRun, 0, len(rows))}
	omitted := false
	for _, row := range rows {
		out.Runs = append(out.Runs, row.run)
		candidate, err := json.Marshal(out)
		if err != nil {
			return nil, false, err
		}
		if len(candidate) > maxActivitySnapshotBytes {
			out.Runs = out.Runs[:len(out.Runs)-1]
			omitted = true
			break
		}
	}
	out.Truncated = truncated || omitted
	payload, err := json.Marshal(out)
	return json.RawMessage(payload), omitted, err
}

func boundTaskDigest(digest *TaskDigest) {
	for len(digest.Tasks) > 0 {
		payload, err := json.Marshal(digest)
		if err == nil && len(payload) <= maxActivitySnapshotBytes {
			return
		}
		digest.Tasks = digest.Tasks[:len(digest.Tasks)-1]
		digest.Truncated = true
	}
}

func boundDagDigest(digest *DagDigest) {
	for {
		payload, err := json.Marshal(digest)
		if err == nil && len(payload) <= maxActivitySnapshotBytes {
			return
		}
		digest.Truncated = true
		if len(digest.Runs) == 0 {
			return
		}
		last := &digest.Runs[len(digest.Runs)-1]
		if len(last.RunningTaskIDs) > 0 {
			last.RunningTaskIDs = last.RunningTaskIDs[:len(last.RunningTaskIDs)-1]
		} else {
			digest.Runs = digest.Runs[:len(digest.Runs)-1]
		}
	}
}

// ReadHistoricalActivity reads the exact task-store directories observed under
// a validated chat cwd and returns only records linked to durableSessionID.
// Malformed or concurrently replaced records are skipped, while cancellation
// and aggregate scan budgets bound work over hostile or damaged stores.
func ReadHistoricalActivity(ctx context.Context, cwd, durableSessionID string) (HistoricalActivity, error) {
	base := filepath.Join(cwd, ".omo", "senpi-task")
	taskBudget := &activityHistoryBudget{}
	tasks := make([]historicalTaskRow, 0)
	ownedRuns := make(map[string]bool)
	taskBudgetExhausted, err := readActivityDirectory(ctx, filepath.Join(base, "tasks"), taskBudget, func(path string, info os.FileInfo) {
		var task storedTask
		if !readStableJSON(ctx, path, info, &task) || durableSessionID == "" || task.TaskID == "" || task.Status == "" || task.ParentSessionID != durableSessionID {
			return
		}
		if task.Owner.Kind == "dag" && task.Owner.RunID != "" {
			ownedRuns[task.Owner.RunID] = true
		}
		tasks = append(tasks, historicalTaskRow{
			createdAt: task.CreatedAt, taskID: task.TaskID, payload: projectStoredTask(task),
		})
	})
	if err != nil {
		return HistoricalActivity{}, err
	}
	tasks, taskRetentionTruncated := newestTaskRows(tasks)
	truncatedTasks := taskBudgetExhausted || taskRetentionTruncated
	taskPayload, taskOversized, err := packTaskSnapshot(durableSessionID, tasks, truncatedTasks)
	if err != nil {
		return HistoricalActivity{}, err
	}

	runs := make([]historicalDagRow, 0)
	runBudget := &activityHistoryBudget{}
	runBudgetExhausted, err := readActivityDirectory(ctx, filepath.Join(base, "dag", "runs"), runBudget, func(path string, info os.FileInfo) {
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
	runs, runRetentionTruncated := newestDagRows(runs)
	truncatedRuns := runBudgetExhausted || runRetentionTruncated
	dagPayload, dagOversized, err := packDagSnapshot(durableSessionID, runs, truncatedRuns)
	if err != nil {
		return HistoricalActivity{}, err
	}

	receivedAt := time.Now().UTC().Format(time.RFC3339)
	taskDigest, _ := parseTaskDigest(taskPayload)
	dagDigest, _ := parseDagDigest(dagPayload)
	taskDigest.ReceivedAt = receivedAt
	dagDigest.ReceivedAt = receivedAt
	boundTaskDigest(taskDigest)
	boundDagDigest(dagDigest)
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
