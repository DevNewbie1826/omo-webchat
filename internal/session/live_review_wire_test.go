package session_test

import (
	"encoding/json"
	"testing"
)

func TestLiveRevisionOnRESTAndActivityWS_whenMainActivityFlips(t *testing.T) {
	// Given a subscribed attached session without task or DAG receipts.
	f := newEvictedCountsFixture(t)
	f.openChat()
	conn, frames := f.connect()
	writeEvictedCountsFrame(t, conn, map[string]any{"type": "sessions.subscribe", "mode": "explicit", "sessionIds": []string{f.chat.ID}})
	frames.next(t, "ack")
	var previous float64
	for _, event := range []string{"agent_start", "agent_settled", "agent_start"} {
		// When main activity starts, completes, then starts again.
		f.daemon.EmitSession(f.chat.SessionFile, map[string]any{"type": event})
		frame := frames.nextTaskCountFrame(t)
		// Then pushes and subsequent polls agree on strictly increasing revisions.
		for surface, got := range map[string]map[string]any{"WS": frame, "REST": f.liveRow(t)} {
			revision, ok := got["last_activity_ms"].(float64)
			if !ok || revision <= previous || revision != frame["last_activity_ms"] || got["active"] != (event == "agent_start") {
				t.Fatalf("%s stale main-activity revision after %s: %v", surface, event, got)
			}
		}
		previous = frame["last_activity_ms"].(float64)
	}
}

func TestLiveProgressClearOnRESTAndActivityWS_whenProgressDisappears(t *testing.T) {
	// Given an authenticated attached session and an activity subscription.
	f := newEvictedCountsFixture(t)
	f.openChat()
	conn, frames := f.connect()
	writeEvictedCountsFrame(t, conn, map[string]any{"type": "sessions.subscribe", "mode": "explicit", "sessionIds": []string{f.chat.ID}})
	frames.next(t, "ack")
	for _, stage := range []struct{ at, status, progress string }{
		{"2026-09-10T10:01:00Z", "pending", ""},
		{"2026-09-10T10:02:00Z", "running", "working"},
		{"2026-09-10T10:03:00Z", "completed", ""},
	} {
		row := map[string]any{"task_id": "t", "status": stage.status, "updated_at": stage.at}
		if stage.progress != "" {
			row["live_progress"] = map[string]any{"last_assistant_line": stage.progress}
		}
		// When each revision is delivered through the real daemon connection.
		f.daemon.EmitSession(f.chat.SessionFile, map[string]any{"type": "extension_event", "name": "omo.task.updated", "data": map[string]any{"parent_session_id": f.chat.DurableSessionID, "truncated_tasks": false, "tasks": []any{row}}})
		frame := frames.nextTaskCountFrame(t)
		// Then both live surfaces preserve absent/set/clear semantics.
		for surface, got := range map[string]map[string]any{"WS": frame, "REST": f.liveRow(t)} {
			line, exists := got["last_line"]
			switch stage.status {
			case "pending":
				if exists {
					t.Errorf("%s first row invented line: %v", surface, line)
				}
			case "running":
				if line != "working" {
					t.Errorf("%s progress=%v", surface, line)
				}
			case "completed":
				if !exists || line != "" {
					t.Errorf("%s missing explicit clear: %v", surface, got)
				}
			}
		}
	}
}

func TestLiveMalformedCountsOnRESTAndActivityWS_whenNestedCountsAreInvalid(t *testing.T) {
	// Given a subscribed authenticated session.
	f := newEvictedCountsFixture(t)
	f.openChat()
	conn, frames := f.connect()
	writeEvictedCountsFrame(t, conn, map[string]any{"type": "sessions.subscribe", "mode": "explicit", "sessionIds": []string{f.chat.ID}})
	frames.next(t, "ack")
	// When malformed display counts arrive alongside usable running work.
	f.daemon.EmitSession(f.chat.SessionFile, map[string]any{"type": "extension_event", "name": "omo.dag.updated", "data": map[string]any{"parent_session_id": f.chat.DurableSessionID, "truncated_runs": false, "runs": []any{map[string]any{"run_id": "r", "status": "running", "updated_at": "2026-09-10T10:02:00Z", "counts": json.RawMessage(`{"completed":1,"total":9007199254740992}`), "nodes": []any{map[string]any{"id": "n", "state": "running"}}}}}})
	frame := frames.nextTaskCountFrame(t)
	// Then neither surface emits frame-fatal scalars or hides uncertainty.
	for surface, got := range map[string]map[string]any{"WS": frame, "REST": f.liveRow(t)} {
		if got["truncated"].(map[string]any)["dag"] != true || got["dag_total"].(float64) > 9007199254740991 || got["running"].(map[string]any)["agents"] != float64(1) {
			t.Errorf("%s unsafe counts: %v", surface, got)
		}
	}
}
