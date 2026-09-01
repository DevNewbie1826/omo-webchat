package chat

import (
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"
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
