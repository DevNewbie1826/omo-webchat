package session

import (
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"
)

func TestDagDigestCompleteness(t *testing.T) {
	for _, mode := range []string{"bound", "unbound", "transfer"} {
		t.Run(mode, func(t *testing.T) {
			for _, test := range []struct {
				name     string
				status   string
				states   []string
				taskIDs  []any // nil omits the optional field; "" is a present, valid empty string.
				wantIDs  []string
				partial  bool
				terminal bool
			}{
				{name: "missing_ids", taskIDs: []any{nil, nil}, partial: true},
				{name: "empty_ids", taskIDs: []any{"", ""}, partial: true},
				{name: "mixed_missing_id", taskIDs: []any{nil, "task-b"}, wantIDs: []string{"task-b"}, partial: true},
				{name: "mixed_empty_id", taskIDs: []any{"task-a", ""}, wantIDs: []string{"task-a"}, partial: true},
				{name: "complete_ids", taskIDs: []any{"task-a", "task-b"}, wantIDs: []string{"task-a", "task-b"}},
				{name: "nonrunning_missing_ids", states: []string{"pending", "blocked", "scheduled", "completed", "failed", "cancelled", "skipped"}},
				{name: "nonrunning_empty_ids", states: []string{"pending", "blocked", "scheduled", "completed", "failed", "cancelled", "skipped"}, taskIDs: []any{"", "", "", "", "", "", ""}},
				{name: "completed_run_missing_ids", status: "completed", terminal: true},
				{name: "failed_run_missing_ids", status: "failed", terminal: true},
				{name: "cancelled_run_empty_ids", status: "cancelled", taskIDs: []any{"", ""}, terminal: true},
				{name: "canceled_run_empty_ids", status: "canceled", taskIDs: []any{"", ""}, terminal: true},
			} {
				t.Run(test.name, func(t *testing.T) {
					h := newDAGOrderingHarness(t, mode)
					status := test.status
					if status == "" {
						status = "running"
					}
					states := test.states
					if states == nil {
						states = []string{"running", "running"}
					}
					counts := map[string]int{"total": len(states), "pending": 0, "blocked": 0, "scheduled": 0, "running": 0, "completed": 0, "failed": 0, "cancelled": 0, "skipped": 0}
					nodes := make([]map[string]any, len(states))
					nodeIDs := make([]string, len(states))
					for i, state := range states {
						nodeIDs[i] = fmt.Sprintf("node-%d", i)
						nodes[i] = map[string]any{
							"id": nodeIDs[i], "label": nodeIDs[i], "state": state,
							"prompt": strings.Repeat("x", 40000), "depends_on": []string{},
						}
						if i < len(test.taskIDs) && test.taskIDs[i] != nil {
							nodes[i]["task_id"] = test.taskIDs[i]
						}
						counts[state]++
					}
					run := map[string]any{
						"run_id": "completeness-run", "run_key": "completeness-run", "name": "Completeness",
						"status": status, "updated_at": dagCurrent, "counts": counts, "nodes": nodes,
						"edges": []any{}, "waves": []any{map[string]any{"index": 0, "node_ids": nodeIDs}},
					}
					snapshot := dagOrderingSnapshot(run)
					snapshot["truncated_runs"] = false
					source, err := json.Marshal(snapshot)
					if err != nil {
						t.Fatal(err)
					}
					if len(source) <= maxActivitySnapshotBytes {
						t.Fatalf("source is not oversized: %d bytes", len(source))
					}

					// Exercise production dispatch/cache/summary, not a synthesized digest.
					h.emit(t, activitySnapshotOrder[1], snapshot)
					if mode == "transfer" {
						h.bind()
					}
					assertDigest := func(wantIDs []string, partial, terminal bool) {
						t.Helper()
						summary := h.summary()
						if !summary.DagOversized || len(summary.ActivityPair.Dag) != 0 {
							t.Fatalf("oversized source must use digest without replay: oversized=%v replayBytes=%d", summary.DagOversized, len(summary.ActivityPair.Dag))
						}
						if summary.DagDigest == nil {
							t.Fatal("valid oversized source did not produce a digest")
						}
						raw, err := json.Marshal(summary.DagDigest)
						if err != nil {
							t.Fatal(err)
						}
						t.Logf("source_bytes=%d digest=%s", len(source), raw)
						if len(raw) > maxActivitySnapshotBytes {
							t.Fatalf("digest exceeds byte cap: %d", len(raw))
						}
						var digest DagDigest
						if err := json.Unmarshal(raw, &digest); err != nil {
							t.Fatal(err)
						}
						if digest.Truncated != partial {
							t.Errorf("running identity completeness: truncated=%v, want %v; digest=%s", digest.Truncated, partial, raw)
						}
						if terminal {
							if len(digest.Runs) != 0 {
								t.Errorf("terminal run retained in active digest: %s", raw)
							}
							return
						}
						if len(digest.Runs) != 1 || digest.Runs[0].RunID != "completeness-run" || digest.Runs[0].Status != status {
							t.Fatalf("active run identity/status not retained: %s", raw)
						}
						if wantIDs == nil {
							wantIDs = []string{}
						}
						if !reflect.DeepEqual(digest.Runs[0].RunningTaskIDs, wantIDs) {
							t.Errorf("running_task_ids=%v, want %v", digest.Runs[0].RunningTaskIDs, wantIDs)
						}
					}
					assertDigest(test.wantIDs, test.partial, test.terminal)
					if test.partial {
						// A newer, fully identified source must recover exactness even while oversized.
						nodes[0]["task_id"], nodes[1]["task_id"] = "task-a", "task-b"
						run["updated_at"] = dagNewer
						source, err = json.Marshal(snapshot)
						if err != nil {
							t.Fatal(err)
						}
						h.emit(t, activitySnapshotOrder[1], snapshot)
						assertDigest([]string{"task-a", "task-b"}, false, false)
					}
				})
			}
		})
	}
}
