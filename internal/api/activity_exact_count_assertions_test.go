package api

import (
	"encoding/json"
	"testing"
)

func assertOptionalDagRunPair(t *testing.T, value any, known bool) {
	t.Helper()
	digest, ok := value.(map[string]any)
	if !ok {
		t.Fatalf("missing DAG digest: %v", value)
	}
	for _, key := range []string{"run_running_count", "run_total_count"} {
		count, present := digest[key]
		if present != known || (known && count != float64(1)) {
			t.Fatalf("DAG %s = %v (present=%v), want known=%v and 1: %v", key, count, present, known, digest)
		}
	}
}

func assertExactCountFrame(t *testing.T, name string, frame map[string]any) {
	t.Helper()
	switch name {
	case "omo.task.updated":
		assertDigestScalar(t, frame["running"].(map[string]any), "tasks", 50)
		assertDigestScalar(t, frame, "done", 470)
	case "omo.dag.updated":
		assertDigestScalar(t, frame["running"].(map[string]any), "dag", 3)
		assertDigestScalar(t, frame["running"].(map[string]any), "agents", 50)
	}
}

// assertExactCountDigest fails on absent scalars (nil pointers) so the test
// cannot pass on truncation-derived field omission.
func assertExactCountDigest(t *testing.T, label, kind string, value any, wantRunning, wantTotal int) {
	t.Helper()
	digest, ok := value.(map[string]any)
	if !ok || digest == nil {
		t.Fatalf("%s absent (%s)", label, kind)
	}
	raw, err := json.Marshal(digest)
	if err != nil {
		t.Fatal(err)
	}
	var typed struct {
		RunningCount    *int  `json:"running_count"`
		TotalCount      *int  `json:"total_count"`
		RunRunningCount *int  `json:"run_running_count"`
		RunTotalCount   *int  `json:"run_total_count"`
		Truncated       bool  `json:"truncated"`
		Tasks           []any `json:"tasks"`
		Runs            []any `json:"runs"`
	}
	if err := json.Unmarshal(raw, &typed); err != nil {
		t.Fatal(err)
	}
	if typed.RunningCount == nil {
		t.Fatalf("%s running_count absent: %s", label, raw)
	}
	if got := *typed.RunningCount; got != wantRunning {
		t.Fatalf("%s running_count = %d, want %d", label, got, wantRunning)
	}
	if wantTotal >= 0 {
		if typed.TotalCount == nil {
			t.Fatalf("%s total_count absent: %s", label, raw)
		}
		if got := *typed.TotalCount; got != wantTotal {
			t.Fatalf("%s total_count = %d, want %d (pre-truncation total)", label, got, wantTotal)
		}
		if !typed.Truncated || len(typed.Tasks) >= wantTotal {
			t.Fatalf("%s rows must stay truncated: truncated=%v rows=%d", label, typed.Truncated, len(typed.Tasks))
		}
		return
	}
	if len(typed.Runs) != 2 {
		t.Fatalf("%s runs = %s", label, raw)
	}
	// The DAG side also reports run membership, not just node work: both
	// emitted runs are non-terminal, so the exact pair is 2 running of 2.
	if typed.RunRunningCount == nil || typed.RunTotalCount == nil {
		t.Fatalf("%s run count scalars absent: %s", label, raw)
	}
	if got := *typed.RunRunningCount; got != 2 {
		t.Fatalf("%s run_running_count = %d, want 2", label, got)
	}
	if got := *typed.RunTotalCount; got != 2 {
		t.Fatalf("%s run_total_count = %d, want 2", label, got)
	}
}
