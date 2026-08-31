package chat

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func TestReconcileActivityPairPreservesTerminalNodeOutcomes(t *testing.T) {
	for _, outcome := range []string{"completed", "failed", "cancelled"} {
		t.Run(outcome, func(t *testing.T) {
			pair := ActivitySnapshotPair{
				Task: json.RawMessage(`{"tasks":[{"task_id":"task-1","status":"running"}]}`),
				Dag:  json.RawMessage(`{"runs":[{"status":"completed","nodes":[{"task_id":"task-1","state":"` + outcome + `"}]}]}`),
			}

			got := reconcileActivityPair(pair)
			var payload struct {
				Tasks []struct {
					Status string `json:"status"`
				} `json:"tasks"`
			}
			if err := json.Unmarshal(got.Task, &payload); err != nil {
				t.Fatalf("reconciled task payload is invalid: %v (%s)", err, got.Task)
			}
			if len(payload.Tasks) != 1 || payload.Tasks[0].Status != outcome {
				t.Fatalf("reconciled status = %q, want %q; payload: %s", payload.Tasks[0].Status, outcome, got.Task)
			}
		})
	}
}

func TestReconcileActivityPairFallsBackToTerminalRunOutcome(t *testing.T) {
	pair := ActivitySnapshotPair{
		Task: json.RawMessage(`{"tasks":[{"task_id":"task-1","status":"running"}]}`),
		Dag:  json.RawMessage(`{"runs":[{"status":"failed","nodes":[{"task_id":"task-1","state":"running"}]}]}`),
	}

	got := reconcileActivityPair(pair)
	if !strings.Contains(string(got.Task), `"status":"failed"`) {
		t.Fatalf("reconciled task did not inherit terminal run outcome: %s", got.Task)
	}
}

func TestReconcileActivityPairSkipsTaskWithNonStringStatus(t *testing.T) {
	pair := ActivitySnapshotPair{
		Task: json.RawMessage(`{"tasks":[{"task_id":"task-1","status":7,"opaque":9007199254740993}]}`),
		Dag:  json.RawMessage(`{"runs":[{"status":"completed","nodes":[{"task_id":"task-1","state":"completed"}]}]}`),
	}

	got := reconcileActivityPair(pair)
	if !got.Equal(pair) {
		t.Fatalf("malformed task row was rewritten: got %s, want byte-identical %s", got.Task, pair.Task)
	}
}

func TestReconcileActivityPairPreservesUnknownLargeNumber(t *testing.T) {
	pair := ActivitySnapshotPair{
		Task: json.RawMessage(`{"tasks":[{"task_id":"task-1","status":"running","opaque":9007199254740993}]}`),
		Dag:  json.RawMessage(`{"runs":[{"status":"completed","nodes":[{"task_id":"task-1","state":"completed"}]}]}`),
	}

	got := reconcileActivityPair(pair)
	if !bytes.Contains(got.Task, []byte(`"opaque":9007199254740993`)) {
		t.Fatalf("unknown numeric field did not survive exactly: %s", got.Task)
	}
	if !bytes.Contains(got.Task, []byte(`"status":"completed"`)) {
		t.Fatalf("eligible row was not demoted: %s", got.Task)
	}
}

func TestReconcileActivityPairReturnsUnchangedPairByteIdentical(t *testing.T) {
	pair := ActivitySnapshotPair{
		Task: json.RawMessage("{ \"tasks\" : [{\"task_id\":\"other\",\"status\":\"running\",\"opaque\":9007199254740993}] }"),
		Dag:  json.RawMessage(`{"runs":[{"status":"completed","nodes":[{"task_id":"task-1","state":"completed"}]}]}`),
	}

	got := reconcileActivityPair(pair)
	if !got.Equal(pair) {
		t.Fatalf("unchanged pair lost byte identity: got task %q dag %q", got.Task, got.Dag)
	}
}
