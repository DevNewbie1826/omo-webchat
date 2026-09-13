package api

import "testing"

func TestLiveLeanPayload_whenProviderActivityIsMalformed(t *testing.T) {
	// Given a real attached chat and its live subscription.
	fixture := newCountsE2EFixture(t)
	fixture.attachChat()
	_, frames := fixture.connectSubscribe()
	// When the provider sends opaque activity instead of a usable roster.
	fixture.daemon.EmitSession(fixture.chat.SessionFile, map[string]any{
		"type": "extension_event", "name": "omo.task.updated", "data": map[string]any{"tasks": "invalid"},
	})
	frame := frames.next(t, "sessions.activity")
	rows := fetchLiveRows(t, fixture.serverURL, fixture.token)
	// Then neither real wire presents unknown task membership as exact zero.
	for name, row := range map[string]map[string]any{"REST": rows[0], "WS": frame} {
		t.Run(name, func(t *testing.T) {
			if row["truncated"].(map[string]any)["task"] != true {
				t.Errorf("unknown roster appears exact: %v", row)
			}
			for _, key := range []string{"task", "task_digest", "taskDigest", "snapshots"} {
				if _, exists := row[key]; exists {
					t.Errorf("opaque payload leaked: %s", key)
				}
			}
		})
	}
}
