package chat

import (
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"
)

type blockingFrameWriter struct {
	once    sync.Once
	entered chan struct{}
	release chan struct{}
}

func (w *blockingFrameWriter) WriteJSON([]byte) error {
	w.once.Do(func() { close(w.entered) })
	<-w.release
	return nil
}

func assertLifecycleHeldDuringFrame(t *testing.T, s *Session, publish func()) {
	t.Helper()
	blocker := &blockingFrameWriter{entered: make(chan struct{}), release: make(chan struct{})}
	detach := s.Attach(blocker)
	defer detach()

	done := make(chan struct{})
	go func() {
		publish()
		close(done)
	}()
	select {
	case <-blocker.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("terminal frame was not published")
	}
	if s.lifecycleMu.TryLock() {
		s.lifecycleMu.Unlock()
		close(blocker.release)
		<-done
		t.Fatal("terminal frame was published without holding lifecycleMu")
	}
	close(blocker.release)
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("terminal publication did not finish after writer release")
	}
}

// Generic omo run-lifecycle contract, captured live from omo 5.0.0-beta.11
// (.omo/evidence/omp-removal-20260819/omo-contract/REPORT.md):
//
//   - agent_start authoritatively opens a provider run. The successful prompt
//     response is only preflight acceptance, never a run start.
//   - agent_end is never terminal: even willRetry:false can be followed by
//     compaction or a queued continuation. agent_settled completes the run.
//     Automatic compaction reasons are threshold or overflow.
//   - An extension-local command (command_invocation{source:"extension"}) is
//     consumed without an agent run; its correlated prompt response completes
//     the request. prompt/skill invocations dispatch into the agent and stay
//     armed until agent_settled.
//   - A provider-initiated run (wake/triggerTurn) has no RPC response; its
//     agent_start arms a run (run.started), prompts are rejected until it
//     settles, and a follow-on agent_settled->agent_start pair opens a fresh
//     run with no invented prompt response.

func dispatchEvent(s *Session, typ, raw string) {
	s.dispatch(Event{Type: typ, Raw: json.RawMessage(raw)})
}

func armUserPrompt(s *Session) {
	s.mu.Lock()
	s.promptInFlight = true
	s.runDone = false
	s.mu.Unlock()
}

// A normal prompt: acceptance response -> agent_start -> stream ->
// agent_end{willRetry:false} -> agent_settled. Only agent_settled completes;
// the user-initiated run emits no run.started (the prompt already armed it).
func TestOmoNormalPromptCompletesOnlyOnAgentSettled(t *testing.T) {
	writer := newCollectWriter()
	s := newTestSession("chat-omo-prompt", writer)
	armUserPrompt(s)

	// Preflight acceptance is not a run start.
	dispatchEvent(s, "response", `{"id":"prompt-1","type":"response","command":"prompt","success":true}`)
	if got := countFramesOfType(writer.snapshot(), "run.done"); got != 0 {
		t.Fatalf("run.done after prompt acceptance = %d, want 0; frames: %s", got, writer.typesString())
	}

	dispatchEvent(s, "agent_start", `{"type":"agent_start"}`)
	if got := countFramesOfType(writer.snapshot(), "run.started"); got != 0 {
		t.Fatalf("run.started for user-initiated run = %d, want 0; frames: %s", got, writer.typesString())
	}

	// agent_end stays non-terminal even with willRetry:false.
	dispatchEvent(s, "agent_end", `{"type":"agent_end","messages":[],"willRetry":false}`)
	if got := countFramesOfType(writer.snapshot(), "run.done"); got != 0 {
		t.Fatalf("run.done after agent_end = %d, want 0; frames: %s", got, writer.typesString())
	}
	if s.IsFinished() {
		t.Fatal("session finished before agent_settled")
	}

	dispatchEvent(s, "agent_settled", `{"type":"agent_settled"}`)
	dispatchEvent(s, "agent_settled", `{"type":"agent_settled"}`) // duplicate must not double-complete
	if got := countFramesOfType(writer.snapshot(), "run.done"); got != 1 {
		t.Fatalf("run.done count = %d, want 1; frames: %s", got, writer.typesString())
	}
	if !s.IsFinished() {
		t.Fatal("session not finished after agent_settled")
	}
}

// A provider-initiated wake run: no prompt was sent, so agent_start arms the
// run and emits run.started; agent_settled completes it with the run's stop
// reason.
func TestOmoWakeRunEmitsRunStartedThenRunDone(t *testing.T) {
	writer := newCollectWriter()
	s := newTestSession("chat-omo-wake", writer)

	dispatchEvent(s, "agent_start", `{"type":"agent_start"}`)
	if got := countFramesOfType(writer.snapshot(), "run.started"); got != 1 {
		t.Fatalf("run.started after wake agent_start = %d, want 1; frames: %s", got, writer.typesString())
	}
	if s.IsFinished() {
		t.Fatal("session finished while wake run active")
	}

	dispatchEvent(s, "message_end", `{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"ok"}],"stopReason":"stop"}}`)
	dispatchEvent(s, "agent_end", `{"type":"agent_end","messages":[],"willRetry":false}`)
	if got := countFramesOfType(writer.snapshot(), "run.done"); got != 0 {
		t.Fatalf("run.done after wake agent_end = %d, want 0; frames: %s", got, writer.typesString())
	}

	dispatchEvent(s, "agent_settled", `{"type":"agent_settled"}`)
	frames := writer.snapshot()
	if got := countFramesOfType(frames, "run.done"); got != 1 {
		t.Fatalf("run.done count = %d, want 1; frames: %s", got, writer.typesString())
	}
	if got := countFramesOfType(frames, "run.started"); got != 1 {
		t.Fatalf("run.started count = %d, want 1; frames: %s", got, writer.typesString())
	}
	var done RunDoneFrame
	for _, f := range frames {
		_ = json.Unmarshal(f, &done)
	}
	if done.Reason != "stop" {
		t.Fatalf("run.done reason = %q, want the run's stop reason", done.Reason)
	}
	if !s.IsFinished() {
		t.Fatal("session not finished after wake run settled")
	}
}

// Duplicate agent_start events arm exactly one run.
func TestOmoDuplicateAgentStartArmsOneRun(t *testing.T) {
	writer := newCollectWriter()
	s := newTestSession("chat-omo-dup-start", writer)

	dispatchEvent(s, "agent_start", `{"type":"agent_start"}`)
	dispatchEvent(s, "agent_start", `{"type":"agent_start"}`)
	if got := countFramesOfType(writer.snapshot(), "run.started"); got != 1 {
		t.Fatalf("run.started after duplicate agent_start = %d, want 1; frames: %s", got, writer.typesString())
	}

	dispatchEvent(s, "agent_end", `{"type":"agent_end","messages":[],"willRetry":true}`)
	dispatchEvent(s, "agent_settled", `{"type":"agent_settled"}`)
	dispatchEvent(s, "agent_settled", `{"type":"agent_settled"}`)
	if got := countFramesOfType(writer.snapshot(), "run.done"); got != 1 {
		t.Fatalf("run.done count = %d, want 1; frames: %s", got, writer.typesString())
	}
}

// A stale agent_settled with no armed run completes nothing; a later
// agent_start still opens a fresh run.
func TestOmoStaleSettledWithoutArmedRunIsIgnored(t *testing.T) {
	writer := newCollectWriter()
	s := newTestSession("chat-omo-stale", writer)

	dispatchEvent(s, "agent_settled", `{"type":"agent_settled"}`)
	dispatchEvent(s, "agent_end", `{"type":"agent_end","messages":[],"willRetry":false}`)
	if got := countFramesOfType(writer.snapshot(), "run.done"); got != 0 {
		t.Fatalf("run.done after stale events = %d, want 0; frames: %s", got, writer.typesString())
	}

	dispatchEvent(s, "agent_start", `{"type":"agent_start"}`)
	dispatchEvent(s, "agent_settled", `{"type":"agent_settled"}`)
	frames := writer.snapshot()
	if got := countFramesOfType(frames, "run.started"); got != 1 {
		t.Fatalf("run.started count = %d, want 1; frames: %s", got, writer.typesString())
	}
	if got := countFramesOfType(frames, "run.done"); got != 1 {
		t.Fatalf("run.done count = %d, want 1; frames: %s", got, writer.typesString())
	}
}

// An extension-local command is consumed without an agent run: the correlated
// prompt response completes it, and a stale agent lifecycle afterwards must
// not double-complete.
func TestOmoLocalExtensionCommandCompletesOnPromptResponse(t *testing.T) {
	writer := newCollectWriter()
	s := newTestSession("chat-omo-local", writer)
	armUserPrompt(s)

	dispatchEvent(s, "command_invocation", `{"type":"command_invocation","command":{"name":"help","source":"extension","sourceInfo":{"path":"<builtin:help>","source":"builtin","scope":"temporary","origin":"top-level"},"syntax":"slash"}}`)
	dispatchEvent(s, "extension_ui_request", `{"type":"extension_ui_request","id":"ui-1","method":"notify","message":"Interactive /help is available in TUI mode","notifyType":"info"}`)
	if got := countFramesOfType(writer.snapshot(), "run.done"); got != 0 {
		t.Fatalf("run.done before prompt response = %d, want 0; frames: %s", got, writer.typesString())
	}

	dispatchEvent(s, "response", `{"id":"help-1","type":"response","command":"prompt","success":true}`)
	frames := writer.snapshot()
	if got := countFramesOfType(frames, "run.done"); got != 1 {
		t.Fatalf("run.done after local command response = %d, want 1; frames: %s", got, writer.typesString())
	}
	if got := countFramesOfType(frames, "run.started"); got != 0 {
		t.Fatalf("run.started for local command = %d, want 0; frames: %s", got, writer.typesString())
	}
	if !s.IsFinished() {
		t.Fatal("session not finished after local command completed")
	}

	// Stale agent events must not complete a second run.
	dispatchEvent(s, "agent_end", `{"type":"agent_end","messages":[],"willRetry":false}`)
	dispatchEvent(s, "agent_settled", `{"type":"agent_settled"}`)
	if got := countFramesOfType(writer.snapshot(), "run.done"); got != 1 {
		t.Fatalf("run.done after stale agent events = %d, want 1; frames: %s", got, writer.typesString())
	}
}

// prompt/skill command invocations dispatch into the agent: the prompt
// response is only acceptance, and the run stays armed until agent_settled.
func TestOmoPromptAndSkillInvocationsStayArmedUntilSettled(t *testing.T) {
	for _, source := range []string{"prompt", "skill"} {
		t.Run(source, func(t *testing.T) {
			writer := newCollectWriter()
			s := newTestSession("chat-omo-"+source, writer)
			armUserPrompt(s)

			dispatchEvent(s, "command_invocation", `{"type":"command_invocation","command":{"name":"`+source+`:demo","source":"`+source+`","syntax":"slash"}}`)
			dispatchEvent(s, "response", `{"id":"cmd-1","type":"response","command":"prompt","success":true}`)
			if got := countFramesOfType(writer.snapshot(), "run.done"); got != 0 {
				t.Fatalf("run.done after %s acceptance = %d, want 0: the agent run is still armed; frames: %s", source, got, writer.typesString())
			}

			dispatchEvent(s, "agent_start", `{"type":"agent_start"}`)
			if got := countFramesOfType(writer.snapshot(), "run.started"); got != 0 {
				t.Fatalf("run.started for user-initiated %s run = %d, want 0; frames: %s", source, got, writer.typesString())
			}
			dispatchEvent(s, "agent_end", `{"type":"agent_end","messages":[],"willRetry":false}`)
			if got := countFramesOfType(writer.snapshot(), "run.done"); got != 0 {
				t.Fatalf("run.done after %s agent_end = %d, want 0; frames: %s", source, got, writer.typesString())
			}
			dispatchEvent(s, "agent_settled", `{"type":"agent_settled"}`)
			if got := countFramesOfType(writer.snapshot(), "run.done"); got != 1 {
				t.Fatalf("run.done after %s agent_settled = %d, want 1; frames: %s", source, got, writer.typesString())
			}
		})
	}
}

// triggerTurn continuation: the first agent_settled completes the first run
// and the immediately following agent_start opens a fresh run with no prompt
// response in between. Exact counts: one run.started, two run.done.
func TestOmoFollowOnAgentStartAfterSettledOpensNewRun(t *testing.T) {
	writer := newCollectWriter()
	s := newTestSession("chat-omo-followon", writer)
	armUserPrompt(s)

	dispatchEvent(s, "response", `{"id":"prompt-1","type":"response","command":"prompt","success":true}`)
	dispatchEvent(s, "agent_start", `{"type":"agent_start"}`)
	dispatchEvent(s, "agent_end", `{"type":"agent_end","messages":[],"willRetry":false}`)
	dispatchEvent(s, "agent_settled", `{"type":"agent_settled"}`)
	if got := countFramesOfType(writer.snapshot(), "run.done"); got != 1 {
		t.Fatalf("run.done after first run = %d, want 1; frames: %s", got, writer.typesString())
	}

	// Deferred triggerTurn continuation: new agent_start, no RPC response.
	dispatchEvent(s, "agent_start", `{"type":"agent_start"}`)
	if got := countFramesOfType(writer.snapshot(), "run.started"); got != 1 {
		t.Fatalf("run.started after follow-on agent_start = %d, want 1; frames: %s", got, writer.typesString())
	}
	if s.IsFinished() {
		t.Fatal("session finished while follow-on run active")
	}
	dispatchEvent(s, "message_end", `{"type":"message_end","message":{"role":"custom","customType":"contract-probe-continuation","content":"nudge"}}`)
	dispatchEvent(s, "agent_end", `{"type":"agent_end","messages":[],"willRetry":false}`)
	dispatchEvent(s, "agent_settled", `{"type":"agent_settled"}`)

	frames := writer.snapshot()
	if got := countFramesOfType(frames, "run.started"); got != 1 {
		t.Fatalf("run.started total = %d, want 1; frames: %s", got, writer.typesString())
	}
	if got := countFramesOfType(frames, "run.done"); got != 2 {
		t.Fatalf("run.done total = %d, want 2; frames: %s", got, writer.typesString())
	}
	if !s.IsFinished() {
		t.Fatal("session not finished after follow-on run settled")
	}
}

// IsFinished/IdleFinished track the provider-run latch: an armed run keeps the
// session unfinished even after a prior run completed, and settling finishes
// it again.
func TestOmoFinishedStateTracksProviderRun(t *testing.T) {
	s := newTestSession("chat-omo-finished", nil)

	dispatchEvent(s, "agent_start", `{"type":"agent_start"}`)
	if s.IsFinished() {
		t.Fatal("IsFinished true while provider run active")
	}
	if s.IdleFinished(0, time.Now()) {
		t.Fatal("IdleFinished true while provider run active")
	}

	dispatchEvent(s, "agent_settled", `{"type":"agent_settled"}`)
	if !s.IsFinished() {
		t.Fatal("IsFinished false after run settled")
	}
	if !s.IdleFinished(0, time.Now()) {
		t.Fatal("IdleFinished false after idle elapsed with no attachments")
	}

	// A follow-on provider run must un-finish the session until it settles.
	dispatchEvent(s, "agent_start", `{"type":"agent_start"}`)
	if s.IsFinished() {
		t.Fatal("IsFinished true after follow-on agent_start")
	}
	if s.IdleFinished(0, time.Now()) {
		t.Fatal("IdleFinished true after follow-on agent_start")
	}
	dispatchEvent(s, "agent_settled", `{"type":"agent_settled"}`)
	if !s.IsFinished() || !s.IdleFinished(0, time.Now()) {
		t.Fatal("session not finished again after follow-on run settled")
	}
}

// End to end against the mock: a provider wake run (no prompt sent) emits
// run.started, prompts are rejected while it is active, and after it settles
// prompts are accepted again. Exact totals: one run.started (the wake run),
// two run.done.
func TestOmoRejectsPromptDuringProviderWakeRun(t *testing.T) {
	s, w := startMockSession(t, "chat-omo-wake-e2e",
		"MOCK_PI_WAKE_TURN=1",
		"MOCK_PI_CHUNK_MODE=signal", // the mock parks mid-run until mock_chunk_next
		"MOCK_PI_CHUNKS=2",
	)
	t.Cleanup(func() {
		if err := s.Close(); err != nil {
			t.Errorf("close session: %v", err)
		}
	})

	if err := s.proc.Send(map[string]any{"type": "mock_wake_turn"}); err != nil {
		t.Fatalf("trigger wake turn: %v", err)
	}
	w.waitForType(t, "run.started", 5*time.Second)

	// The provider run is active: a prompt must be refused without touching
	// the provider.
	if err := s.SendPrompt("during wake", nil); !errors.Is(err, ErrPromptInFlight) {
		t.Fatalf("SendPrompt during provider run = %v, want ErrPromptInFlight", err)
	}

	if err := s.proc.Send(map[string]any{"type": "mock_chunk_next"}); err != nil {
		t.Fatalf("release wake turn: %v", err)
	}
	w.waitForType(t, "run.done", 5*time.Second)
	if !s.IsFinished() {
		t.Fatal("session not finished after wake run settled")
	}

	// After settling, a normal prompt is accepted and completes on settled.
	// The second turn parks between chunks in signal mode too, so release it
	// immediately: the mock parks in the same tick that streams its first
	// chunk, before it can read any later stdin line.
	if err := s.SendPrompt("after wake", nil); err != nil {
		t.Fatalf("SendPrompt after wake run: %v", err)
	}
	if err := s.proc.Send(map[string]any{"type": "mock_chunk_next"}); err != nil {
		t.Fatalf("release second turn: %v", err)
	}
	finalFrames := w.waitFor(t, 5*time.Second, "second run.done", func(frames [][]byte) bool {
		return countFramesOfType(frames, "run.done") >= 2
	})

	if got := countFramesOfType(finalFrames, "run.started"); got != 1 {
		t.Fatalf("run.started total = %d, want 1 (wake run only); frames: %s", got, w.typesString())
	}
	if got := countFramesOfType(finalFrames, "run.done"); got != 2 {
		t.Fatalf("run.done total = %d, want 2; frames: %s", got, w.typesString())
	}
}

// End to end against the mock: an extension-local command (MOCK_PI_LOCAL_PROMPT)
// completes on its prompt response with no agent lifecycle — no run.started,
// no streamed messages — and clears the prompt gate for the next command.
func TestOmoLocalExtensionCommandRoundTrip(t *testing.T) {
	s, w := startMockSession(t, "chat-omo-local-e2e", "MOCK_PI_LOCAL_PROMPT=1")
	t.Cleanup(func() {
		if err := s.Close(); err != nil {
			t.Errorf("close session: %v", err)
		}
	})

	if err := s.SendPrompt("/help", nil); err != nil {
		t.Fatalf("send local command: %v", err)
	}
	w.waitForType(t, "run.done", 5*time.Second)

	frames := w.snapshot()
	if got := countFramesOfType(frames, "run.done"); got != 1 {
		t.Fatalf("run.done count = %d, want 1; frames: %s", got, w.typesString())
	}
	if got := countFramesOfType(frames, "run.started"); got != 0 {
		t.Fatalf("run.started count = %d, want 0; frames: %s", got, w.typesString())
	}
	if got := countFramesOfType(frames, "message"); got != 0 {
		t.Fatalf("message frames for local command = %d, want 0; frames: %s", got, w.typesString())
	}
	if got := countFramesOfType(frames, "messageDelta"); got != 0 {
		t.Fatalf("messageDelta frames for local command = %d, want 0; frames: %s", got, w.typesString())
	}
	if !s.IsFinished() {
		t.Fatal("session not finished after local command")
	}

	// The gate is cleared: the next local command runs and completes again.
	if err := s.SendPrompt("/status", nil); err != nil {
		t.Fatalf("send follow-up local command: %v", err)
	}
	finalFrames := w.waitFor(t, 5*time.Second, "second run.done", func(frames [][]byte) bool {
		return countFramesOfType(frames, "run.done") >= 2
	})
	if got := countFramesOfType(finalFrames, "run.done"); got != 2 {
		t.Fatalf("run.done total = %d, want 2; frames: %s", got, w.typesString())
	}
}

func TestOmoTerminalPublicationHoldsLifecycleLock(t *testing.T) {
	tests := []struct {
		name    string
		prepare func(*Session)
		finish  func(*Session)
	}{
		{
			name: "agent settled run.done",
			prepare: func(s *Session) {
				armUserPrompt(s)
			},
			finish: func(s *Session) { s.completeRun() },
		},
		{
			name: "local command run.done",
			prepare: func(s *Session) {
				armUserPrompt(s)
				s.mu.Lock()
				s.localCommandActive = true
				s.mu.Unlock()
			},
			finish: func(s *Session) { s.completeLocalCommand() },
		},
		{
			name: "failed prompt error",
			prepare: func(s *Session) {
				armUserPrompt(s)
			},
			finish: func(s *Session) {
				s.forwardResponse([]byte(`{"id":"prompt-1","type":"response","command":"prompt","success":false,"error":"rejected"}`))
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			s := newTestSession("chat-omo-terminal", nil)
			test.prepare(s)
			assertLifecycleHeldDuringFrame(t, s, func() { test.finish(s) })
			if !s.IsFinished() {
				t.Fatal("session not finished after terminal publication")
			}
		})
	}
}

func TestOmoProviderStartWaitsForLifecycleLock(t *testing.T) {
	writer := newCollectWriter()
	s := newTestSession("chat-omo-reaper-race", writer)
	blocker := &blockingFrameWriter{entered: make(chan struct{}), release: make(chan struct{})}
	detach := s.Attach(blocker)
	defer detach()

	done := make(chan struct{})
	go func() {
		s.beginProviderRun()
		close(done)
	}()
	<-blocker.entered

	if s.lifecycleMu.TryLock() {
		s.lifecycleMu.Unlock()
		t.Fatal("beginProviderRun emitted run.started without holding lifecycleMu")
	}

	close(blocker.release)
	<-done

	if !s.providerRunActive {
		t.Fatal("provider run was not armed")
	}
	if got := countFramesOfType(writer.snapshot(), "run.started"); got != 1 {
		t.Fatalf("run.started = %d, want 1", got)
	}
	if s.IdleFinished(0, time.Now()) {
		t.Fatal("provider-active session reported idle-finished")
	}
}

func TestOmoRejectedPromptRecordsFinishedAt(t *testing.T) {
	s := newTestSession("chat-omo-rejected-prompt", nil)
	s.promptInFlight = true
	s.runDone = false

	s.forwardResponse([]byte(`{"type":"response","command":"prompt","success":false,"error":"rejected"}`))

	if s.finishedAt.IsZero() {
		t.Fatal("failed prompt did not record finishedAt")
	}
	if !s.IdleFinished(0, time.Now()) {
		t.Fatal("failed prompt did not become idle-finished")
	}
}
