package api

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/DevNewbie1826/omo-webchat/internal/auth"
	"github.com/DevNewbie1826/omo-webchat/internal/cursorstore"
)

type dagHTTPFixture struct {
	server           *Server
	store            *testMetadataStore
	ws               cursorstore.Workspace
	dir, path, token string
}

func newDagHTTPFixture(t *testing.T) dagHTTPFixture {
	t.Helper()
	server, store, ws := newChatCreateTestServer(t)
	chat := cursorstore.Chat{ID: "dag-chat", WorkspaceID: ws.ID, CWD: ws.Path, DurableSessionID: "parent", Name: "DAG"}
	if err := store.SaveChat(chat); err != nil {
		t.Fatal(err)
	}
	token, err := server.sessions.Create(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(ws.Path, ".omo", "senpi-task", "dag", "runs")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	return dagHTTPFixture{server, store, ws, dir, "/api/workspaces/" + ws.ID + "/chats/" + chat.ID + "/dag-runs", token}
}

func (f dagHTTPFixture) get(t *testing.T, suffix string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, f.path+suffix, nil).WithContext(t.Context())
	req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: f.token})
	rec := httptest.NewRecorder()
	f.server.Handler().ServeHTTP(rec, req)
	return rec
}

var dagFixtureStates = []string{"pending", "blocked", "scheduled", "running", "completed", "failed", "cancelled", "skipped"}

func dagFixtureRun(id string, count, promptBytes int) map[string]any {
	defs, nodes := make([]map[string]any, count), make([]map[string]any, count)
	for i := range count {
		deps := make([]string, i)
		for j := range deps {
			deps[j] = fmt.Sprintf("node-%02d", j)
		}
		nodeID := fmt.Sprintf("node-%02d", i)
		defs[i] = map[string]any{"id": nodeID, "label": "label-" + nodeID, "prompt": strings.Repeat("p", promptBytes), "dependsOn": deps}
		nodes[i] = map[string]any{"id": nodeID, "state": dagFixtureStates[i%len(dagFixtureStates)], "attempt": i, "taskId": "task-" + nodeID, "startedAt": "2026-09-03T10:00:00.123456789+09:00", "completedAt": "2026-09-03T11:00:00.987654321+09:00"}
	}
	return map[string]any{"schemaVersion": 1, "runId": id, "runKey": "key-" + id, "name": "name-" + id, "status": "running", "parentSessionId": "parent", "createdAt": "2026-09-03T10:00:00.123456789+09:00", "updatedAt": "2026-09-03T11:00:00.987654321+09:00", "definition": map[string]any{"nodes": defs}, "nodes": nodes}
}

func writeDagFixture(t *testing.T, path string, value any) []byte {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	return data
}

type dagHTTPDocument struct {
	Complete     bool   `json:"complete"`
	ContentToken string `json:"content_token"`
	Run          struct {
		RunID     string         `json:"run_id"`
		RunKey    string         `json:"run_key"`
		Name      string         `json:"name"`
		Status    string         `json:"status"`
		CreatedAt string         `json:"created_at"`
		UpdatedAt string         `json:"updated_at"`
		Counts    map[string]int `json:"counts"`
		Nodes     []struct {
			ID          string   `json:"id"`
			Label       string   `json:"label"`
			Prompt      string   `json:"prompt"`
			DependsOn   []string `json:"depends_on"`
			State       string   `json:"state"`
			Attempt     *int     `json:"attempt"`
			TaskID      string   `json:"task_id"`
			StartedAt   string   `json:"started_at"`
			CompletedAt string   `json:"completed_at"`
		} `json:"nodes"`
		Edges []struct {
			From string `json:"from"`
			To   string `json:"to"`
		} `json:"edges"`
		Waves []struct {
			Index   int      `json:"index"`
			NodeIDs []string `json:"node_ids"`
		} `json:"waves"`
	} `json:"run"`
}

func decodeDagDocument(t *testing.T, rec *httptest.ResponseRecorder) dagHTTPDocument {
	t.Helper()
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	var doc dagHTTPDocument
	if err := json.Unmarshal(rec.Body.Bytes(), &doc); err != nil {
		t.Fatal(err)
	}
	return doc
}

func assertFullDag(t *testing.T, doc dagHTTPDocument, source map[string]any, data []byte) {
	t.Helper()
	sum := sha256.Sum256(data)
	if !doc.Complete || doc.ContentToken != hex.EncodeToString(sum[:]) {
		t.Fatalf("complete=%v token=%q, want original-byte SHA256", doc.Complete, doc.ContentToken)
	}
	if doc.Run.RunID != source["runId"] || doc.Run.RunKey != source["runKey"] || doc.Run.Name != source["name"] || doc.Run.Status != source["status"] || doc.Run.CreatedAt != source["createdAt"] || doc.Run.UpdatedAt != source["updatedAt"] {
		t.Fatal("run identity/metadata/timestamps differ from source")
	}
	defs := source["definition"].(map[string]any)["nodes"].([]map[string]any)
	nodes := source["nodes"].([]map[string]any)
	if len(doc.Run.Nodes) != len(nodes) {
		t.Fatalf("nodes=%d want %d", len(doc.Run.Nodes), len(nodes))
	}
	counts := map[string]int{"total": len(nodes)}
	for _, state := range dagFixtureStates {
		counts[state] = 0
	}
	edgeIndex := 0
	for i, node := range doc.Run.Nodes {
		def, runtime := defs[i], nodes[i]
		counts[runtime["state"].(string)]++
		prompt := def["prompt"]
		if p, ok := runtime["prompt"].(string); ok && p != "" {
			prompt = p
		}
		label := def["label"]
		if l, ok := runtime["label"].(string); ok && l != "" {
			label = l
		}
		if node.ID != runtime["id"] || node.Label != label || node.Prompt != prompt || !reflect.DeepEqual(node.DependsOn, def["dependsOn"]) || node.State != runtime["state"] || node.Attempt == nil || *node.Attempt != runtime["attempt"] || node.TaskID != runtime["taskId"] || node.StartedAt != runtime["startedAt"] || node.CompletedAt != runtime["completedAt"] {
			t.Fatalf("node %d differs from source", i)
		}
		for _, dep := range node.DependsOn {
			if edgeIndex >= len(doc.Run.Edges) || doc.Run.Edges[edgeIndex].From != dep || doc.Run.Edges[edgeIndex].To != node.ID {
				t.Fatalf("edge %d differs", edgeIndex)
			}
			edgeIndex++
		}
	}
	if edgeIndex != len(doc.Run.Edges) || !reflect.DeepEqual(doc.Run.Counts, counts) {
		t.Fatalf("edges/counts differ: %d/%d counts=%v want=%v", edgeIndex, len(doc.Run.Edges), doc.Run.Counts, counts)
	}
	if len(doc.Run.Waves) != len(nodes) {
		t.Fatalf("waves=%d want %d", len(doc.Run.Waves), len(nodes))
	}
	for i, wave := range doc.Run.Waves {
		if wave.Index != i || !reflect.DeepEqual(wave.NodeIDs, []string{nodes[i]["id"].(string)}) {
			t.Fatalf("wave %d differs", i)
		}
	}
}

func TestChatDagRunComplete(t *testing.T) {
	for _, tc := range []struct {
		name         string
		count, bytes int
	}{{"dense64", 64, 2048}, {"over4MiB", 64, 70 << 10}} {
		t.Run(tc.name, func(t *testing.T) {
			f := newDagHTTPFixture(t)
			source := dagFixtureRun(tc.name, tc.count, tc.bytes)
			// Stored names deliberately have no relationship to the embedded run ID.
			data := writeDagFixture(t, filepath.Join(f.dir, "checkpoint-random.json"), source)
			if tc.name == "over4MiB" && len(data) <= 4<<20 {
				t.Fatal("fixture must exceed old record cap")
			}
			doc := decodeDagDocument(t, f.get(t, "/"+tc.name))
			assertFullDag(t, doc, source, data)
		})
	}
	t.Run("combined64KiB", func(t *testing.T) {
		f := newDagHTTPFixture(t)
		for i := range 16 {
			id := fmt.Sprintf("run-%02d", i)
			source := dagFixtureRun(id, 8, 2048)
			data := writeDagFixture(t, filepath.Join(f.dir, fmt.Sprintf("file-%02d.json", 15-i)), source)
			assertFullDag(t, decodeDagDocument(t, f.get(t, "/"+id)), source, data)
		}
	})
	t.Run("longDistinctIDs", func(t *testing.T) {
		f := newDagHTTPFixture(t)
		id := strings.Repeat("r", 600) + "a"
		source := dagFixtureRun(id, 2, 2048)
		defs := source["definition"].(map[string]any)["nodes"].([]map[string]any)
		nodes := source["nodes"].([]map[string]any)
		a, b := strings.Repeat("n", 600)+"a", strings.Repeat("n", 600)+"b"
		defs[0]["id"], nodes[0]["id"] = a, a
		defs[1]["id"], nodes[1]["id"] = b, b
		defs[1]["dependsOn"] = []string{a}
		nodes[0]["taskId"] = strings.Repeat("t", 600) + "a"
		nodes[1]["taskId"] = strings.Repeat("t", 600) + "b"
		nodes[0]["prompt"] = "runtime-" + strings.Repeat("x", 2048)
		nodes[0]["label"] = "runtime-label"
		data := writeDagFixture(t, filepath.Join(f.dir, "long.json"), source)
		other := dagFixtureRun(strings.Repeat("r", 600)+"b", 1, 2048)
		writeDagFixture(t, filepath.Join(f.dir, "other.json"), other)
		assertFullDag(t, decodeDagDocument(t, f.get(t, "/"+url.PathEscape(id))), source, data)
	})
}

// The context read boundary is synchronous: no timer or scheduler luck controls
// replacement. It fires during the first source read, after the descriptor has
// been pinned. It does not fake any filesystem or handler behavior.
type dagReadBarrierContext struct {
	context.Context
	onRead func()
}

func (c *dagReadBarrierContext) Err() error {
	if c.onRead != nil {
		f := c.onRead
		c.onRead = nil
		f()
	}
	return c.Context.Err()
}
