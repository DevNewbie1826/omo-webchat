package api

import (
	"encoding/json"
	"testing"
	"time"
)

func countFrames(t *testing.T, frames [][]byte, typ string) int {
	t.Helper()
	count := 0
	for _, raw := range frames {
		var env struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(raw, &env) == nil && env.Type == typ {
			count++
		}
	}
	return count
}

func lastFrameOfType(t *testing.T, frames [][]byte, typ string, out any) bool {
	t.Helper()
	found := false
	for _, raw := range frames {
		var env struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(raw, &env) == nil && env.Type == typ {
			_ = json.Unmarshal(raw, out)
			found = true
		}
	}
	return found
}

// A dedicated chat.compact on a fresh session drives the full backend surface:
// the RPC reaches the provider, compaction.started/compaction.done frames
// arrive exactly once, and the mock's failed compact surfaces its provider
// error correlated to the compact command.
func TestWebSocketChatCompactRoundTrip(t *testing.T) {
	harness := newProviderWSHarness(t, "omo", "", nil)
	t.Cleanup(harness.server.chats.CloseAll)
	harness.create(t)
	harness.frames.waitFor(t, "ready", 3*time.Second)

	writeFrame(t, harness.client, map[string]any{"type": "chat.compact", "sessionId": harness.chat.ID})
	harness.frames.waitFor(t, "compaction.started", 5*time.Second)
	harness.frames.waitFor(t, "compaction.done", 5*time.Second)
	gotErr := harness.frames.waitForErrorCode(t, "provider_error")
	if gotErr.Command != "compact" {
		t.Fatalf("error command = %q, want compact; frame: %+v", gotErr.Command, gotErr)
	}

	frames := harness.frames.snapshot()
	if got := countFrames(t, frames, "compaction.started"); got != 1 {
		t.Fatalf("compaction.started = %d, want 1; frames: %s", got, harness.frames.types())
	}
	if got := countFrames(t, frames, "compaction.done"); got != 1 {
		t.Fatalf("compaction.done = %d, want 1; frames: %s", got, harness.frames.types())
	}
	var done struct {
		Error string `json:"error"`
	}
	if !lastFrameOfType(t, frames, "compaction.done", &done) {
		t.Fatalf("no compaction.done frame; frames: %s", harness.frames.types())
	}
	if done.Error == "" {
		t.Fatalf("compaction.done carries no error for the mock failure; frames: %s", harness.frames.types())
	}
	if got := countFrames(t, frames, "run.done"); got != 0 {
		t.Fatalf("run.done = %d, want 0: compaction must not complete a run; frames: %s", got, harness.frames.types())
	}
}

// chat.compact after a completed run keeps the prior run's terminal state
// untouched: still exactly one run.done, and the compaction frames flow.
func TestWebSocketChatCompactAfterRunKeepsRunTerminal(t *testing.T) {
	harness := newProviderWSHarness(t, "omo", "", nil)
	t.Cleanup(harness.server.chats.CloseAll)
	harness.create(t)
	harness.frames.waitFor(t, "ready", 3*time.Second)

	writeFrame(t, harness.client, map[string]any{
		"type":      "chat.send",
		"sessionId": harness.chat.ID,
		"run":       map[string]any{"kind": "prompt", "message": "hello"},
	})
	harness.frames.waitFor(t, "run.done", 5*time.Second)

	writeFrame(t, harness.client, map[string]any{"type": "chat.compact", "sessionId": harness.chat.ID})
	harness.frames.waitFor(t, "compaction.done", 5*time.Second)
	gotErr := harness.frames.waitForErrorCode(t, "provider_error")
	if gotErr.Command != "compact" {
		t.Fatalf("error command = %q, want compact", gotErr.Command)
	}

	frames := harness.frames.snapshot()
	if got := countFrames(t, frames, "run.done"); got != 1 {
		t.Fatalf("run.done = %d, want 1 (the prompt run only); frames: %s", got, harness.frames.types())
	}
	if got := countFrames(t, frames, "compaction.started"); got != 1 {
		t.Fatalf("compaction.started = %d, want 1; frames: %s", got, harness.frames.types())
	}
}

// The live mock completes compact A's lifecycle, starts compact B, then emits
// A's delayed RPC response and duplicate provider end while B remains active.
// A third compact must still be rejected: stale A terminal input cannot release
// B's admission latch across the real WebSocket/provider path.
func TestWebSocketStaleCompactATerminalsCannotEndCompactB(t *testing.T) {
	harness := newProviderWSHarness(t, "omo", "", map[string]string{
		"MOCK_PI_COMPACT_STALE_A_SCENARIO": "1",
	})
	t.Cleanup(harness.server.chats.CloseAll)
	harness.create(t)
	harness.frames.waitFor(t, "ready", 3*time.Second)

	writeFrame(t, harness.client, map[string]any{"type": "chat.compact", "sessionId": harness.chat.ID})
	cursor := harness.frames.waitForAfter(t, "compaction.done", 0, 5*time.Second)

	writeFrame(t, harness.client, map[string]any{"type": "chat.compact", "sessionId": harness.chat.ID})
	cursor = harness.frames.waitForAfter(t, "compaction.started", cursor, 5*time.Second)
	harness.frames.waitForAfter(t, "error", cursor, 5*time.Second) // delayed A response

	writeFrame(t, harness.client, map[string]any{"type": "chat.compact", "sessionId": harness.chat.ID})
	gotErr := harness.frames.waitForErrorCode(t, "compact_failed")
	if gotErr.Command != "compact" {
		t.Fatalf("error command = %q, want compact; frame: %+v", gotErr.Command, gotErr)
	}
	frames := harness.frames.snapshot()
	if got := countFrames(t, frames, "compaction.started"); got != 2 {
		t.Fatalf("compaction.started = %d, want A and B; frames: %s", got, harness.frames.types())
	}
	if got := countFrames(t, frames, "compaction.done"); got != 1 {
		t.Fatalf("compaction.done = %d, want only A; stale A ended B; frames: %s", got, harness.frames.types())
	}
}

// chat.compact is refused while a run is active: the backend answers
// compact_failed without writing compact to the provider and without emitting
// compaction frames.
func TestWebSocketChatCompactRejectedWhileRunActive(t *testing.T) {
	rpcLog := t.TempDir() + "/rpc.log"
	harness := newProviderWSHarness(t, "omo", "", map[string]string{
		"MOCK_PI_CHUNK_MODE": "signal",
		"MOCK_PI_CHUNKS":     "2",
		"MOCK_PI_LOG":        rpcLog,
	})
	t.Cleanup(harness.server.chats.CloseAll)
	harness.create(t)
	harness.frames.waitFor(t, "ready", 3*time.Second)

	writeFrame(t, harness.client, map[string]any{
		"type":      "chat.send",
		"sessionId": harness.chat.ID,
		"run":       map[string]any{"kind": "prompt", "message": "hello there"},
	})
	harness.frames.waitFor(t, "messageDelta", 5*time.Second) // parked mid-run

	writeFrame(t, harness.client, map[string]any{"type": "chat.compact", "sessionId": harness.chat.ID})
	gotErr := harness.frames.waitForErrorCode(t, "compact_failed")
	if gotErr.Command != "compact" {
		t.Fatalf("error command = %q, want compact; frame: %+v", gotErr.Command, gotErr)
	}
	frames := harness.frames.snapshot()
	if got := countFrames(t, frames, "compaction.started"); got != 0 {
		t.Fatalf("compaction.started after rejection = %d, want 0; frames: %s", got, harness.frames.types())
	}
	if got := countFrames(t, frames, "compaction.done"); got != 0 {
		t.Fatalf("compaction.done after rejection = %d, want 0; frames: %s", got, harness.frames.types())
	}
	for _, command := range readLogLines(t, rpcLog) {
		if command == "compact" {
			t.Fatalf("rejected compact reached the provider; log: %v", readLogLines(t, rpcLog))
		}
	}
}
