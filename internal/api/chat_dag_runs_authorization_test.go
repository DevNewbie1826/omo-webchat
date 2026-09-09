package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/DevNewbie1826/omo-webchat/internal/auth"
	"github.com/DevNewbie1826/omo-webchat/internal/cursorstore"
)

func TestChatDagRunAuthorization(t *testing.T) {
	t.Run("authenticationAndOwners", func(t *testing.T) {
		f := newDagHTTPFixture(t)
		source := dagFixtureRun("owned", 1, 1)
		writeDagFixture(t, filepath.Join(f.dir, "owned.json"), source)
		for _, suffix := range []string{"", "/owned"} {
			rec := httptest.NewRecorder()
			f.server.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, f.path+suffix, nil))
			if rec.Code != 401 {
				t.Fatalf("unauthenticated status=%d", rec.Code)
			}
		}
		if rec := f.get(t, "/owned"); rec.Code != 200 {
			t.Fatalf("authorized status=%d want 200", rec.Code)
		}
		foreign := dagFixtureRun("foreign", 1, 1)
		foreign["parentSessionId"] = "other"
		writeDagFixture(t, filepath.Join(f.dir, "foreign.json"), foreign)
		if rec := f.get(t, "/foreign"); rec.Code != 404 {
			t.Fatalf("foreign status=%d", rec.Code)
		}
		if err := f.store.SaveChat(cursorstore.Chat{ID: "other", WorkspaceID: f.ws.ID, CWD: f.ws.Path, DurableSessionID: "other"}); err != nil {
			t.Fatal(err)
		}
		if err := f.store.SaveWorkspace(cursorstore.Workspace{ID: "other-ws", Path: t.TempDir()}); err != nil {
			t.Fatal(err)
		}
		for _, path := range []string{strings.Replace(f.path, "dag-chat", "other", 1) + "/owned", strings.Replace(f.path, f.ws.ID, "other-ws", 1) + "/owned"} {
			req := httptest.NewRequest(http.MethodGet, path, nil)
			req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: f.token})
			rec := httptest.NewRecorder()
			f.server.Handler().ServeHTTP(rec, req)
			if rec.Code != 404 {
				t.Fatalf("cross-owner status=%d", rec.Code)
			}
		}
	})
	t.Run("legacyRequiresActualTaskLinkage", func(t *testing.T) {
		for _, tc := range []struct {
			name, parent, taskID, nodeID string
			want                         int
		}{{"verified", "", "task-node-00", "node-00", 200}, {"conflictingParent", "other", "task-node-00", "node-00", 404}, {"wrongTask", "", "unrelated", "node-00", 404}, {"wrongNode", "", "task-node-00", "unrelated", 404}, {"missingTaskID", "", "", "node-00", 404}} {
			t.Run(tc.name, func(t *testing.T) {
				f := newDagHTTPFixture(t)
				source := dagFixtureRun("legacy", 1, 1)
				source["parentSessionId"] = tc.parent
				writeDagFixture(t, filepath.Join(f.dir, "legacy.json"), source)
				task := map[string]any{"task_id": tc.taskID, "status": "running", "parent_session_id": "parent", "owner": map[string]any{"kind": "dag", "runId": "legacy", "nodeId": tc.nodeID}}
				writeDagFixture(t, filepath.Join(f.ws.Path, ".omo", "senpi-task", "tasks", "random.json"), task)
				if rec := f.get(t, "/legacy"); rec.Code != tc.want {
					t.Fatalf("status=%d want %d body=%s", rec.Code, tc.want, rec.Body.String())
				}
				rec := f.get(t, "")
				if rec.Code != 200 {
					t.Fatalf("catalog status=%d", rec.Code)
				}
				var body dagCatalogBody
				if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
					t.Fatal(err)
				}
				wantCount := 0
				if tc.want == 200 {
					wantCount = 1
				}
				if len(body.Runs) != wantCount {
					t.Fatalf("catalog exposed %d want %d", len(body.Runs), wantCount)
				}
			})
		}
	})
	t.Run("traversal", func(t *testing.T) {
		f := newDagHTTPFixture(t)
		for _, suffix := range []string{"/%2e%2e", "/..%2fsecret", "/%2fetc%2fpasswd", "/..%5csecret", "/%00"} {
			if rec := f.get(t, suffix); rec.Code != 404 {
				t.Fatalf("%s status=%d", suffix, rec.Code)
			}
		}
	})
	t.Run("symlinks", func(t *testing.T) {
		for _, component := range []string{"file", "runs", "dag", "senpi-task", ".omo"} {
			t.Run(component, func(t *testing.T) {
				f := newDagHTTPFixture(t)
				external := t.TempDir()
				source := dagFixtureRun("secret", 1, 1)
				target := filepath.Join(f.dir, "alias.json")
				outside := filepath.Join(external, "record.json")
				if component != "file" {
					target = f.dir
					for filepath.Base(target) != component {
						target = filepath.Dir(target)
					}
					suffix, err := filepath.Rel(target, f.dir)
					if err != nil {
						t.Fatal(err)
					}
					outside = external
					writeDagFixture(t, filepath.Join(external, suffix, "record.json"), source)
					if err := os.RemoveAll(target); err != nil {
						t.Fatal(err)
					}
				} else {
					writeDagFixture(t, outside, source)
				}
				if err := os.Symlink(outside, target); err != nil {
					t.Fatal(err)
				}
				rec := f.get(t, "/secret")
				if rec.Code != 404 || strings.Contains(rec.Body.String(), external) {
					t.Fatalf("symlink response %d %s", rec.Code, rec.Body.String())
				}
			})
		}
	})
}

func TestChatDagRunCompleteMalformed(t *testing.T) {
	for _, kind := range []string{"duplicateDefinition", "duplicateRuntime", "missingState", "unknownState", "missingPrompt", "missingRuntime", "missingDefinition", "danglingDependency", "invalidDependency", "invalidAttempt", "invalidNodes", "invalidJSON", "duplicateRunID"} {
		t.Run(kind, func(t *testing.T) {
			f := newDagHTTPFixture(t)
			source := dagFixtureRun("bad", 2, 1)
			def := source["definition"].(map[string]any)
			defs := def["nodes"].([]map[string]any)
			nodes := source["nodes"].([]map[string]any)
			switch kind {
			case "duplicateDefinition":
				defs[1]["id"] = defs[0]["id"]
			case "duplicateRuntime":
				nodes[1]["id"] = nodes[0]["id"]
			case "missingState":
				delete(nodes[1], "state")
			case "unknownState":
				nodes[1]["state"] = "invented"
			case "missingPrompt":
				delete(defs[1], "prompt")
			case "missingRuntime":
				source["nodes"] = nodes[:1]
			case "missingDefinition":
				def["nodes"] = defs[:1]
			case "danglingDependency":
				defs[1]["dependsOn"] = []string{"absent"}
			case "invalidDependency":
				defs[1]["dependsOn"] = []any{3}
			case "invalidAttempt":
				nodes[1]["attempt"] = -1
			case "invalidNodes":
				source["nodes"] = nil
			}
			path := filepath.Join(f.dir, "unrelated-filename.json")
			writeDagFixture(t, path, source)
			if kind == "invalidJSON" {
				if err := os.WriteFile(path, []byte(`{"runId":"bad","parentSessionId":"parent",`), 0600); err != nil {
					t.Fatal(err)
				}
			}
			if kind == "duplicateRunID" {
				writeDagFixture(t, filepath.Join(f.dir, "duplicate.json"), source)
			}
			for _, suffix := range []string{"/bad", ""} {
				rec := f.get(t, suffix)
				if rec.Code != 422 {
					t.Fatalf("%s status=%d want 422 body=%s", suffix, rec.Code, rec.Body.String())
				}
				var body map[string]json.RawMessage
				if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
					t.Fatal(err)
				}
				var message string
				if err := json.Unmarshal(body["error"], &message); err != nil || message == "" || strings.Contains(message, f.ws.Path) {
					t.Fatalf("invalid error response %s", rec.Body.String())
				}
				if _, ok := body["complete"]; ok {
					t.Fatal("malformed source represented as complete")
				}
			}
		})
	}
}
