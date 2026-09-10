package session

import (
	"fmt"
	"testing"
	"time"
)

// Regression (review r4/G1): bounded retention can evict a task's rich row
// while the full count membership keeps tracking it. An accepted terminal DAG
// outcome that completes such an evicted task must still correct every
// published count scalar, not only the agent aggregate pair.
func evictedOutcomeTasks() []map[string]any {
	tasks := make([]map[string]any, maxActivityDigestEntries+1)
	for i := range tasks {
		status := "completed"
		if i == 0 {
			status = "running"
		}
		tasks[i] = taskOrderingRow(fmt.Sprintf("task-%04d", i), status, dagCurrent)
	}
	return tasks
}

func evictedOutcomeRun() map[string]any {
	run := dagOrderingRun("outcome", "completed", dagNewer)
	run["nodes"] = []any{map[string]any{"id": "node", "task_id": "task-0000", "state": "completed"}}
	return run
}

func assertEvictedOutcomeCorrected(t *testing.T, digest *TaskDigest, stage string) {
	t.Helper()
	if digest == nil {
		t.Fatalf("%s: missing task digest", stage)
	}
	if digest.RunningCount != 0 || digest.AgentRunningCount != 0 {
		t.Errorf("%s: evicted completion left running scalars task=%d agent=%d, want both 0", stage, digest.RunningCount, digest.AgentRunningCount)
	}
	if digest.TotalCount != maxActivityDigestEntries+1 || digest.AgentTotalCount != maxActivityDigestEntries+1 {
		t.Errorf("%s: total scalars task=%d agent=%d, want %d on both", stage, digest.TotalCount, digest.AgentTotalCount, maxActivityDigestEntries+1)
	}
	if len(digest.Tasks) != maxActivityDigestEntries {
		t.Errorf("%s: digest rows=%d, want the %d-entry retention bound", stage, len(digest.Tasks), maxActivityDigestEntries)
	}
	for _, row := range digest.Tasks {
		if row.TaskID == "task-0000" {
			t.Errorf("%s: evicted victim row retained in bounded projection", stage)
		}
	}
}

func TestEvictedTaskOutcomeCorrectsCountAuthorityAllModes(t *testing.T) {
	for _, mode := range []string{"bound", "unbound", "transfer"} {
		t.Run(mode, func(t *testing.T) {
			h := newDAGOrderingHarness(t, mode)
			h.emit(t, activitySnapshotOrder[0], taskOrderingSnapshot(evictedOutcomeTasks()...))
			if got := h.summary().TaskDigest; got == nil || got.RunningCount != 1 || got.AgentRunningCount != 1 || got.TotalCount != maxActivityDigestEntries+1 || len(got.Tasks) != maxActivityDigestEntries {
				t.Fatalf("pre-correction authority: %+v", got)
			}
			h.emit(t, activitySnapshotOrder[1], dagOrderingSnapshot(evictedOutcomeRun()))
			if mode == "transfer" {
				h.bind()
			}
			assertEvictedOutcomeCorrected(t, h.summary().TaskDigest, mode)
		})
	}
}

// Correction precedence over revival for an evicted task: a stale equal-clock
// running revision must not resurrect the corrected count, the accepted
// outcome still rebinds the re-admitted row, and only a genuinely newer
// running revision revives the scalar.
func TestEvictedOutcomeCorrectionPrecedenceOverRevival(t *testing.T) {
	for _, mode := range []string{"bound", "unbound"} {
		t.Run(mode, func(t *testing.T) {
			h := newDAGOrderingHarness(t, mode)
			tasks := evictedOutcomeTasks()
			h.emit(t, activitySnapshotOrder[0], taskOrderingSnapshot(tasks...))
			h.emit(t, activitySnapshotOrder[1], dagOrderingSnapshot(evictedOutcomeRun()))
			assertEvictedOutcomeCorrected(t, h.summary().TaskDigest, mode+"/outcome")

			stale := append([]map[string]any{taskOrderingRow("task-0000", "running", dagCurrent)}, tasks[1:]...)
			h.emit(t, activitySnapshotOrder[0], taskOrderingSnapshot(stale...))
			digest := h.summary().TaskDigest
			if digest == nil || digest.RunningCount != 0 || digest.AgentRunningCount != 0 || digest.TotalCount != maxActivityDigestEntries+1 {
				t.Fatalf("%s/stale-revival: rejected stale revision resurrected counts: %+v", mode, digest)
			}

			h.emit(t, activitySnapshotOrder[1], dagOrderingSnapshot(evictedOutcomeRun()))
			digest = h.summary().TaskDigest
			if digest == nil {
				t.Fatalf("%s: missing digest after rebind", mode)
			}
			var victim *TaskDigestEntry
			for i := range digest.Tasks {
				if digest.Tasks[i].TaskID == "task-0000" {
					victim = &digest.Tasks[i]
				}
			}
			if victim == nil {
				t.Fatalf("%s: re-admitted victim absent from projection after rebind", mode)
			}
			if victim.Status != "completed" || victim.RawStatus != "running" {
				t.Errorf("%s: outcome did not correct the re-admitted row: %+v", mode, victim)
			}
			if digest.RunningCount != 0 || digest.AgentRunningCount != 0 {
				t.Errorf("%s/rebind: running scalars task=%d agent=%d, want 0", mode, digest.RunningCount, digest.AgentRunningCount)
			}

			revival := append([]map[string]any{taskOrderingRow("task-0000", "running", dagNewer)}, tasks[1:]...)
			h.emit(t, activitySnapshotOrder[0], taskOrderingSnapshot(revival...))
			digest = h.summary().TaskDigest
			if digest == nil || digest.RunningCount != 1 || digest.AgentRunningCount != 1 || digest.TotalCount != maxActivityDigestEntries+1 {
				t.Fatalf("%s/newer-revival: genuinely newer revision not accepted: %+v", mode, digest)
			}
		})
	}
}

// The overview subscription that feeds the sessions.activity digest must
// observe the corrected scalars, not only the aggregate pair.
func TestEvictedOutcomeCorrectsOverviewSubscription(t *testing.T) {
	h := newDAGOrderingHarness(t, "bound")
	h.m.mu.Lock()
	h.m.byRoute[h.s.routingID] = h.s
	h.m.mu.Unlock()
	updates := make(chan Summary, 8)
	_, unsubscribe := h.m.SubscribeActivity(true, nil, func(s Summary, _ bool) { updates <- s })
	defer unsubscribe()
	h.emit(t, activitySnapshotOrder[0], taskOrderingSnapshot(evictedOutcomeTasks()...))
	h.emit(t, activitySnapshotOrder[1], dagOrderingSnapshot(evictedOutcomeRun()))
	deadline := time.NewTimer(testTimeout)
	defer deadline.Stop()
	for {
		select {
		case summary := <-updates:
			if summary.TaskDigest != nil && summary.TaskDigest.TotalCount == maxActivityDigestEntries+1 && summary.TaskDigest.AgentRunningCount == 0 {
				assertEvictedOutcomeCorrected(t, summary.TaskDigest, "overview")
				return
			}
		case <-deadline.C:
			t.Fatal("no corrected overview publication")
		}
	}
}
