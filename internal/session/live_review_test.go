package session

import (
	"encoding/json"
	"testing"
)

func TestLiveRevision_whenRenderedValuesChangeWithinReceiptMillisecond(t *testing.T) {
	for _, change := range []string{"start", "completion", "count", "title"} {
		t.Run(change, func(t *testing.T) {
			// Given a fixed receipt ahead of wall time, forcing same-millisecond ordering.
			s := newActivityTestSession(t)
			s.taskDigest = &TaskDigest{ReceivedAt: "2099-01-01T00:00:00Z", RunningCount: 1}
			s.providerRunActive = change == "completion"
			before := s.summaryLocked().LiveValues()
			// When a rendered value changes without a new digest receipt.
			switch change {
			case "start":
				s.providerRunActive = true
			case "completion":
				s.providerRunActive = false
			case "count":
				s.taskDigest.RunningCount = 2
			case "title":
				s.title = "new title"
			}
			after := s.summaryLocked().LiveValues()
			// Then the revision distinguishes this mutation, but an unchanged resend is identical.
			if before.LastActivityMS == nil || after.LastActivityMS == nil || *after.LastActivityMS <= *before.LastActivityMS {
				t.Fatalf("revision did not advance: before=%v after=%v", before.LastActivityMS, after.LastActivityMS)
			}
			first, err := json.Marshal(after)
			if err != nil {
				t.Fatal(err)
			}
			second, err := json.Marshal(s.summaryLocked().LiveValues())
			if err != nil {
				t.Fatal(err)
			}
			if string(first) != string(second) {
				t.Fatalf("unchanged resend differs: %s != %s", first, second)
			}
		})
	}
}

func TestLiveRevision_whenTwoMutationsShareOneMillisecond(t *testing.T) {
	// Given a completed summary and a fixed receipt clock.
	var revision liveRevision
	summary := Summary{TaskDigest: &TaskDigest{}}
	revision.project(summary, 1000)
	// When start and completion occur within the same clock millisecond.
	summary.Active = true
	summary.TaskDigest.RunningCount = 1
	started := revision.project(summary, 1000).LiveValues()
	summary.Active = false
	summary.TaskDigest.RunningCount = 0
	completed := revision.project(summary, 1000).LiveValues()
	// Then both mutations are distinguishable even though the receipt clock did not move.
	if started.LastActivityMS == nil || completed.LastActivityMS == nil || *started.LastActivityMS != 1000 || *completed.LastActivityMS != 1001 {
		t.Fatalf("same-millisecond mutations collided: start=%+v complete=%+v", started, completed)
	}
}

func TestLiveRevisionIdentity_whenOnlyReceiptChanges(t *testing.T) {
	// Given an accepted rendered summary.
	var revision liveRevision
	summary := Summary{TaskDigest: &TaskDigest{ReceivedAt: "2026-09-13T12:00:00Z"}}
	before, err := json.Marshal(revision.project(summary, 1000).LiveValues())
	if err != nil {
		t.Fatal(err)
	}
	// When an unchanged summary is resent with a newer receipt.
	summary.TaskDigest.ReceivedAt = "2026-09-13T12:00:01Z"
	after, err := json.Marshal(revision.project(summary, 2000).LiveValues())
	if err != nil {
		t.Fatal(err)
	}
	// Then its bytes, including freshness, stay identical.
	if string(before) != string(after) {
		t.Fatalf("unchanged resend differs: %s != %s", before, after)
	}
}

func TestLiveProgressClear_whenNewRevisionHasNoProgress(t *testing.T) {
	for _, mode := range []string{"bound", "unbound"} {
		t.Run(mode, func(t *testing.T) {
			// Given previously accepted progress.
			h := newDAGOrderingHarness(t, mode)
			row := taskOrderingRow("t", "running", dagCurrent)
			row["live_progress"] = map[string]any{"last_assistant_line": "working"}
			h.emit(t, activitySnapshotOrder[0], taskOrderingSnapshot(row))
			if line := h.summary().LiveValues().LastLine; line == nil || *line != "working" {
				t.Fatal("missing initial progress")
			}
			// When newer task activity no longer carries progress.
			h.emit(t, activitySnapshotOrder[0], taskOrderingSnapshot(taskOrderingRow("t", "completed", dagNewer)))
			got := h.summary().LiveValues()
			// Then it explicitly clears the previously accepted line.
			if got.LastLine == nil || *got.LastLine != "" {
				t.Fatalf("missing explicit clear: %+v", got)
			}
		})
	}
}

func TestLiveProgressOmitted_whenFirstRosterHasNoProgress(t *testing.T) {
	// Given a session with no accepted progress.
	h := newDAGOrderingHarness(t, "bound")
	// When its first roster has no progress.
	h.emit(t, activitySnapshotOrder[0], taskOrderingSnapshot(taskOrderingRow("t", "running", dagCurrent)))
	// Then absence stays distinct from an explicit clear.
	if h.summary().LiveValues().LastLine != nil {
		t.Fatal("invented progress")
	}
}

func TestReviewLeanNestedMalformedCounts(t *testing.T) {
	for _, counts := range []string{
		`{"completed":null,"total":2}`, `{"completed":1,"total":null}`,
		`{"completed":-1,"total":2}`, `{"completed":1.5,"total":2}`,
		`{"completed":5,"total":2}`, `{"completed":1,"total":9007199254740992}`,
	} {
		t.Run(counts, func(t *testing.T) {
			// Given malformed counts beside valid work.
			h := newDAGOrderingHarness(t, "bound")
			run := dagOrderingRun("r", "running", dagCurrent)
			run["counts"] = json.RawMessage(counts)
			// When admitted at the real snapshot boundary.
			h.emit(t, activitySnapshotOrder[1], dagOrderingSnapshot(run))
			got := h.summary().LiveValues()
			// Then uncertainty is explicit and all displayed counts are browser-safe.
			if !got.Truncated.Dag || got.DagDone < 0 || got.DagTotal < got.DagDone || got.DagTotal > 9007199254740991 || got.Running.Agents != 1 || got.Running.Dag != 1 {
				t.Fatalf("malformed counts escaped qualification: %+v", got)
			}
		})
	}
}

func TestLiveCountsQualified_whenAggregateExceedsSafeInteger(t *testing.T) {
	// Given individually safe counts whose sum exceeds the browser integer limit.
	h := newDAGOrderingHarness(t, "bound")
	a, b := dagOrderingRun("a", "running", dagCurrent), dagOrderingRun("b", "running", dagCurrent)
	for _, run := range []map[string]any{a, b} {
		run["counts"] = map[string]any{"completed": 9007199254740991, "total": 9007199254740991}
	}
	// When the complete roster is summed.
	h.emit(t, activitySnapshotOrder[1], dagOrderingSnapshot(a, b))
	got := h.summary().LiveValues()
	// Then overflow is clamped and qualified without losing node activity.
	if !got.Truncated.Dag || got.DagDone != 9007199254740991 || got.DagTotal != 9007199254740991 || got.Running.Agents != 2 {
		t.Fatalf("unsafe aggregate: %+v", got)
	}
}
