package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/DevNewbie1826/omo-webchat/internal/cursorstore"
)

// The activity endpoint must always carry server-computed pre-truncation
// scalars: task running/total and DAG running counts are computed from the
// full store rows before any digest row cap or byte bound applies, so the
// counts stay exact while the returned row lists stay truncated.
func TestActivityEndpointExactCountsBeyondDigestCap(t *testing.T) {
	server, store, ws := newChatCreateTestServer(t)
	const durableID = "durable-counts"
	chat := cursorstore.Chat{
		ID: "chat-counts", WorkspaceID: ws.ID, CWD: ws.Path, DurableSessionID: durableID,
		SessionFile: filepath.Join(ws.Path, "session.jsonl"), Name: "Counts", NameSource: cursorstore.NameSourceUser,
	}
	if err := store.SaveChat(chat); err != nil {
		t.Fatal(err)
	}

	// 520 tasks: the 50 running ones carry the oldest revisions so every
	// newest-first retention window drops them from the row lists. Exact
	// counts must survive anyway: 50 running of 520 total.
	const totalTasks, runningTasks = 520, 50
	taskDir := filepath.Join(ws.Path, ".omo", "senpi-task", "tasks")
	if err := os.MkdirAll(taskDir, 0o700); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < totalTasks; i++ {
		status := "completed"
		created := fmt.Sprintf("2026-09-05T%02d:%02d:00Z", 12+i/60, i%60)
		if i < runningTasks {
			status = "running"
			created = fmt.Sprintf("2026-09-01T%02d:%02d:00Z", i/60, i%60)
		}
		record := fmt.Sprintf(`{"task_id":"st-counts-%03d","status":%q,"parent_session_id":%q,"created_at":%q,"updated_at":%q}`,
			i, status, durableID, created, created)
		if err := os.WriteFile(filepath.Join(taskDir, fmt.Sprintf("st-counts-%03d.json", i)), []byte(record), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	// Two active DAG runs: 2 running nodes + 1 running node = 3 running.
	runDir := filepath.Join(ws.Path, ".omo", "senpi-task", "dag", "runs")
	if err := os.MkdirAll(runDir, 0o700); err != nil {
		t.Fatal(err)
	}
	writeRun := func(runID string, states ...string) {
		t.Helper()
		nodes := ""
		for j, state := range states {
			if j > 0 {
				nodes += ","
			}
			nodes += fmt.Sprintf(`{"id":"node-%s-%d","state":%q,"attempt":1}`, runID, j, state)
		}
		run := fmt.Sprintf(`{"schemaVersion":1,"runId":%q,"runKey":%q,"name":"Run %s","parentSessionId":%q,"status":"running",`+
			`"createdAt":"2026-09-05T12:00:00Z","updatedAt":"2026-09-05T12:30:00Z",`+
			`"definition":{"nodes":[]},"nodes":[%s]}`, runID, runID, runID, durableID, nodes)
		if err := os.WriteFile(filepath.Join(runDir, runID+".json"), []byte(run), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	writeRun("run-alpha", "running", "running", "completed")
	writeRun("run-beta", "running", "pending")

	token, err := server.sessions.Create(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	response := authenticatedActivityRequest(t, server, token, ws.ID, chat.ID)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}

	var raw struct {
		TaskDigest *struct {
			RunningCount *int   `json:"running_count"`
			TotalCount   *int   `json:"total_count"`
			Truncated    bool   `json:"truncated"`
			Tasks        []any  `json:"tasks"`
			Raw          string `json:"-"`
		} `json:"task_digest"`
		DagDigest *struct {
			RunningCount *int  `json:"running_count"`
			Truncated    bool  `json:"truncated"`
			Runs         []any `json:"runs"`
		} `json:"dag_digest"`
		Task json.RawMessage `json:"task"`
		Dag  json.RawMessage `json:"dag"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &raw); err != nil {
		t.Fatal(err)
	}
	if raw.TaskDigest == nil {
		t.Fatalf("task digest absent: %s", response.Body.String())
	}
	if raw.TaskDigest.RunningCount == nil {
		t.Fatalf("task_digest.running_count absent from activity response: %s", response.Body.String())
	}
	if raw.TaskDigest.TotalCount == nil {
		t.Fatalf("task_digest.total_count absent from activity response: %s", response.Body.String())
	}
	if got := *raw.TaskDigest.RunningCount; got != runningTasks {
		t.Fatalf("task_digest.running_count = %d, want %d", got, runningTasks)
	}
	if got := *raw.TaskDigest.TotalCount; got != totalTasks {
		t.Fatalf("task_digest.total_count = %d, want %d (pre-truncation total)", got, totalTasks)
	}
	if !raw.TaskDigest.Truncated || len(raw.TaskDigest.Tasks) >= totalTasks {
		t.Fatalf("task digest rows must stay truncated: truncated=%v rows=%d", raw.TaskDigest.Truncated, len(raw.TaskDigest.Tasks))
	}
	if raw.DagDigest == nil {
		t.Fatalf("dag digest absent: %s", response.Body.String())
	}
	if raw.DagDigest.RunningCount == nil {
		t.Fatalf("dag_digest.running_count absent from activity response: %s", response.Body.String())
	}
	if got := *raw.DagDigest.RunningCount; got != 3 {
		t.Fatalf("dag_digest.running_count = %d, want 3 (2+1 running nodes summed over all runs)", got)
	}
	if !raw.DagDigest.Truncated || len(raw.DagDigest.Runs) != 2 {
		t.Fatalf("dag digest runs = %+v", raw.DagDigest)
	}

	// The truncated rich row lists must not carry the running rows that the
	// scalars still count exactly.
	var taskRows struct {
		Tasks []struct {
			TaskID string `json:"task_id"`
			Status string `json:"status"`
		} `json:"tasks"`
	}
	if err := json.Unmarshal(raw.Task, &taskRows); err != nil {
		t.Fatal(err)
	}
	if len(taskRows.Tasks) >= totalTasks {
		t.Fatalf("rich task rows must stay truncated: %d rows", len(taskRows.Tasks))
	}
	for _, row := range taskRows.Tasks {
		if row.Status == "running" {
			t.Fatalf("oldest running row %s leaked into truncated rich rows", row.TaskID)
		}
	}
}
