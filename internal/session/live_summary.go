package session

import "time"

// LiveValues is the rendered projection shared by REST and sessions.activity.
// Rich activity and provenance remain on the attached chat activity surface.
type LiveValues struct {
	LastActivityMS *int64        `json:"last_activity_ms,omitempty"`
	Running        LiveRunning   `json:"running"`
	Done           int64         `json:"done"`
	DagDone        int64         `json:"dag_done"`
	DagTotal       int64         `json:"dag_total"`
	Truncated      LiveTruncated `json:"truncated"`
	LastLine       *string       `json:"last_line,omitempty"`
}

type LiveRunning struct {
	Agents int64 `json:"agents"`
	Tasks  int64 `json:"tasks"`
	Dag    int64 `json:"dag"`
}

type LiveTruncated struct {
	Task bool `json:"task"`
	Dag  bool `json:"dag"`
}

// LiveValues reads only cached scalars; it never reparses snapshots on a poll.
func (s Summary) LiveValues() LiveValues {
	out := LiveValues{Truncated: LiveTruncated{
		Task: s.TaskOversized || (s.TaskDigest == nil && len(s.ActivityPair.Task) > 0),
		Dag:  s.DagOversized || (s.DagDigest == nil && len(s.ActivityPair.Dag) > 0),
	}}
	if task := s.TaskDigest; task != nil {
		out.Running.Tasks = int64(task.RunningCount)
		out.Running.Agents = int64(task.AgentRunningCount)
		out.Done = int64(task.liveDone)
		out.LastLine = task.liveLastLine
		out.Truncated.Task = out.Truncated.Task || task.Truncated || task.liveIncomplete
		out.LastActivityMS = receiptMillis(task.ReceivedAt)
	}
	if dag := s.DagDigest; dag != nil {
		out.Running.Agents = int64(dag.AgentRunningCount)
		out.Running.Dag = int64(dag.liveRunning)
		out.DagDone, out.DagTotal = int64(dag.liveDone), int64(dag.liveTotal)
		out.Truncated.Dag = out.Truncated.Dag || dag.Truncated || dag.liveIncomplete || dag.RunCountsUnavailable
		if at := receiptMillis(dag.ReceivedAt); at != nil && (out.LastActivityMS == nil || *at > *out.LastActivityMS) {
			out.LastActivityMS = at
		}
	}
	return out
}

func receiptMillis(received string) *int64 {
	at, err := time.Parse(time.RFC3339Nano, received)
	if err != nil {
		return nil
	}
	millis := at.UnixMilli()
	return &millis
}

// Refresh alongside exact agent authority, after task eviction corrections.
func publishLiveCounts(task *TaskDigest, dag *DagDigest, caches liveCountCaches) {
	if task != nil {
		task.liveDone = 0
		task.liveIncomplete = !caches.tasks.countAuthorityKnown
		for _, member := range caches.tasks.countMembers {
			// Match taskStatusCounts, which does not classify the alias canceled.
			if member.present && terminalTaskStatuses[member.status] && member.status != "canceled" {
				task.liveDone++
			}
		}
	}
	if dag == nil {
		return
	}
	dag.liveDone, dag.liveTotal = 0, 0
	dag.liveIncomplete = !caches.dags.countAuthorityKnown
	dag.liveRunning = dag.RunningCount
	for _, run := range caches.dags.countRuns {
		if run.present || run.terminal {
			dag.liveDone += run.completed
			dag.liveTotal += run.total
			dag.liveIncomplete = dag.liveIncomplete || run.countsIncomplete
		}
	}
	// The old client subtracts unique running task IDs only when BOTH identity
	// projections are complete. Otherwise the exact node scalar stands alone.
	if task == nil {
		return
	}
	taskComplete, dagComplete := task.liveRosterComplete, dag.liveRosterComplete
	if caches.tasks.oversized {
		taskComplete = !task.Truncated
	}
	if caches.dags.oversized {
		dagComplete = !dag.Truncated
	}
	if !taskComplete || !dagComplete {
		return
	}
	seen := make(map[agentWorkKey]bool)
	for _, run := range caches.dags.countRuns {
		if !run.present {
			continue
		}
		for _, work := range run.works {
			member := caches.tasks.countMembers[work.key.hash]
			if work.running && work.key.task && member.present && !seen[work.key] {
				dag.liveRunning--
				seen[work.key] = true
			}
		}
	}
	dag.liveRunning = max(0, dag.liveRunning)
}

type liveCountCaches struct {
	tasks *taskSnapshotCache
	dags  *dagSnapshotCache
}
