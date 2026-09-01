package chat

import (
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"
)

func oversizedTaskPayload(t *testing.T, tasks []TaskDigestEntry) string {
	t.Helper()
	rawTasks, err := json.Marshal(tasks)
	if err != nil {
		t.Fatalf("marshal tasks: %v", err)
	}
	data := `{"tasks":` + string(rawTasks) + `,"pad":"` + strings.Repeat("a", maxActivitySnapshotBytes+1024) + `"}`
	if len(data) <= maxActivitySnapshotBytes {
		t.Fatalf("task payload len = %d, want > %d", len(data), maxActivitySnapshotBytes)
	}
	return data
}

func oversizedDagPayload(t *testing.T, runs any) string {
	t.Helper()
	rawRuns, err := json.Marshal(runs)
	if err != nil {
		t.Fatalf("marshal runs: %v", err)
	}
	data := `{"runs":` + string(rawRuns) + `,"pad":"` + strings.Repeat("a", maxActivitySnapshotBytes+1024) + `"}`
	if len(data) <= maxActivitySnapshotBytes {
		t.Fatalf("dag payload len = %d, want > %d", len(data), maxActivitySnapshotBytes)
	}
	return data
}

func TestActivityTaskDigestCarriesRowsWhenPayloadExceedsCacheCap(t *testing.T) {
	// Given: a live session with an in-cap snapshot already cached.
	const cached = `{"task":{"id":"st_cached"}}`
	s := newTestSession("chat-digest-oversize-task", nil)
	dispatchEvent(s, "extension_event", `{"type":"extension_event","name":"omo.task.updated","data":`+cached+`}`)
	manager := liveManagerWith(t, s)
	tasks := []TaskDigestEntry{
		{TaskID: "t-live-1", Status: "running", UpdatedAt: "2026-01-01T00:00:01Z"},
		{TaskID: "t-live-2", Status: "queued"},
	}

	// When: an over-cap omo.task.updated arrives with real task rows.
	dispatchEvent(s, "extension_event", `{"type":"extension_event","name":"omo.task.updated","data":`+oversizedTaskPayload(t, tasks)+`}`)

	// Then: the cache is unchanged, taskOversized latches, and the digest carries the rows.
	pair := s.ActivitySnapshot()
	if string(pair.Task) != cached {
		t.Fatalf("cached task = %s, want unchanged %s", pair.Task, cached)
	}
	summary := requireLiveSummary(t, manager)
	if !summary.TaskOversized {
		t.Fatal("TaskOversized = false, want true")
	}
	if summary.DagOversized {
		t.Fatal("DagOversized = true, want false")
	}
	if summary.TaskDigest == nil {
		t.Fatal("TaskDigest is nil, want rows from the over-cap payload")
	}
	if summary.TaskDigest.Truncated {
		t.Fatal("TaskDigest.Truncated = true, want false")
	}
	if !reflect.DeepEqual(summary.TaskDigest.Tasks, tasks) {
		t.Fatalf("TaskDigest.Tasks = %#v, want %#v", summary.TaskDigest.Tasks, tasks)
	}
}

func TestActivityTaskDigestCachesAndDigestsUnderCapPayload(t *testing.T) {
	// Given: a live session with no cached activity.
	s := newTestSession("chat-digest-undercap-task", nil)
	manager := liveManagerWith(t, s)
	const data = `{"tasks":[{"task_id":"t-small","status":"running","updated_at":"2026-01-02T00:00:00Z"}]}`

	// When: an under-cap omo.task.updated arrives.
	dispatchEvent(s, "extension_event", `{"type":"extension_event","name":"omo.task.updated","data":`+data+`}`)

	// Then: both the replay cache and the digest hold the payload.
	pair := s.ActivitySnapshot()
	if string(pair.Task) != data {
		t.Fatalf("cached task = %s, want %s", pair.Task, data)
	}
	summary := requireLiveSummary(t, manager)
	if summary.TaskOversized {
		t.Fatal("TaskOversized = true, want false")
	}
	if summary.TaskDigest == nil {
		t.Fatal("TaskDigest is nil, want under-cap rows")
	}
	want := []TaskDigestEntry{{TaskID: "t-small", Status: "running", UpdatedAt: "2026-01-02T00:00:00Z"}}
	if summary.TaskDigest.Truncated {
		t.Fatal("TaskDigest.Truncated = true, want false")
	}
	if !reflect.DeepEqual(summary.TaskDigest.Tasks, want) {
		t.Fatalf("TaskDigest.Tasks = %#v, want %#v", summary.TaskDigest.Tasks, want)
	}
}

func TestActivityTaskDigestTruncatesPast512Entries(t *testing.T) {
	// Given: a live session with no cached activity.
	s := newTestSession("chat-digest-cap-task", nil)
	manager := liveManagerWith(t, s)
	tasks := make([]TaskDigestEntry, maxActivityDigestEntries+1)
	for i := range tasks {
		tasks[i] = TaskDigestEntry{TaskID: fmt.Sprintf("t-%03d", i), Status: "running"}
	}
	rawTasks, err := json.Marshal(tasks)
	if err != nil {
		t.Fatalf("marshal tasks: %v", err)
	}

	// When: omo.task.updated arrives with more than 512 task rows.
	dispatchEvent(s, "extension_event", `{"type":"extension_event","name":"omo.task.updated","data":{"tasks":`+string(rawTasks)+`}}`)

	// Then: the digest keeps the first 512 rows and reports truncated.
	summary := requireLiveSummary(t, manager)
	if summary.TaskDigest == nil {
		t.Fatal("TaskDigest is nil, want capped rows")
	}
	if !summary.TaskDigest.Truncated {
		t.Fatal("TaskDigest.Truncated = false, want true")
	}
	if got := len(summary.TaskDigest.Tasks); got != maxActivityDigestEntries {
		t.Fatalf("TaskDigest.Tasks len = %d, want %d", got, maxActivityDigestEntries)
	}
	if summary.TaskDigest.Tasks[0].TaskID != "t-000" {
		t.Fatalf("first kept task_id = %q, want t-000", summary.TaskDigest.Tasks[0].TaskID)
	}
	wantLast := fmt.Sprintf("t-%03d", maxActivityDigestEntries-1)
	if got := summary.TaskDigest.Tasks[maxActivityDigestEntries-1].TaskID; got != wantLast {
		t.Fatalf("last kept task_id = %q, want %s", got, wantLast)
	}
	for _, entry := range summary.TaskDigest.Tasks {
		if entry.TaskID == fmt.Sprintf("t-%03d", maxActivityDigestEntries) {
			t.Fatalf("digest kept over-cap task_id %q", entry.TaskID)
		}
	}
}

func TestActivityDagDigestKeepsRunningNodesFromOverCapPayload(t *testing.T) {
	// Given: a live session with an in-cap dag snapshot already cached.
	const cached = `{"dag":{"nodes":[{"id":"st_cached"}]}}`
	s := newTestSession("chat-digest-oversize-dag", nil)
	dispatchEvent(s, "extension_event", `{"type":"extension_event","name":"omo.dag.updated","data":`+cached+`}`)
	manager := liveManagerWith(t, s)
	type node struct {
		TaskID string `json:"task_id"`
		State  string `json:"state"`
	}
	type run struct {
		RunID  string `json:"run_id"`
		Status string `json:"status"`
		Nodes  []node `json:"nodes"`
	}
	runs := []run{
		{RunID: "r-done", Status: "completed", Nodes: []node{{TaskID: "t-done", State: "completed"}}},
		{RunID: "r-fail", Status: "failed", Nodes: []node{{TaskID: "t-fail", State: "failed"}}},
		{RunID: "r-cancel", Status: "cancelled", Nodes: []node{{TaskID: "t-cancel", State: "cancelled"}}},
		{RunID: "r-live", Status: "running", Nodes: []node{
			{TaskID: "t-run", State: "running"},
			{TaskID: "t-wait", State: "pending"},
			{TaskID: "t-done-node", State: "completed"},
		}},
	}

	// When: an over-cap omo.dag.updated arrives with mixed terminal and live runs.
	dispatchEvent(s, "extension_event", `{"type":"extension_event","name":"omo.dag.updated","data":`+oversizedDagPayload(t, runs)+`}`)

	// Then: the cache is unchanged, dagOversized latches, terminal runs are dropped,
	// and running_task_ids keep only running nodes of live runs.
	pair := s.ActivitySnapshot()
	if string(pair.Dag) != cached {
		t.Fatalf("cached dag = %s, want unchanged %s", pair.Dag, cached)
	}
	summary := requireLiveSummary(t, manager)
	if !summary.DagOversized {
		t.Fatal("DagOversized = false, want true")
	}
	if summary.TaskOversized {
		t.Fatal("TaskOversized = true, want false")
	}
	if summary.DagDigest == nil {
		t.Fatal("DagDigest is nil, want runs from the over-cap payload")
	}
	if summary.DagDigest.Truncated {
		t.Fatal("DagDigest.Truncated = true, want false")
	}
	want := []RunDigestEntry{{
		RunID:          "r-live",
		Status:         "running",
		RunningTaskIDs: []string{"t-run"},
	}}
	if !reflect.DeepEqual(summary.DagDigest.Runs, want) {
		t.Fatalf("DagDigest.Runs = %#v, want %#v", summary.DagDigest.Runs, want)
	}
}

func TestTerminalDagArrivalDemotesTaskDigestIncludingOverCapPayload(t *testing.T) {
	for _, oversized := range []bool{false, true} {
		t.Run(fmt.Sprintf("oversized=%v", oversized), func(t *testing.T) {
			s := newTestSession("chat-digest-demote", nil)
			manager := liveManagerWith(t, s)
			dispatchEvent(s, "extension_event", `{"type":"extension_event","name":"omo.task.updated","data":{"tasks":[{"task_id":"t-terminal","status":"running"},{"task_id":"t-live","status":"running"}]}}`)
			runs := []map[string]any{{
				"run_id": "r-terminal",
				"status": "completed",
				"nodes":  []map[string]string{{"task_id": "t-terminal", "state": "failed"}},
			}}
			var dag string
			if oversized {
				dag = oversizedDagPayload(t, runs)
			} else {
				raw, err := json.Marshal(map[string]any{"runs": runs})
				if err != nil {
					t.Fatalf("marshal dag: %v", err)
				}
				dag = string(raw)
			}

			dispatchEvent(s, "extension_event", `{"type":"extension_event","name":"omo.dag.updated","data":`+dag+`}`)

			summary := requireLiveSummary(t, manager)
			if summary.TaskDigest == nil || len(summary.TaskDigest.Tasks) != 2 {
				t.Fatalf("TaskDigest = %#v, want two rows", summary.TaskDigest)
			}
			if got := summary.TaskDigest.Tasks[0].Status; got != "failed" {
				t.Fatalf("terminal task digest status = %q, want failed", got)
			}
			if got := summary.TaskDigest.Tasks[1].Status; got != "running" {
				t.Fatalf("unrelated task digest status = %q, want running", got)
			}
			if summary.DagDigest == nil || len(summary.DagDigest.Runs) != 0 {
				t.Fatalf("DagDigest = %#v, want terminal run excluded", summary.DagDigest)
			}
		})
	}
}

func TestActivityDagDigestPropagatesTruncatedRuns(t *testing.T) {
	digest, ok := parseActivityDagDigest(json.RawMessage(`{"truncated_runs":true,"runs":[{"run_id":"r1","status":"running","nodes":[]}]}`))
	if !ok {
		t.Fatal("parseActivityDagDigest rejected valid payload")
	}
	if !digest.Truncated {
		t.Fatal("ActivityDagDigest.Truncated = false, want truncated_runs propagated")
	}
}

func TestActivityDagDigestCapsTotalRunningTaskIDs(t *testing.T) {
	nodes := make([]map[string]string, maxActivityDigestEntries+1)
	for i := range nodes {
		nodes[i] = map[string]string{"task_id": fmt.Sprintf("t-%03d", i), "state": "running"}
	}
	raw, err := json.Marshal(map[string]any{
		"runs": []map[string]any{{"run_id": "r1", "status": "running", "nodes": nodes}},
	})
	if err != nil {
		t.Fatalf("marshal dag: %v", err)
	}

	digest, ok := parseActivityDagDigest(raw)
	if !ok {
		t.Fatal("parseActivityDagDigest rejected valid payload")
	}
	if !digest.Truncated {
		t.Fatal("ActivityDagDigest.Truncated = false, want total id budget truncation")
	}
	if got := len(digest.Runs[0].RunningTaskIDs); got != maxActivityDigestEntries {
		t.Fatalf("running_task_ids len = %d, want %d", got, maxActivityDigestEntries)
	}
}

func TestActivityDigestMalformedShapesKeepPreviousDigest(t *testing.T) {
	tests := []struct {
		name      string
		eventName string
		previous  string
		malformed string
	}{
		{name: "task null", eventName: "omo.task.updated", previous: `{"tasks":[{"task_id":"t-keep","status":"running"}]}`, malformed: `null`},
		{name: "task empty object", eventName: "omo.task.updated", previous: `{"tasks":[{"task_id":"t-keep","status":"running"}]}`, malformed: `{}`},
		{name: "task null array", eventName: "omo.task.updated", previous: `{"tasks":[{"task_id":"t-keep","status":"running"}]}`, malformed: `{"tasks":null}`},
		{name: "task malformed entry", eventName: "omo.task.updated", previous: `{"tasks":[{"task_id":"t-keep","status":"running"}]}`, malformed: `{"tasks":[{"task_id":"t-bad"}]}`},
		{name: "dag null", eventName: "omo.dag.updated", previous: `{"runs":[{"run_id":"r-keep","status":"running","nodes":[]}]}`, malformed: `null`},
		{name: "dag empty object", eventName: "omo.dag.updated", previous: `{"runs":[{"run_id":"r-keep","status":"running","nodes":[]}]}`, malformed: `{}`},
		{name: "dag null array", eventName: "omo.dag.updated", previous: `{"runs":[{"run_id":"r-keep","status":"running","nodes":[]}]}`, malformed: `{"runs":null}`},
		{name: "dag malformed entry", eventName: "omo.dag.updated", previous: `{"runs":[{"run_id":"r-keep","status":"running","nodes":[]}]}`, malformed: `{"runs":[{"run_id":"r-bad","nodes":[]}]}`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s := newTestSession("chat-digest-shape", nil)
			s.rememberActivitySnapshot(tt.eventName, json.RawMessage(tt.previous))
			before := s.activitySnapshotState()

			s.rememberActivitySnapshot(tt.eventName, json.RawMessage(tt.malformed))

			after := s.activitySnapshotState()
			if tt.eventName == "omo.task.updated" {
				if !reflect.DeepEqual(after.taskDigest, before.taskDigest) {
					t.Fatalf("task digest changed: got %#v, want %#v", after.taskDigest, before.taskDigest)
				}
			} else if !reflect.DeepEqual(after.dagDigest, before.dagDigest) {
				t.Fatalf("dag digest changed: got %#v, want %#v", after.dagDigest, before.dagDigest)
			}
		})
	}
}

func TestActivityDigestMalformedJSONKeepsPreviousDigest(t *testing.T) {
	// Given: a live session whose task digest already carries rows.
	s := newTestSession("chat-digest-malformed", nil)
	manager := liveManagerWith(t, s)
	const previous = `{"tasks":[{"task_id":"t-keep","status":"running","updated_at":"2026-01-03T00:00:00Z"}]}`
	dispatchEvent(s, "extension_event", `{"type":"extension_event","name":"omo.task.updated","data":`+previous+`}`)
	before := requireLiveSummary(t, manager)
	if before.TaskDigest == nil {
		t.Fatal("setup: TaskDigest is nil")
	}

	// When: a later omo.task.updated arrives with well-framed but malformed task JSON.
	dispatchEvent(s, "extension_event", `{"type":"extension_event","name":"omo.task.updated","data":{"tasks":"nope"}}`)

	// Then: the previous digest is left in place.
	summary := requireLiveSummary(t, manager)
	if summary.TaskDigest == nil {
		t.Fatal("TaskDigest is nil after malformed payload, want previous rows")
	}
	want := []TaskDigestEntry{{TaskID: "t-keep", Status: "running", UpdatedAt: "2026-01-03T00:00:00Z"}}
	if summary.TaskDigest.Truncated {
		t.Fatal("TaskDigest.Truncated = true, want previous false")
	}
	if !reflect.DeepEqual(summary.TaskDigest.Tasks, want) {
		t.Fatalf("TaskDigest.Tasks = %#v, want previous %#v", summary.TaskDigest.Tasks, want)
	}
}

func requireRecentRFC3339UTC(t *testing.T, got string) {
	t.Helper()
	if got == "" {
		t.Fatal("ReceivedAt is empty, want RFC3339 UTC stamp")
	}
	parsed, err := time.Parse(time.RFC3339, got)
	if err != nil {
		t.Fatalf("ReceivedAt = %q, want RFC3339: %v", got, err)
	}
	if parsed.Location() != time.UTC {
		t.Fatalf("ReceivedAt location = %s, want UTC", parsed.Location())
	}
	now := time.Now().UTC()
	delta := now.Sub(parsed)
	if delta < 0 {
		delta = -delta
	}
	if delta > 5*time.Second {
		t.Fatalf("ReceivedAt = %s, now = %s, delta = %s, want within 5s", got, now.Format(time.RFC3339), delta)
	}
}

func TestActivityTaskDigestStampsReceivedAtWhenUnderCap(t *testing.T) {
	// Given: a live session with no cached activity.
	s := newTestSession("chat-digest-received-at-undercap", nil)
	manager := liveManagerWith(t, s)
	const data = `{"tasks":[{"task_id":"t-small","status":"running","updated_at":"2026-01-02T00:00:00Z"}]}`

	// When: an under-cap omo.task.updated arrives.
	dispatchEvent(s, "extension_event", `{"type":"extension_event","name":"omo.task.updated","data":`+data+`}`)

	// Then: the digest is stamped with a recent RFC3339 UTC arrival time.
	summary := requireLiveSummary(t, manager)
	if summary.TaskDigest == nil {
		t.Fatal("TaskDigest is nil, want under-cap rows")
	}
	requireRecentRFC3339UTC(t, summary.TaskDigest.ReceivedAt)
}

func TestActivityTaskDigestStampsReceivedAtWhenOverCap(t *testing.T) {
	// Given: a live session and a task payload larger than the 64KB cache cap.
	s := newTestSession("chat-digest-received-at-overcap", nil)
	manager := liveManagerWith(t, s)
	tasks := []TaskDigestEntry{
		{TaskID: "t-live-1", Status: "running", UpdatedAt: "2026-01-01T00:00:01Z"},
	}

	// When: an over-cap omo.task.updated arrives.
	dispatchEvent(s, "extension_event", `{"type":"extension_event","name":"omo.task.updated","data":`+oversizedTaskPayload(t, tasks)+`}`)

	// Then: extraction still stamps ReceivedAt even though the cache is skipped.
	summary := requireLiveSummary(t, manager)
	if summary.TaskDigest == nil {
		t.Fatal("TaskDigest is nil, want over-cap rows")
	}
	requireRecentRFC3339UTC(t, summary.TaskDigest.ReceivedAt)
}

func TestActivityDigestMarshalJSONRoundTripsReceivedAt(t *testing.T) {
	const stamp = "2026-04-01T12:00:00Z"
	t.Run("task", func(t *testing.T) {
		// Given: a task digest already stamped at the boundary.
		digest := ActivityTaskDigest{
			Tasks:      []TaskDigestEntry{{TaskID: "t1", Status: "running"}},
			Truncated:  true,
			ReceivedAt: stamp,
		}

		// When: the digest is marshaled, unmarshaled, and marshaled again.
		raw, err := json.Marshal(digest)
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}

		// Then: JSON carries received_at and the stamp survives a round-trip.
		var parsed map[string]any
		if err := json.Unmarshal(raw, &parsed); err != nil {
			t.Fatalf("decode: %v (%s)", err, raw)
		}
		if parsed["received_at"] != stamp {
			t.Fatalf("received_at = %#v, want %q (%s)", parsed["received_at"], stamp, raw)
		}
		var round ActivityTaskDigest
		if err := json.Unmarshal(raw, &round); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		if round.ReceivedAt != stamp {
			t.Fatalf("round-trip ReceivedAt = %q, want %q", round.ReceivedAt, stamp)
		}
		rewritten, err := json.Marshal(round)
		if err != nil {
			t.Fatalf("remarshal: %v", err)
		}
		var parsedAgain map[string]any
		if err := json.Unmarshal(rewritten, &parsedAgain); err != nil {
			t.Fatalf("decode remarshal: %v (%s)", err, rewritten)
		}
		if parsedAgain["received_at"] != stamp {
			t.Fatalf("remarshaled received_at = %#v, want %q", parsedAgain["received_at"], stamp)
		}
	})
	t.Run("dag", func(t *testing.T) {
		// Given: a dag digest already stamped at the boundary.
		digest := ActivityDagDigest{
			Runs:       []RunDigestEntry{{RunID: "r1", Status: "running", RunningTaskIDs: []string{"t1"}}},
			Truncated:  true,
			ReceivedAt: stamp,
		}

		// When: the digest is marshaled, unmarshaled, and marshaled again.
		raw, err := json.Marshal(digest)
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}

		// Then: JSON carries received_at and the stamp survives a round-trip.
		var parsed map[string]any
		if err := json.Unmarshal(raw, &parsed); err != nil {
			t.Fatalf("decode: %v (%s)", err, raw)
		}
		if parsed["received_at"] != stamp {
			t.Fatalf("received_at = %#v, want %q (%s)", parsed["received_at"], stamp, raw)
		}
		var round ActivityDagDigest
		if err := json.Unmarshal(raw, &round); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		if round.ReceivedAt != stamp {
			t.Fatalf("round-trip ReceivedAt = %q, want %q", round.ReceivedAt, stamp)
		}
		rewritten, err := json.Marshal(round)
		if err != nil {
			t.Fatalf("remarshal: %v", err)
		}
		var parsedAgain map[string]any
		if err := json.Unmarshal(rewritten, &parsedAgain); err != nil {
			t.Fatalf("decode remarshal: %v (%s)", err, rewritten)
		}
		if parsedAgain["received_at"] != stamp {
			t.Fatalf("remarshaled received_at = %#v, want %q", parsedAgain["received_at"], stamp)
		}
	})
}

func TestCloneActivityDigestCarriesReceivedAt(t *testing.T) {
	const stamp = "2026-04-01T12:00:00Z"
	t.Run("task", func(t *testing.T) {
		// Given: a stamped task digest.
		src := &ActivityTaskDigest{
			Tasks:      []TaskDigestEntry{{TaskID: "t1", Status: "running"}},
			Truncated:  true,
			ReceivedAt: stamp,
		}

		// When: the digest is cloned.
		got := cloneActivityTaskDigest(src)

		// Then: ReceivedAt is copied onto a distinct value.
		if got == nil {
			t.Fatal("clone is nil")
		}
		if got.ReceivedAt != stamp {
			t.Fatalf("clone ReceivedAt = %q, want %q", got.ReceivedAt, stamp)
		}
		if got == src {
			t.Fatal("clone returned the source pointer")
		}
		got.ReceivedAt = "mutated"
		if src.ReceivedAt != stamp {
			t.Fatalf("source ReceivedAt mutated to %q", src.ReceivedAt)
		}
	})
	t.Run("dag", func(t *testing.T) {
		// Given: a stamped dag digest.
		src := &ActivityDagDigest{
			Runs:       []RunDigestEntry{{RunID: "r1", Status: "running", RunningTaskIDs: []string{"t1"}}},
			Truncated:  true,
			ReceivedAt: stamp,
		}

		// When: the digest is cloned.
		got := cloneActivityDagDigest(src)

		// Then: ReceivedAt is copied onto a distinct value.
		if got == nil {
			t.Fatal("clone is nil")
		}
		if got.ReceivedAt != stamp {
			t.Fatalf("clone ReceivedAt = %q, want %q", got.ReceivedAt, stamp)
		}
		if got == src {
			t.Fatal("clone returned the source pointer")
		}
		got.ReceivedAt = "mutated"
		if src.ReceivedAt != stamp {
			t.Fatalf("source ReceivedAt mutated to %q", src.ReceivedAt)
		}
	})
}

func TestActivityDigestMalformedPayloadKeepsOriginalReceivedAt(t *testing.T) {
	t.Run("task", func(t *testing.T) {
		// Given: a live session whose task digest already carries a stamp.
		s := newTestSession("chat-digest-keep-task-received-at", nil)
		manager := liveManagerWith(t, s)
		dispatchEvent(s, "extension_event", `{"type":"extension_event","name":"omo.task.updated","data":{"tasks":[{"task_id":"t-keep","status":"running"}]}}`)
		before := requireLiveSummary(t, manager)
		if before.TaskDigest == nil {
			t.Fatal("setup: TaskDigest is nil")
		}
		original := before.TaskDigest.ReceivedAt
		requireRecentRFC3339UTC(t, original)

		// When: a later omo.task.updated arrives with malformed task JSON.
		dispatchEvent(s, "extension_event", `{"type":"extension_event","name":"omo.task.updated","data":{"tasks":"nope"}}`)

		// Then: the previous digest keeps its original ReceivedAt.
		summary := requireLiveSummary(t, manager)
		if summary.TaskDigest == nil {
			t.Fatal("TaskDigest is nil after malformed payload, want previous digest")
		}
		if summary.TaskDigest.ReceivedAt != original {
			t.Fatalf("ReceivedAt = %q, want original %q", summary.TaskDigest.ReceivedAt, original)
		}
	})
	t.Run("dag", func(t *testing.T) {
		// Given: a live session whose dag digest already carries a stamp.
		s := newTestSession("chat-digest-keep-dag-received-at", nil)
		manager := liveManagerWith(t, s)
		dispatchEvent(s, "extension_event", `{"type":"extension_event","name":"omo.dag.updated","data":{"runs":[{"run_id":"r-keep","status":"running","nodes":[]}]}}`)
		before := requireLiveSummary(t, manager)
		if before.DagDigest == nil {
			t.Fatal("setup: DagDigest is nil")
		}
		original := before.DagDigest.ReceivedAt
		requireRecentRFC3339UTC(t, original)

		// When: a later omo.dag.updated arrives with malformed run JSON.
		dispatchEvent(s, "extension_event", `{"type":"extension_event","name":"omo.dag.updated","data":{"runs":"nope"}}`)

		// Then: the previous digest keeps its original ReceivedAt.
		summary := requireLiveSummary(t, manager)
		if summary.DagDigest == nil {
			t.Fatal("DagDigest is nil after malformed payload, want previous digest")
		}
		if summary.DagDigest.ReceivedAt != original {
			t.Fatalf("ReceivedAt = %q, want original %q", summary.DagDigest.ReceivedAt, original)
		}
	})
}
