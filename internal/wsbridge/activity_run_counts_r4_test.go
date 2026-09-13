package wsbridge

import (
	"encoding/json"
	"testing"

	"github.com/DevNewbie1826/omo-webchat/internal/session"
)

func TestActivityRunCountsUnavailableOnSocket(t *testing.T) {
	// Given a subscription and explicitly unavailable DAG membership.
	source := newTestActivitySource()
	conn, frames, _ := connectActivityBridge(t, source)
	writeClient(t, conn, map[string]any{"type": "sessions.subscribe", "mode": "all_live"})
	awaitSignal(t, source.subscribed, "activity subscription")
	frames.next(t, "ack")
	summary := activitySummary("counts")
	summary.DagDigest = &session.DagDigest{RunCountsUnavailable: true}
	// When the summary is published.
	source.publish(summary)
	raw := frames.next(t, "sessions.activity")
	// Then uncertainty survives without transporting the per-run digest.
	if raw["truncated"].(map[string]any)["dag"] != true {
		t.Fatalf("missing withdrawal: %v", raw)
	}
	if _, exists := raw["dagDigest"]; exists {
		t.Fatalf("raw digest leaked: %v", raw)
	}
}

// Run-pair omission belongs to the retained digest codec now, not the live row.
func TestRetainedDagDigestOmitsUnavailableRunCounts(t *testing.T) {
	for _, unavailable := range []bool{false, true} {
		t.Run(map[bool]string{false: "legacy", true: "withdrawn"}[unavailable], func(t *testing.T) {
			// Given legacy or explicitly withdrawn run authority.
			digest := session.DagDigest{RunCountsUnavailable: unavailable}
			// When the retained digest is serialized.
			payload, err := json.Marshal(digest)
			if err != nil {
				t.Fatal(err)
			}
			var raw map[string]any
			if err := json.Unmarshal(payload, &raw); err != nil {
				t.Fatal(err)
			}
			// Then withdrawal is optional, and no exact-looking run pair appears.
			_, present := raw["run_counts_unavailable"]
			if present != unavailable {
				t.Fatalf("withdrawal = %v", raw)
			}
			for _, key := range []string{"run_running_count", "run_total_count"} {
				if _, exists := raw[key]; exists {
					t.Fatalf("unavailable %s leaked: %v", key, raw)
				}
			}
		})
	}
}
