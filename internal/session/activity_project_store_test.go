package session

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/DevNewbie1826/omo-webchat/internal/testfs"
)

func projectStoreFixture(t *testing.T, agentDir, cwd, basename string) string {
	t.Helper()
	canonical, err := filepath.EvalSymlinks(cwd)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte(canonical))
	return filepath.Join(agentDir, "projects", basename+"-"+hex.EncodeToString(sum[:])[:12], "senpi-task")
}

func writeProjectActivity(t *testing.T, base, id, parent string) {
	t.Helper()
	writeActivityStoreJSON(t, filepath.Join(base, "tasks", "owned.json"), map[string]any{
		"task_id": id, "status": "running", "parent_session_id": parent,
		"owner": map[string]any{"kind": "dag", "runId": "run-" + id, "nodeId": "inspect"},
	})
	writeActivityStoreJSON(t, filepath.Join(base, "dag", "runs", "owned.json"), map[string]any{
		"runId": "run-" + id, "status": "running",
		// Parentless checkpoints must use the task in the selected store.
		"definition": map[string]any{"nodes": []any{map[string]any{"id": "inspect", "prompt": "inspect"}}},
		"nodes":      []any{map[string]any{"id": "inspect", "state": "running", "taskId": id}},
	})
}

func TestProjectStoreReadersCanonicalCWDAndLegacyPrecedence(t *testing.T) {
	for _, legacy := range []bool{false, true} {
		t.Run(map[bool]string{false: "project", true: "legacy"}[legacy], func(t *testing.T) {
			// Given: a canonical Unicode/punctuation project reached via an alias.
			cwd := filepath.Join(t.TempDir(), "프로젝트 ²!")
			if err := os.Mkdir(cwd, 0700); err != nil {
				t.Fatal(err)
			}
			alias := filepath.Join(t.TempDir(), "alias")
			testfs.Symlink(t, cwd, alias)
			agent := t.TempDir()
			t.Setenv("OMO_CODING_AGENT_DIR", " \t"+agent+" \n")
			t.Setenv("SENPI_CODING_AGENT_DIR", t.TempDir())
			t.Setenv("PI_CODING_AGENT_DIR", t.TempDir())
			base := projectStoreFixture(t, agent, cwd, "프로젝트_²_")
			writeProjectActivity(t, base, "project-task", "parent")
			writeActivityStoreJSON(t, filepath.Join(base, "tasks", "foreign.json"), map[string]any{
				"task_id": "foreign", "status": "running", "parent_session_id": "other",
			})
			writeActivityStoreJSON(t, filepath.Join(base, "dag", "runs", "foreign.json"), map[string]any{
				"runId": "foreign", "status": "running", "parentSessionId": "other",
			})
			want := "project-task"
			if legacy {
				writeProjectActivity(t, filepath.Join(cwd, ".omo", "senpi-task"), "legacy-task", "parent")
				want = "legacy-task"
			}

			t.Run("history", func(t *testing.T) {
				// When / Then: history reads exactly the selected parent's task/run.
				activity, err := ReadHistoricalActivity(t.Context(), alias, "parent")
				if err != nil {
					t.Fatal(err)
				}
				var tasks historicalTaskSnapshot
				var dags historicalDagSnapshot
				if err := json.Unmarshal(activity.ActivityPair.Task, &tasks); err != nil {
					t.Fatal(err)
				}
				if err := json.Unmarshal(activity.ActivityPair.Dag, &dags); err != nil {
					t.Fatal(err)
				}
				if len(tasks.Tasks) != 1 || rawString(tasks.Tasks[0]["task_id"]) != want || len(dags.Runs) != 1 || dags.Runs[0].RunID != "run-"+want {
					t.Fatalf("history selected wrong store/parent: tasks=%s dags=%s", activity.ActivityPair.Task, activity.ActivityPair.Dag)
				}
			})
			t.Run("catalog", func(t *testing.T) {
				catalog, err := ReadDagCatalog(t.Context(), alias, "parent")
				if err != nil || len(catalog) != 1 || catalog[0].RunID != "run-"+want {
					t.Fatalf("catalog=%+v err=%v want run-%s", catalog, err, want)
				}
			})
			t.Run("complete", func(t *testing.T) {
				doc, err := ReadCompleteDag(t.Context(), alias, "parent", "run-"+want)
				if err != nil || !doc.Complete || len(doc.Run.Nodes) != 1 || doc.Run.Nodes[0].TaskID != want {
					t.Fatalf("complete=%+v err=%v want task %s", doc, err, want)
				}
			})
		})
	}
}

func TestProjectStoreHistoryCannotFollowExternalTaskDirectory(t *testing.T) {
	// Given: a new-layout store whose task directory points outside the root.
	cwd, agent, outside := t.TempDir(), t.TempDir(), t.TempDir()
	t.Setenv("OMO_CODING_AGENT_DIR", agent)
	base := projectStoreFixture(t, agent, cwd, filepath.Base(cwd))
	if err := os.MkdirAll(base, 0700); err != nil {
		t.Fatal(err)
	}
	writeActivityStoreJSON(t, filepath.Join(outside, "secret.json"), map[string]any{
		"task_id": "secret", "status": "running", "parent_session_id": "parent",
	})
	testfs.Symlink(t, outside, filepath.Join(base, "tasks"))
	// When / Then: no foreign record can be projected.
	activity, err := ReadHistoricalActivity(t.Context(), cwd, "parent")
	if err == nil && activity.TaskDigest != nil && len(activity.TaskDigest.Tasks) != 0 {
		t.Fatalf("external tasks leaked: %+v", activity.TaskDigest)
	}
}

type projectStoreReadContext struct {
	context.Context
	beforeRead func()
}

func (ctx *projectStoreReadContext) Err() error {
	if ctx.beforeRead != nil {
		action := ctx.beforeRead
		ctx.beforeRead = nil
		action()
	}
	return ctx.Context.Err()
}

func TestProjectStoreDagKeepsSelectedStoreForOwnership(t *testing.T) {
	// Given: project-state DAG and task are pinned before a legacy store appears.
	cwd, agent := t.TempDir(), t.TempDir()
	t.Setenv("OMO_CODING_AGENT_DIR", agent)
	base := projectStoreFixture(t, agent, cwd, filepath.Base(cwd))
	writeProjectActivity(t, base, "selected", "parent")
	ctx := &projectStoreReadContext{Context: t.Context(), beforeRead: func() {
		if err := os.MkdirAll(filepath.Join(cwd, ".omo", "senpi-task", "tasks"), 0700); err != nil {
			t.Fatal(err)
		}
	}}
	// When: the first source read synchronously creates the other layout.
	doc, err := ReadCompleteDag(ctx, cwd, "parent", "run-selected")
	// Then: ownership must be read from the same selected store as the graph.
	if err != nil || !doc.Complete || len(doc.Run.Nodes) != 1 || doc.Run.Nodes[0].TaskID != "selected" {
		t.Fatalf("selected store changed during ownership read: doc=%+v err=%v", doc, err)
	}
}

func TestProjectStoreEmptyLegacyStillWins(t *testing.T) {
	cwd, agent := t.TempDir(), t.TempDir()
	t.Setenv("OMO_CODING_AGENT_DIR", agent)
	writeProjectActivity(t, projectStoreFixture(t, agent, cwd, filepath.Base(cwd)), "unselected", "parent")
	if err := os.MkdirAll(filepath.Join(cwd, ".omo", "senpi-task"), 0700); err != nil {
		t.Fatal(err)
	}
	activity, err := ReadHistoricalActivity(t.Context(), cwd, "parent")
	if err != nil || len(activity.TaskDigest.Tasks) != 0 || len(activity.DagDigest.Runs) != 0 {
		t.Fatalf("empty legacy fell back to project store: activity=%+v err=%v", activity, err)
	}
	catalog, err := ReadDagCatalog(t.Context(), cwd, "parent")
	if err != nil || len(catalog) != 0 {
		t.Fatalf("empty legacy catalog=%+v err=%v", catalog, err)
	}
}

func TestProjectStoreMissingCWDUsesAbsoluteName(t *testing.T) {
	// Given: upstream retains the absolute path when realpath cannot resolve it.
	agent := t.TempDir()
	cwd := filepath.Join(agent, "not-created")
	t.Setenv("OMO_CODING_AGENT_DIR", agent)
	sum := sha256.Sum256([]byte(cwd))
	base := filepath.Join(agent, "projects", "not-created-"+hex.EncodeToString(sum[:])[:12], "senpi-task")
	writeProjectActivity(t, base, "missing-cwd", "parent")
	// When / Then: the reader uses that store without creating the cwd.
	catalog, err := ReadDagCatalog(t.Context(), cwd, "parent")
	if err != nil || len(catalog) != 1 || catalog[0].RunID != "run-missing-cwd" {
		t.Fatalf("missing cwd catalog=%+v err=%v", catalog, err)
	}
}
