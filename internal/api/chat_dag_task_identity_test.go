package api

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Exercise the authenticated activity and complete handlers against the same
// owned checkpoint. The optional export is evidence, never a test prerequisite.
func TestChatDagRunTaskIdentityProjection(t *testing.T) {
	for _, tc := range []struct {
		name, taskID, projected string
		lossy                   bool
	}{
		{"ascii601", strings.Repeat("t", 600) + "a", strings.Repeat("t", 512), true},
		{"utf8Boundary", strings.Repeat("界", 201), strings.Repeat("界", 170), true},
		{"exact512", strings.Repeat("t", 512), strings.Repeat("t", 512), false},
		{"short", "task-exact", "task-exact", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newDagHTTPFixture(t)
			source := dagFixtureRun("r1", 64, 2048)
			source["nodes"].([]map[string]any)[0]["taskId"] = tc.taskID
			data := writeDagFixture(t, filepath.Join(f.dir, "owned.json"), source)
			activity := authenticatedActivityRequest(t, f.server, f.token, f.ws.ID, "dag-chat")
			if activity.Code != http.StatusOK {
				t.Fatalf("activity status=%d body=%s", activity.Code, activity.Body.String())
			}
			full := f.get(t, "/r1")
			document := decodeDagDocument(t, full)
			assertFullDag(t, document, source, data)
			var body chatActivityResponse
			if err := json.Unmarshal(activity.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			if len(body.Dag) == 0 || len(body.Dag) > 64<<10 {
				t.Fatalf("bounded projection bytes=%d", len(body.Dag))
			}
			var snapshot struct {
				Truncated bool `json:"truncated_runs"`
				Runs      []struct {
					UpdatedAt string           `json:"updated_at"`
					Nodes     []map[string]any `json:"nodes"`
				} `json:"runs"`
			}
			if err := json.Unmarshal(body.Dag, &snapshot); err != nil {
				t.Fatal(err)
			}
			if !snapshot.Truncated || len(snapshot.Runs) != 1 || len(snapshot.Runs[0].Nodes) == 0 {
				t.Fatalf("missing bounded partial run: %s", body.Dag)
			}
			if snapshot.Runs[0].UpdatedAt != document.Run.UpdatedAt {
				t.Fatal("projection and full revision differ")
			}
			first := snapshot.Runs[0].Nodes[0]
			if first["id"] != "node-00" || first["task_id"] != tc.projected || len(tc.projected) > 512 {
				t.Fatalf("projected node=%v want exact short node and task fragment %q", first, tc.projected)
			}
			if dir := os.Getenv("F1_HTTP_FIXTURE_DIR"); dir != "" {
				writeDagFixture(t, filepath.Join(dir, tc.name+".json"), map[string]any{
					"activity": json.RawMessage(activity.Body.Bytes()), "complete": json.RawMessage(full.Body.Bytes()),
				})
			}
			// This assertion fails on behavior (missing wire provenance), not a new Go symbol.
			lossy, _ := first["task_id_truncated"].(bool)
			if lossy != tc.lossy {
				t.Fatalf("task_id_truncated=%v want %v for %d source bytes", first["task_id_truncated"], tc.lossy, len(tc.taskID))
			}
		})
	}
}
