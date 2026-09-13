package api

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/DevNewbie1826/omo-webchat/internal/auth"
)

// The lean live feed must stay small no matter how large the raw activity
// snapshots grow: a DAG composition carrying >= 40KB of raw node content must
// still produce a full GET /api/sessions/live body under 2048 bytes, and the
// sessions.activity frame for the same composition must stay lean as well.
func TestLiveLeanPayload_staysUnderByteBudgetWithLargeRawDAG(t *testing.T) {
	// Given a real server with an attached chat and an established subscription.
	fixture := newCountsE2EFixture(t)
	fixture.attachChat()
	_, frames := fixture.connectSubscribe()
	fixture.daemon.EmitSession(fixture.chat.SessionFile, map[string]any{
		"type": "extension_event", "name": "omo.task.updated",
		"data": map[string]any{"tasks": []any{
			map[string]any{"task_id": "shared", "status": "running", "updated_at": "2026-09-13T12:00:01Z", "live_progress": map[string]any{"last_assistant_line": "progress"}},
			map[string]any{"task_id": "done", "status": "completed", "updated_at": "2026-09-13T12:00:00Z", "live_progress": map[string]any{"last_assistant_line": "older"}},
		}},
	})
	frames.next(t, "sessions.activity")

	// When a DAG snapshot carries >= 40KB of raw node content (bulk output the
	// digest must drop) over the same roster shape as the lean e2e test.
	bulk := strings.Repeat("raw-node-output-", 1400) // ~22.4KB per node
	dagData := map[string]any{"runs": []any{
		map[string]any{"run_id": "r1", "status": "running", "updated_at": "2026-09-13T12:00:02Z", "counts": map[string]any{"completed": 2, "total": 5}, "nodes": []any{
			map[string]any{"id": "n1", "task_id": "shared", "state": "running", "output": bulk},
			map[string]any{"id": "n2", "task_id": "independent", "state": "running", "output": bulk},
		}},
		map[string]any{"run_id": "r2", "status": "completed", "updated_at": "2026-09-13T12:00:02Z", "counts": map[string]any{"completed": 3, "total": 3}, "nodes": []any{}},
	}}
	rawDAG, err := json.Marshal(dagData)
	if err != nil {
		t.Fatal(err)
	}
	if len(rawDAG) < 40*1024 {
		t.Fatalf("injected raw DAG payload = %d bytes, want >= %d", len(rawDAG), 40*1024)
	}
	fixture.daemon.EmitSession(fixture.chat.SessionFile, map[string]any{
		"type": "extension_event", "name": "omo.dag.updated", "data": dagData,
	})
	frame := frames.next(t, "sessions.activity")

	// Then the full REST body stays under the 2048-byte lean budget.
	req, err := http.NewRequest(http.MethodGet, fixture.serverURL+"/api/sessions/live", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: fixture.token})
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("live REST status = %d body=%s", resp.StatusCode, body)
	}
	if len(body) >= 2048 {
		t.Fatalf("live REST body = %d bytes, want < 2048 (injected raw DAG = %d bytes)", len(body), len(rawDAG))
	}
	t.Logf("byte budget: injected raw DAG = %d bytes, live REST body = %d bytes", len(rawDAG), len(body))

	var decoded struct {
		Sessions []map[string]any `json:"sessions"`
	}
	if err := json.Unmarshal(body, &decoded); err != nil || len(decoded.Sessions) != 1 {
		t.Fatalf("live REST decode = %v sessions=%d", err, len(decoded.Sessions))
	}

	// And both wire surfaces carry only the rendered scalars, no raw payloads.
	frameBytes, err := json.Marshal(frame)
	if err != nil {
		t.Fatal(err)
	}
	if len(frameBytes) >= 2048 {
		t.Fatalf("sessions.activity frame = %d bytes, want < 2048", len(frameBytes))
	}
	for name, row := range map[string]map[string]any{"REST": decoded.Sessions[0], "WS": frame} {
		t.Run(name, func(t *testing.T) {
			for _, key := range []string{"task", "dag", "task_digest", "dag_digest", "taskDigest", "dagDigest", "snapshots", "task_oversized", "dag_oversized"} {
				if _, exists := row[key]; exists {
					t.Errorf("raw payload key %q remains on %s", key, name)
				}
			}
			for key, want := range map[string]any{"done": float64(1), "dag_done": float64(5), "dag_total": float64(8), "last_line": "progress"} {
				if row[key] != want {
					t.Errorf("%s = %v, want %v", key, row[key], want)
				}
			}
			running, ok := row["running"].(map[string]any)
			if !ok {
				t.Fatal("running fields absent")
			}
			for key, want := range map[string]float64{"agents": 2, "tasks": 1, "dag": 1} {
				if running[key] != want {
					t.Errorf("running.%s = %v, want %v", key, running[key], want)
				}
			}
			truncated, ok := row["truncated"].(map[string]any)
			if !ok || truncated["task"] != false || truncated["dag"] != false {
				t.Errorf("truncated = %v", row["truncated"])
			}
		})
	}
	// No raw payload keys anywhere in the raw body text either.
	for _, needle := range []string{`"task_digest"`, `"dag_digest"`, `"snapshots"`, `"task_oversized"`, `"dag_oversized"`, "raw-node-output"} {
		if strings.Contains(string(body), needle) {
			t.Errorf("live REST body contains raw payload marker %q", needle)
		}
	}
}
