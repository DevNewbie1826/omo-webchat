package api

import (
	"testing"
	"time"

	"github.com/lxzan/gws"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

// Exercise the real provider event -> session -> overview -> authenticated
// REST/WebSocket path with no child task or DAG snapshots at all.
type runningActivityFixture struct {
	*countsE2EFixture
	attached *gws.Conn
	frames   *activityE2ECollector
	overview *activityE2ECollector
}

func newRunningActivityFixture(t *testing.T) *runningActivityFixture {
	t.Helper()
	f := newCountsE2EFixture(t)
	attached, frames := f.connectUnsubscribed()
	t.Cleanup(func() { _ = attached.WriteClose(1000, nil) })
	writeActivityE2EFrame(t, attached, map[string]any{"type": "chat.create", "wsId": f.storeWorkspaceID(), "chatId": f.chat.ID})
	frames.next(t, "ready")
	// The serialized ping is the route-publication barrier after ready.
	writeActivityE2EFrame(t, attached, map[string]any{"type": "ping"})
	frames.next(t, "pong")
	chat, err := f.store.GetChat(f.chat.ID)
	if err != nil {
		t.Fatal(err)
	}
	f.chat = chat
	_, overview := f.connectSubscribe()
	return &runningActivityFixture{countsE2EFixture: f, attached: attached, frames: frames, overview: overview}
}

func (f *runningActivityFixture) assertRESTActive(want bool) {
	f.t.Helper()
	row := fetchLiveRows(f.t, f.serverURL, f.token)[0]
	if row["active"] != want {
		f.t.Fatalf("live REST active = %v, want %v: %v", row["active"], want, row)
	}
	if row["task"] != nil || row["dag"] != nil || row["task_digest"] != nil || row["dag_digest"] != nil {
		f.t.Fatalf("main run invented child activity: %v", row)
	}
}

func (f *runningActivityFixture) awaitActive(want bool) {
	f.t.Helper()
	frame := f.overview.next(f.t, "sessions.activity")
	if frame["active"] != want || frame["sessionId"] != f.chat.ID || frame["durableSessionId"] != f.chat.DurableSessionID {
		f.t.Fatalf("activity update = %v, want active=%v with stable identity", frame, want)
	}
	if snapshots, ok := frame["snapshots"].([]any); !ok || len(snapshots) != 0 || frame["taskDigest"] != nil || frame["dagDigest"] != nil {
		f.t.Fatalf("main run invented child activity: %v", frame)
	}
}

func (f *runningActivityFixture) emitBarrier(event map[string]any) {
	f.t.Helper()
	f.daemon.EmitSession(f.chat.SessionFile, event)
	f.daemon.EmitSession(f.chat.SessionFile, map[string]any{"type": "state_changed", "runningBarrier": event["type"]})
	for {
		frame := f.frames.next(f.t, "state")
		if frame["runningBarrier"] == event["type"] {
			return
		}
	}
}

func TestRunningActivityREST(t *testing.T) {
	f := newRunningActivityFixture(t)
	f.assertRESTActive(false)
	f.emitBarrier(map[string]any{"type": "agent_start"})
	f.assertRESTActive(true)
}

func TestRunningActivityLifecycle(t *testing.T) {
	f := newRunningActivityFixture(t)
	f.daemon.EmitSession(f.chat.SessionFile, map[string]any{"type": "agent_start"})
	f.awaitActive(true)
	f.assertRESTActive(true)

	// Neither agent_end nor exhausted overflow recovery settles a provider run.
	for _, event := range []map[string]any{
		{"type": "agent_end", "willRetry": true},
		{"type": "compaction_start", "reason": "overflow", "requestId": "auto-1"},
		{"type": "compaction_end", "reason": "overflow", "requestId": "auto-1", "willRetry": false, "errorMessage": "fixture exhaustion"},
		{"type": "agent_end", "willRetry": false},
	} {
		f.emitBarrier(event)
		f.assertRESTActive(true)
	}
	f.daemon.EmitSession(f.chat.SessionFile, map[string]any{"type": "agent_settled", "reason": "error"})
	f.awaitActive(false)
	f.assertRESTActive(false)

	// Automatic compaction alone is active work, even without a provider run.
	f.daemon.EmitSession(f.chat.SessionFile, map[string]any{"type": "compaction_start", "reason": "threshold", "requestId": "auto-2"})
	f.awaitActive(true)
	f.assertRESTActive(true)
	f.daemon.EmitSession(f.chat.SessionFile, map[string]any{"type": "compaction_done", "requestId": "auto-2"})
	f.awaitActive(false)
	f.assertRESTActive(false)
}

func TestRunningActivityCommandCompletion(t *testing.T) {
	for _, tc := range []struct {
		name, command, wire string
		fail, local         bool
	}{
		{name: "prompt-rejected", command: omorpc.CmdPrompt, wire: "chat.send", fail: true},
		{name: "local-command", command: omorpc.CmdPrompt, wire: "chat.send", local: true},
		{name: "manual-compaction", command: omorpc.CmdCompact, wire: "chat.compact"},
		{name: "manual-compaction-failed", command: omorpc.CmdCompact, wire: "chat.compact", fail: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newRunningActivityFixture(t)
			release := f.daemon.BlockHandler(tc.command)
			defer release()
			if tc.fail {
				f.daemon.FailNext(tc.command, "fixture_rejected")
			}
			frame := map[string]any{"type": tc.wire, "sessionId": f.chat.ID}
			if tc.wire == "chat.send" {
				frame["requestId"] = tc.name
				frame["run"] = map[string]any{"kind": "prompt", "message": "fixture command"}
			}
			writeActivityE2EFrame(t, f.attached, frame)
			// Admission itself must light up before any provider lifecycle event.
			f.awaitActive(true)
			f.assertRESTActive(true)
			if tc.local {
				f.emitBarrier(map[string]any{"type": "command_invocation", "command": map[string]any{"source": "extension"}})
			}
			release()
			f.awaitActive(false)
			f.assertRESTActive(false)
		})
	}
}

func TestRunningActivityRetirement(t *testing.T) {
	for _, terminal := range []string{"agent_settled", "session_unloaded", "session_closed", "disconnect", "chat.disconnect"} {
		t.Run(terminal, func(t *testing.T) {
			f := newRunningActivityFixture(t)
			f.daemon.EmitSession(f.chat.SessionFile, map[string]any{"type": "agent_start"})
			f.awaitActive(true)
			switch terminal {
			case "disconnect":
				f.daemon.DropConnections()
			case "chat.disconnect":
				writeActivityE2EFrame(t, f.attached, map[string]any{"type": terminal, "sessionId": f.chat.ID})
			default:
				if terminal == "agent_settled" {
					writeActivityE2EFrame(t, f.attached, map[string]any{"type": "chat.abort", "sessionId": f.chat.ID})
					if !f.daemon.AwaitRequestCount(omorpc.CmdAbort, 1, 5*time.Second) {
						t.Fatal("abort did not reach provider")
					}
					f.assertRESTActive(true)
				}
				f.daemon.EmitSession(f.chat.SessionFile, map[string]any{"type": terminal, "reason": "aborted"})
			}
			f.awaitActive(false)
			if terminal == "agent_settled" {
				f.assertRESTActive(false)
			}
		})
	}
}
