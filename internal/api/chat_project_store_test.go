package api

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/DevNewbie1826/omo-webchat/internal/auth"
	"github.com/DevNewbie1826/omo-webchat/internal/cursorstore"
	"github.com/DevNewbie1826/omo-webchat/internal/testfs"
)

func newProjectStoreHTTPFixture(t *testing.T) (taskHTTPFixture, string) {
	t.Helper()
	server, store, ws := newChatCreateTestServer(t)
	if err := store.SaveChat(cursorstore.Chat{ID: "project", WorkspaceID: ws.ID, CWD: ws.Path, DurableSessionID: "parent"}); err != nil {
		t.Fatal(err)
	}
	token, err := server.sessions.Create(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	agent := t.TempDir()
	t.Setenv("OMO_CODING_AGENT_DIR", agent)
	cwd, err := filepath.EvalSymlinks(ws.Path)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte(cwd))
	base := filepath.Join(agent, "projects", filepath.Base(cwd)+"-"+hex.EncodeToString(sum[:])[:12], "senpi-task")
	f := taskHTTPFixture{server, store, ws, filepath.Join(base, "tasks"), "/api/workspaces/" + ws.ID + "/chats/project", token}
	return f, base
}

func seedProjectHTTPStore(t *testing.T, base, taskID string) {
	t.Helper()
	writeTaskStoreJSON(t, filepath.Join(base, "tasks", "owned.json"), map[string]any{
		"task_id": taskID, "status": "running", "parent_session_id": "parent",
		"owner": map[string]any{"kind": "dag", "runId": "run-" + taskID, "nodeId": "node-00"},
	})
	source := dagFixtureRun("run-"+taskID, 1, 10)
	delete(source, "parentSessionId")
	source["nodes"].([]map[string]any)[0]["taskId"] = taskID
	writeDagFixture(t, filepath.Join(base, "dag", "runs", "owned.json"), source)
}

func TestProjectStoreHTTPReaders(t *testing.T) {
	for _, legacy := range []bool{false, true} {
		for _, endpoint := range []string{"/activity", "/tasks", "/dag-runs", "/dag-runs/run-selected"} {
			t.Run(map[bool]string{false: "project", true: "legacy"}[legacy]+endpoint, func(t *testing.T) {
				// Given: two distinct layouts plus foreign records in the selected store.
				f, base := newProjectStoreHTTPFixture(t)
				want := "selected"
				if legacy {
					seedProjectHTTPStore(t, base, "not-selected")
					base = filepath.Join(f.ws.Path, ".omo", "senpi-task")
				}
				seedProjectHTTPStore(t, base, want)
				writeTaskStoreJSON(t, filepath.Join(base, "tasks", "foreign.json"), map[string]any{
					"task_id": "foreign", "status": "running", "parent_session_id": "other",
				})
				foreign := dagFixtureRun("foreign", 1, 10)
				foreign["parentSessionId"] = "other"
				writeDagFixture(t, filepath.Join(base, "dag", "runs", "foreign.json"), foreign)
				// When: a real authenticated HTTP request crosses the router.
				srv := httptest.NewServer(f.server.Handler())
				t.Cleanup(srv.Close)
				req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, srv.URL+f.path+endpoint, nil)
				if err != nil {
					t.Fatal(err)
				}
				req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: f.token})
				res, err := srv.Client().Do(req)
				if err != nil {
					t.Fatal(err)
				}
				defer res.Body.Close()
				data, err := io.ReadAll(res.Body)
				if err != nil {
					t.Fatal(err)
				}
				var pretty bytes.Buffer
				if err := json.Indent(&pretty, data, "", "  "); err != nil {
					t.Fatal(err)
				}
				t.Logf("HTTP %s %s\nheaders=%v\nbody=%s", req.URL.Path, res.Status, res.Header, pretty.Bytes())
				// Then: the correct task/run is returned, never another parent/layout.
				if res.StatusCode != http.StatusOK {
					t.Fatalf("HTTP %d body=%s", res.StatusCode, data)
				}
				switch endpoint {
				case "/activity":
					var body chatActivityResponse
					if err := json.Unmarshal(data, &body); err != nil {
						t.Fatal(err)
					}
					if body.TaskDigest == nil || len(body.TaskDigest.Tasks) != 1 || body.TaskDigest.Tasks[0].TaskID != want || body.DagDigest == nil || len(body.DagDigest.Runs) != 1 || body.DagDigest.Runs[0].RunID != "run-"+want {
						t.Fatalf("wrong activity: %s", data)
					}
				case "/tasks":
					var body chatTasksBody
					if err := json.Unmarshal(data, &body); err != nil {
						t.Fatal(err)
					}
					if len(body.Tasks) != 1 || body.Tasks[0]["task_id"] != want {
						t.Fatalf("wrong roster: %s", data)
					}
				case "/dag-runs":
					var body dagCatalogBody
					if err := json.Unmarshal(data, &body); err != nil {
						t.Fatal(err)
					}
					if len(body.Runs) != 1 || body.Runs[0].RunID != "run-"+want {
						t.Fatalf("wrong catalog: %s", data)
					}
				default:
					var body dagHTTPDocument
					if err := json.Unmarshal(data, &body); err != nil {
						t.Fatal(err)
					}
					if !body.Complete || body.Run.RunID != "run-"+want || len(body.Run.Nodes) != 1 || body.Run.Nodes[0].TaskID != want {
						t.Fatalf("wrong detail: %s", data)
					}
				}
			})
		}
	}
}

func TestProjectStoreHTTPRejectsSymlinkedStateComponents(t *testing.T) {
	for _, component := range []string{"projects", "project", "senpi-task"} {
		for _, endpoint := range []string{"/activity", "/tasks", "/dag-runs", "/dag-runs/run-secret"} {
			t.Run(component+endpoint, func(t *testing.T) {
				f, base := newProjectStoreHTTPFixture(t)
				target := base
				if component == "project" {
					target = filepath.Dir(base)
				} else if component == "projects" {
					target = filepath.Dir(filepath.Dir(base))
				}
				outside := t.TempDir()
				suffix, err := filepath.Rel(target, base)
				if err != nil {
					t.Fatal(err)
				}
				seedProjectHTTPStore(t, filepath.Join(outside, suffix), "secret")
				if err := os.MkdirAll(filepath.Dir(target), 0700); err != nil {
					t.Fatal(err)
				}
				testfs.Symlink(t, outside, target)
				assertJSONNotFound(t, f.get(t, f.path+endpoint))
			})
		}
	}
}

func TestProjectStoreHTTPMissingIsEmpty(t *testing.T) {
	for _, endpoint := range []string{"/activity", "/tasks", "/dag-runs"} {
		t.Run(endpoint, func(t *testing.T) {
			f, _ := newProjectStoreHTTPFixture(t)
			rec := f.get(t, f.path+endpoint)
			if rec.Code != http.StatusOK {
				t.Fatalf("missing store status=%d body=%s", rec.Code, rec.Body.String())
			}
			if endpoint == "/activity" {
				var body chatActivityResponse
				if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
					t.Fatal(err)
				}
				if body.TaskDigest == nil || len(body.TaskDigest.Tasks) != 0 || body.DagDigest == nil || len(body.DagDigest.Runs) != 0 {
					t.Fatalf("missing activity store body=%s", rec.Body.String())
				}
				return
			}
			var body struct {
				Tasks []json.RawMessage `json:"tasks"`
				Runs  []json.RawMessage `json:"runs"`
			}
			if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || len(body.Tasks) != 0 || len(body.Runs) != 0 {
				t.Fatalf("missing store body=%s err=%v", rec.Body.String(), err)
			}
		})
	}
}
