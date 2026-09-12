package wsbridge

import (
	"encoding/json"
	"testing"

	"github.com/DevNewbie1826/omo-webchat/internal/session"
)

func TestActivityRunCountsUnavailableOnSocket(t *testing.T) {
	source := newTestActivitySource()
	conn, frames, _ := connectActivityBridge(t, source)
	writeClient(t, conn, map[string]any{"type": "sessions.subscribe", "mode": "all_live"})
	awaitSignal(t, source.subscribed, "activity subscription")
	frames.next(t, "ack")
	summary := activitySummary("counts")
	if err := json.Unmarshal([]byte(`{"runs":[],"truncated":false,"running_count":0,"agent_running_count":0,"agent_total_count":0,"run_counts_unavailable":true}`), &summary.DagDigest); err != nil {
		t.Fatal(err)
	}
	summary.ActivityPair.Dag = json.RawMessage(`{"runs":[],"run_counts_unavailable":true}`)
	source.publish(summary)
	raw := frames.next(t, "sessions.activity")
	digest := raw["dagDigest"].(map[string]any)
	if digest["run_counts_unavailable"] != true {
		t.Fatalf("missing withdrawal on socket: %v", raw)
	}
	for _, key := range []string{"run_running_count", "run_total_count"} {
		if _, exists := digest[key]; exists {
			t.Fatalf("withdrawal carried %s: %v", key, raw)
		}
	}
	// Legacy digests keep the new boolean optional on the wire.
	summary.DagDigest = &session.DagDigest{}
	source.publish(summary)
	raw = frames.next(t, "sessions.activity")
	digest = raw["dagDigest"].(map[string]any)
	if _, exists := digest["run_counts_unavailable"]; exists {
		t.Fatalf("legacy digest gained availability field: %v", raw)
	}
}
