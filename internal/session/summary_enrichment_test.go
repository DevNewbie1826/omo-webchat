package session

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestDeriveSessionTitleMatchesLegacyRules(t *testing.T) {
	for _, test := range []struct{ prompt, want string }{
		{prompt: "  # Build   the thing\nignored", want: "Build the thing"},
		{prompt: "/compact", want: ""},
		{prompt: strings.Repeat("界", 51), want: strings.Repeat("界", 50) + "…"},
	} {
		if got := DeriveSessionTitle(test.prompt); got != test.want {
			t.Fatalf("DeriveSessionTitle(%q) = %q, want %q", test.prompt, got, test.want)
		}
	}
}

func TestSummaryCarriesBoundedActivityPairDigestsAndOversizedFlags(t *testing.T) {
	s := &Session{
		chatID:               "v2",
		durableID:            "durable",
		activitySnapshots:    make(map[string]json.RawMessage),
		activityOversized:    make(map[string]bool),
		completedCompactions: make(map[string]struct{}),
	}
	task := map[string]any{"tasks": []any{map[string]any{"task_id": "t1", "status": "running"}}}
	dag := map[string]any{"runs": []any{map[string]any{"run_id": "r1", "status": "running", "nodes": []any{map[string]any{"state": "running", "task_id": "t1"}}}}}
	for name, data := range map[string]any{activitySnapshotOrder[0]: task, activitySnapshotOrder[1]: dag} {
		s.lifecycleMu.Lock()
		s.forwardExtensionEventLocked(map[string]any{"name": name, "data": data})
		s.lifecycleMu.Unlock()
	}
	s.title = DeriveSessionTitle("# Ship v2 summaries")

	summary, ok := s.summary()
	if !ok {
		t.Fatal("summary absent")
	}
	if summary.Title != "Ship v2 summaries" || len(summary.ActivityPair.Task) == 0 || len(summary.ActivityPair.Dag) == 0 {
		t.Fatalf("summary = %+v", summary)
	}
	if summary.TaskDigest == nil || len(summary.TaskDigest.Tasks) != 1 || summary.DagDigest == nil || len(summary.DagDigest.Runs) != 1 {
		t.Fatalf("digests = (%+v, %+v)", summary.TaskDigest, summary.DagDigest)
	}

	oversized := map[string]any{"pad": strings.Repeat("x", maxActivitySnapshotBytes+1)}
	s.lifecycleMu.Lock()
	s.forwardExtensionEventLocked(map[string]any{"name": activitySnapshotOrder[0], "data": oversized})
	s.lifecycleMu.Unlock()
	after, _ := s.summary()
	if !after.TaskOversized {
		t.Fatal("TaskOversized = false")
	}
	if len(after.ActivityPair.Task) > maxActivitySnapshotBytes {
		t.Fatalf("retained task grew to %d bytes", len(after.ActivityPair.Task))
	}
}
