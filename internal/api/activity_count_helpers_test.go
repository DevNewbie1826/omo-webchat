package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"testing"

	"github.com/DevNewbie1826/omo-webchat/internal/auth"
)

// emitTruncatingActivity publishes one task snapshot with more tasks than the
// digest entry cap, where the 50 running rows are the oldest admitted rows, so
// every bounded retention window drops exactly the running rows from the
// projected lists. The scalars must still report 50 running of 600 total.
func (f *countsE2EFixture) emitTruncatingActivity() {
	f.t.Helper()
	const totalTasks, runningTasks = 600, 50
	tasks := make([]any, 0, totalTasks)
	for i := 0; i < totalTasks; i++ {
		status := "completed"
		if i < runningTasks {
			status = "running"
		}
		tasks = append(tasks, map[string]any{
			"task_id": fmt.Sprintf("st-counts-%03d", i), "status": status,
			"created_at": "2026-09-03T00:00:00Z", "updated_at": "2026-09-03T00:00:01Z",
		})
	}
	f.daemon.EmitSession(f.chat.SessionFile, map[string]any{
		"type": "extension_event", "name": "omo.task.updated",
		"data": map[string]any{"parent_session_id": f.chat.DurableSessionID, "truncated_tasks": false, "tasks": tasks},
	})

	// One active DAG run with 600 running nodes; the first 50 nodes carry no
	// task_id, so the task-ID projection can never represent them. The running
	// count is node-based and must stay exact: 600.
	const totalNodes = 600
	nodes := make([]any, 0, totalNodes)
	for i := 0; i < totalNodes; i++ {
		node := map[string]any{"id": fmt.Sprintf("node-%03d", i), "state": "running", "attempt": 1}
		if i >= 50 {
			node["task_id"] = fmt.Sprintf("st-dag-%03d", i)
		}
		nodes = append(nodes, node)
	}
	f.daemon.EmitSession(f.chat.SessionFile, map[string]any{
		"type": "extension_event", "name": "omo.dag.updated",
		"data": map[string]any{
			"parent_session_id": f.chat.DurableSessionID, "truncated_runs": false,
			"runs": []any{map[string]any{
				"run_id": "run-counts", "run_key": "run-counts", "name": "Counts", "status": "running",
				"created_at": "2026-09-03T00:00:00Z", "updated_at": "2026-09-03T00:00:02Z",
				"nodes": nodes,
			}},
		},
	})
}

func assertDigestScalar(t *testing.T, digest map[string]any, field string, want int) {
	t.Helper()
	if digest == nil {
		t.Fatalf("digest absent, want %s = %d", field, want)
	}
	got, present := digest[field]
	if !present {
		t.Fatalf("digest field %s absent (pre-truncation scalars must always be present): %v", field, digest)
	}
	if number, ok := got.(float64); !ok || int(number) != want {
		t.Fatalf("digest field %s = %v, want %d", field, got, want)
	}
}

// Retained digest guarantees stay pinned at the real manager cache boundary.
func assertRetainedCountDigests(t *testing.T, row map[string]any) {
	t.Helper()
	taskDigest, ok := row["task_digest"].(map[string]any)
	if !ok {
		t.Fatalf("live row task_digest = %v", row["task_digest"])
	}
	assertDigestScalar(t, taskDigest, "running_count", 50)
	assertDigestScalar(t, taskDigest, "total_count", 600)
	if taskDigest["truncated"] != true {
		t.Fatalf("task digest must stay truncated: %v", taskDigest)
	}
	rows, _ := taskDigest["tasks"].([]any)
	if len(rows) != 512 {
		t.Fatalf("task digest rows = %d, want the 512-entry cap", len(rows))
	}
	for _, entry := range rows {
		if entry.(map[string]any)["status"] == "running" {
			t.Fatalf("running row leaked into the truncated digest: %v", entry)
		}
	}
	dagDigest, ok := row["dag_digest"].(map[string]any)
	if !ok {
		t.Fatalf("live row dag_digest = %v", row["dag_digest"])
	}
	assertDigestScalar(t, dagDigest, "running_count", 600)
	if dagDigest["truncated"] != true {
		t.Fatalf("dag digest must stay truncated: %v", dagDigest)
	}
	runs, _ := dagDigest["runs"].([]any)
	if len(runs) != 1 {
		t.Fatalf("dag digest runs = %v", runs)
	}
	ids, _ := runs[0].(map[string]any)["running_task_ids"].([]any)
	if len(ids) != 512 {
		t.Fatalf("dag digest running_task_ids = %d, want the 512-entry cap", len(ids))
	}
}

func fetchLiveRows(t *testing.T, serverURL, token string) []map[string]any {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, serverURL+"/api/sessions/live", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: token})
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var body struct {
		Sessions []map[string]any `json:"sessions"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK || len(body.Sessions) != 1 {
		t.Fatalf("live REST response status=%d body=%v", resp.StatusCode, body.Sessions)
	}
	return body.Sessions
}
