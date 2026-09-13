package api

import (
	"encoding/json"
	"testing"

	"github.com/DevNewbie1826/omo-webchat/internal/session"
)

func assertLiveRowCounts(t *testing.T, row map[string]any) {
	t.Helper()
	running, ok := row["running"].(map[string]any)
	if !ok {
		t.Fatalf("running absent: %v", row)
	}
	assertDigestScalar(t, running, "tasks", 50)
	assertDigestScalar(t, running, "dag", 600)
	assertDigestScalar(t, running, "agents", 650)
	assertDigestScalar(t, row, "done", 550)
	truncated, ok := row["truncated"].(map[string]any)
	if !ok || truncated["task"] != true || truncated["dag"] != true {
		t.Fatalf("truncation lost: %v", row)
	}
	for _, key := range []string{"task", "dag", "snapshots", "taskDigest", "dagDigest", "task_digest", "dag_digest"} {
		if _, exists := row[key]; exists {
			t.Fatalf("raw payload %s leaked", key)
		}
	}
}

func digestObject(t *testing.T, digest any) map[string]any {
	t.Helper()
	payload, err := json.Marshal(digest)
	if err != nil {
		t.Fatal(err)
	}
	var value map[string]any
	if err := json.Unmarshal(payload, &value); err != nil {
		t.Fatal(err)
	}
	return value
}

func retainedDagDigest(t *testing.T, manager *session.Manager, id string) map[string]any {
	t.Helper()
	for _, summary := range manager.LiveSummaries() {
		if summary.ChatID == id {
			return digestObject(t, summary.DagDigest)
		}
	}
	t.Fatalf("missing summary %s", id)
	return nil
}

func (f *countsE2EFixture) assertRetainedCounts() {
	f.t.Helper()
	for _, summary := range f.manager.LiveSummaries() {
		if summary.ChatID != f.chat.ID {
			continue
		}
		payload, err := json.Marshal(map[string]any{"task_digest": summary.TaskDigest, "dag_digest": summary.DagDigest})
		if err != nil {
			f.t.Fatal(err)
		}
		var row map[string]any
		if err := json.Unmarshal(payload, &row); err != nil {
			f.t.Fatal(err)
		}
		assertRetainedCountDigests(f.t, row)
		return
	}
	f.t.Fatal("manager summary missing")
}
