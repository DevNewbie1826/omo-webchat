package session

import (
	"encoding/json"
	"testing"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

func TestDelayedUnboundOverviewCannotOverwriteRunningRemap(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	mgr := testManager(t, client, newMemStore(), 64)
	token, _ := client.CurrentEpoch()
	arrived := make(chan Summary, 4)
	unsubscribe := mgr.SubscribeOverview(func(snapshot Summary) { arrived <- snapshot })
	defer unsubscribe()

	const durableID = "durable-00000001-4f2a-9c31"
	// Pause the event loop at its post-ingestion hand-off. Acquisition and a
	// real provider start can run while that old hand-off is delayed.
	raw := json.RawMessage(`{"type":"extension_event","sessionId":"durable-00000001-4f2a-9c31","name":"omo.task.updated","data":{"tasks":[]}}`)
	_, delayed, subscribers := mgr.ingestEpochEvent(token, &omorpc.Event{
		Type: "extension_event", SessionID: durableID, Raw: raw,
	})
	sess, _, _ := acquire(t, mgr, testChat{id: "running-remap", cwd: t.TempDir()}, nil)
	sess.dispatchEpoch(token, &omorpc.Event{
		Type: "agent_start", SessionID: sess.routingID, Raw: json.RawMessage(`{"type":"agent_start"}`),
	})
	deliverOverview(subscribers, delayed)

	// The provisional snapshot must precede its replacement and the running
	// update, regardless of when the old event-loop hand-off resumes.
	first := awaitOverview(t, arrived)
	second := awaitOverview(t, arrived)
	last := awaitOverview(t, arrived)
	if first.ChatID != durableID || first.Active {
		t.Fatalf("first overview = %+v, want inactive provisional identity", first)
	}
	if second.ChatID != "running-remap" || second.ReplacesSessionID != durableID {
		t.Fatalf("replacement overview = %+v", second)
	}
	if last.ChatID != "running-remap" || !last.Active {
		t.Fatalf("latest overview = %+v, want active replacement", last)
	}
}
