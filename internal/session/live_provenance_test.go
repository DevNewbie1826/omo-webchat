package session

import (
	"strings"
	"testing"
)

// Migrated from the removed sessions.activity per-task mapping. The shared
// digest builder still owns revision ordering and feeds retained chat activity.
func TestTaskStateOrderingRetainedDigestBuilder_whenStaleTaskFollowsCompletion(t *testing.T) {
	for _, derived := range []bool{false, true} {
		t.Run(map[bool]string{false: "raw", true: "derived"}[derived], func(t *testing.T) {
			// Given an oversized raw completion or a webchat-derived completion.
			h := newDAGOrderingHarness(t, "bound")
			status := "completed"
			if derived {
				status = "running"
			}
			row := taskOrderingRow("task-r", status, dagCurrent)
			row["padding"] = strings.Repeat("x", maxActivitySnapshotBytes)
			h.emit(t, activitySnapshotOrder[0], taskOrderingSnapshot(row))
			if derived {
				h.emit(t, activitySnapshotOrder[1], dagOrderingSnapshot(dagOrderingRun("r", "completed", dagNewer)))
			}
			// When an older running snapshot attempts to replace the accepted revision.
			h.emit(t, activitySnapshotOrder[0], taskOrderingSnapshot(taskOrderingRow("task-r", "running", dagOlder)))
			// Then retained provenance, source clock and oversized disclosure survive.
			summary := h.summary()
			if summary.TaskDigest == nil || len(summary.TaskDigest.Tasks) != 1 || !summary.TaskDigest.Truncated || !summary.TaskOversized {
				t.Fatalf("retained disclosure lost: %+v", summary)
			}
			got := summary.TaskDigest.Tasks[0]
			wantRaw := ""
			if derived {
				wantRaw = "running"
			}
			if got.Status != "completed" || got.UpdatedAt != dagCurrent || got.RawStatus != wantRaw {
				t.Fatalf("accepted task authority = %+v", got)
			}
			if lean := summary.LiveValues(); lean.Done != 1 || lean.Running.Agents != 0 || !lean.Truncated.Task {
				t.Fatalf("derived lean result = %+v", lean)
			}
		})
	}
}
