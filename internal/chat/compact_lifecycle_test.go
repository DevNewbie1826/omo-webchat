package chat

import (
	"context"
	"encoding/json"
	"errors"
	"os/exec"
	"testing"
	"time"
)

// startIdleProviderSession launches a provider that reads stdin forever and
// never answers: a compact sent to it latches forever, so in-flight gates are
// observable without racing the provider's reply.
func startIdleProviderSession(t *testing.T, id string, writer *collectWriter) *Session {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skipf("node not in PATH: %v", err)
	}
	s, err := StartSession(context.Background(), SessionOptions{
		ID:     id,
		Binary: node,
		Args:   []string{"-e", `process.stdin.resume()`},
	})
	if err != nil {
		t.Fatalf("start idle provider: %v", err)
	}
	if writer != nil {
		s.Attach(writer)
	}
	return s
}

type commandCaptureWriter struct {
	commands chan map[string]any
}

func newCommandCaptureWriter() *commandCaptureWriter {
	return &commandCaptureWriter{commands: make(chan map[string]any, 4)}
}

func (w *commandCaptureWriter) Write(p []byte) (int, error) {
	var command map[string]any
	if err := json.Unmarshal(p, &command); err != nil {
		return 0, err
	}
	w.commands <- command
	return len(p), nil
}

func (*commandCaptureWriter) Close() error { return nil }

func newCapturedCommandSession(id string, frames *collectWriter) (*Session, *commandCaptureWriter) {
	commands := newCommandCaptureWriter()
	s := newTestSession(id, frames)
	s.proc = &Process{stdin: commands}
	return s, commands
}

func startCapturedCompact(t *testing.T, s *Session, commands *commandCaptureWriter) string {
	t.Helper()
	if err := s.Compact(); err != nil {
		t.Fatalf("compact: %v", err)
	}
	command := <-commands.commands
	if command["type"] != "compact" {
		t.Fatalf("provider command type = %v, want compact", command["type"])
	}
	id, _ := command["id"].(string)
	if id == "" {
		t.Fatal("compact provider command has no RPC id")
	}
	return id
}

func framesWithField(frames [][]byte, typ, field, value string) [][]byte {
	var out [][]byte
	for _, f := range frames {
		var env struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(f, &env) != nil || env.Type != typ {
			continue
		}
		var probe map[string]any
		if json.Unmarshal(f, &probe) == nil && probe[field] == value {
			out = append(out, f)
		}
	}
	return out
}

// Dedicated compaction on a session that has finished a run: Compact marks the
// session busy before the provider write, the compaction_start/compaction_end
// events map to compaction.started/compaction.done exactly once each, the
// failed compact response surfaces the provider error without a second
// compaction.done, and the finished state is restored afterwards.
func TestCompactStandaloneLifecycleAgainstMock(t *testing.T) {
	s, w := startMockSession(t, "chat-compact-e2e")
	t.Cleanup(func() {
		if err := s.Close(); err != nil {
			t.Errorf("close session: %v", err)
		}
	})

	if err := s.SendPrompt("hello", nil); err != nil {
		t.Fatalf("send prompt: %v", err)
	}
	w.waitForType(t, "run.done", 5*time.Second)
	if !s.IsFinished() {
		t.Fatal("session not finished after run")
	}

	if err := s.Compact(); err != nil {
		t.Fatalf("compact: %v", err)
	}
	if s.IsFinished() {
		t.Fatal("session finished while standalone compaction active")
	}

	afterDone := w.waitForType(t, "compaction.done", 5*time.Second)
	if got := countFramesOfType(afterDone, "compaction.started"); got != 1 {
		t.Fatalf("compaction.started = %d, want 1; frames: %s", got, w.typesString())
	}
	dones := countFramesOfType(afterDone, "compaction.done")
	if dones != 1 {
		t.Fatalf("compaction.done = %d, want 1; frames: %s", dones, w.typesString())
	}
	var doneFrame CompactionDoneFrame
	for _, f := range afterDone {
		_ = json.Unmarshal(f, &doneFrame)
	}
	if doneFrame.Error != "Nothing to compact (mock session)" {
		t.Fatalf("compaction.done error = %q, want the provider errorMessage", doneFrame.Error)
	}

	// The failed compact response must not re-emit compaction.done.
	errorFrames := w.waitFor(t, 5*time.Second, "provider compact error", func(frames [][]byte) bool {
		return len(framesWithField(frames, "error", "command", "compact")) > 0
	})
	if got := countFramesOfType(errorFrames, "compaction.done"); got != 1 {
		t.Fatalf("compaction.done after failed response = %d, want 1; frames: %s", got, w.typesString())
	}
	s.mu.Lock()
	active := s.compactionActive
	s.mu.Unlock()
	if active {
		t.Fatal("compaction latch still set after compact response")
	}
	if !s.IsFinished() {
		t.Fatal("compaction wedged the finished state")
	}
}

// Compact is refused while a prompt/provider run is in flight, without
// writing compact to the provider; once the run settles, compact is accepted.
func TestCompactRejectsWhileRunActive(t *testing.T) {
	logFile := t.TempDir() + "/rpc.log"
	s, w := startMockSession(t, "chat-compact-gated",
		"MOCK_PI_CHUNK_MODE=signal", "MOCK_PI_CHUNKS=2", "MOCK_PI_LOG="+logFile)
	t.Cleanup(func() {
		if err := s.Close(); err != nil {
			t.Errorf("close session: %v", err)
		}
	})

	if err := s.SendPrompt("hello there", nil); err != nil {
		t.Fatalf("send prompt: %v", err)
	}
	w.waitForType(t, "messageDelta", 5*time.Second) // parked mid-run after chunk 1

	if err := s.Compact(); !errors.Is(err, ErrPromptInFlight) {
		t.Fatalf("compact during active run = %v, want ErrPromptInFlight", err)
	}
	if got := countFramesOfType(w.snapshot(), "compaction.started"); got != 0 {
		t.Fatalf("compaction.started after rejected compact = %d, want 0", got)
	}
	for _, command := range readRPCLogLines(t, logFile) {
		if command == "compact" {
			t.Fatalf("rejected compact was written to the provider; log: %v", readRPCLogLines(t, logFile))
		}
	}

	if err := s.proc.Send(map[string]any{"type": "mock_chunk_next"}); err != nil {
		t.Fatalf("release run: %v", err)
	}
	w.waitForType(t, "run.done", 5*time.Second)
	if err := s.Compact(); err != nil {
		t.Fatalf("compact after run settled: %v", err)
	}
	final := w.waitForType(t, "compaction.done", 5*time.Second)
	if got := countFramesOfType(final, "compaction.started"); got != 1 {
		t.Fatalf("compaction.started after settled compact = %d, want 1", got)
	}
}

// While a compact is in flight (provider never answers), a second compact and
// a prompt are both refused; compaction_end releases the latch and restores
// the idle-finished state.
func TestCompactRepeatAndPromptGateWhileInFlight(t *testing.T) {
	writer := newCollectWriter()
	s := startIdleProviderSession(t, "chat-compact-repeat", writer)
	t.Cleanup(func() {
		if err := s.Close(); err != nil {
			t.Errorf("close session: %v", err)
		}
	})

	armUserPrompt(s)
	dispatchEvent(s, "agent_settled", `{"type":"agent_settled"}`)
	if !s.IsFinished() {
		t.Fatal("session not finished before compact")
	}

	if err := s.Compact(); err != nil {
		t.Fatalf("first compact: %v", err)
	}
	if err := s.Compact(); !errors.Is(err, ErrCompactionInFlight) {
		t.Fatalf("second compact = %v, want ErrCompactionInFlight", err)
	}
	if err := s.SendPrompt("during compaction", nil); !errors.Is(err, ErrCompactionInFlight) {
		t.Fatalf("prompt during compaction = %v, want ErrCompactionInFlight", err)
	}
	if s.IsFinished() {
		t.Fatal("session finished while compaction in flight")
	}

	dispatchEvent(s, "compaction_start", `{"type":"compaction_start","reason":"manual","requestId":"c1"}`)
	dispatchEvent(s, "compaction_end", `{"type":"compaction_end","reason":"manual","requestId":"c1"}`)
	w := writer
	w.waitForType(t, "compaction.done", 5*time.Second)
	if !s.IsFinished() {
		t.Fatal("compaction_end did not restore the finished state")
	}
}

// A failed provider write clears the latch and stamps finishedAt so the
// session returns to the idle pool instead of wedging busy.
func TestCompactSendFailureClearsAndStamps(t *testing.T) {
	s, w := startMockSession(t, "chat-compact-sendfail")
	if err := s.SendPrompt("hello", nil); err != nil {
		t.Fatalf("send prompt: %v", err)
	}
	w.waitForType(t, "run.done", 5*time.Second)
	if err := s.Close(); err != nil {
		t.Fatalf("close session: %v", err)
	}

	if err := s.Compact(); err == nil {
		t.Fatal("compact on a dead provider returned nil, want the write error")
	}
	s.mu.Lock()
	active := s.compactionActive
	stamped := !s.finishedAt.IsZero()
	s.mu.Unlock()
	if active {
		t.Fatal("compaction latch not cleared on send failure")
	}
	if !stamped {
		t.Fatal("finishedAt not stamped on send failure")
	}
}

// Automatic (provider-initiated) compaction during a parked agent run: the
// compaction events map to frames, the run stays active, and only
// agent_settled completes it.
func TestAutomaticCompactionDuringRunDoesNotCompleteRun(t *testing.T) {
	s, w := startMockSession(t, "chat-auto-compact",
		"MOCK_PI_AUTO_COMPACT=1", "MOCK_PI_CHUNK_MODE=signal", "MOCK_PI_CHUNKS=2")
	t.Cleanup(func() {
		if err := s.Close(); err != nil {
			t.Errorf("close session: %v", err)
		}
	})

	if err := s.SendPrompt("hello there", nil); err != nil {
		t.Fatalf("send prompt: %v", err)
	}
	w.waitForType(t, "messageDelta", 5*time.Second)

	// The provider emitted a real automatic compaction event pair as part of
	// prompt handling; no manual compact RPC is involved.
	afterDone := w.waitForType(t, "compaction.done", 5*time.Second)
	if got := countFramesOfType(afterDone, "compaction.started"); got != 1 {
		t.Fatalf("compaction.started = %d, want 1; frames: %s", got, w.typesString())
	}
	if got := countFramesOfType(afterDone, "compaction.done"); got != 1 {
		t.Fatalf("compaction.done = %d, want 1; frames: %s", got, w.typesString())
	}
	if got := countFramesOfType(afterDone, "run.done"); got != 0 {
		t.Fatalf("run.done after compaction = %d, want 0; frames: %s", got, w.typesString())
	}
	if s.IsFinished() {
		t.Fatal("automatic compaction finished the session mid-run")
	}

	if err := s.proc.Send(map[string]any{"type": "mock_chunk_next"}); err != nil {
		t.Fatalf("release run: %v", err)
	}
	final := w.waitForType(t, "run.done", 5*time.Second)
	if got := countFramesOfType(final, "run.done"); got != 1 {
		t.Fatalf("run.done total = %d, want 1; frames: %s", got, w.typesString())
	}
	if !s.IsFinished() {
		t.Fatal("session not finished after run settled")
	}
}

// The compaction event pair dispatches to frames exactly once each, and a
// failed compact response after a normal compaction_end does not re-emit.
func TestCompactionEventsEmitFramesExactlyOnce(t *testing.T) {
	writer := newCollectWriter()
	s, commands := newCapturedCommandSession("chat-compact-once", writer)
	armUserPrompt(s)
	dispatchEvent(s, "agent_settled", `{"type":"agent_settled"}`)
	rpcID := startCapturedCompact(t, s, commands)

	dispatchEvent(s, "compaction_start", `{"type":"compaction_start","reason":"manual","requestId":"c1"}`)
	dispatchEvent(s, "compaction_start", `{"type":"compaction_start","reason":"manual","requestId":"c1"}`)
	if got := countFramesOfType(writer.snapshot(), "compaction.started"); got != 1 {
		t.Fatalf("compaction.started after duplicate start = %d, want 1", got)
	}

	// An end for another provider request cannot close c1.
	dispatchEvent(s, "compaction_end", `{"type":"compaction_end","reason":"manual","requestId":"other"}`)
	if got := countFramesOfType(writer.snapshot(), "compaction.done"); got != 0 {
		t.Fatalf("compaction.done after mismatched end = %d, want 0", got)
	}
	if s.IsFinished() {
		t.Fatal("mismatched compaction_end cleared the active compaction")
	}

	dispatchEvent(s, "compaction_end", `{"type":"compaction_end","reason":"manual","requestId":"c1"}`)
	dispatchEvent(s, "compaction_end", `{"type":"compaction_end","reason":"manual","requestId":"c1"}`)
	if got := countFramesOfType(writer.snapshot(), "compaction.done"); got != 1 {
		t.Fatalf("compaction.done after duplicate end = %d, want 1", got)
	}

	// The failed response arrives after compaction_end (provider order): the
	// transaction is already closed, so it reports the RPC error without a
	// second compaction.done.
	dispatchEvent(s, "response", `{"id":"`+rpcID+`","type":"response","command":"compact","success":false,"error":"Nothing to compact"}`)
	dispatchEvent(s, "response", `{"id":"`+rpcID+`","type":"response","command":"compact","success":false,"error":"Nothing to compact"}`)
	dispatchEvent(s, "compaction_start", `{"type":"compaction_start","reason":"manual","requestId":"c1"}`)
	frames := writer.snapshot()
	if got := countFramesOfType(frames, "compaction.done"); got != 1 {
		t.Fatalf("compaction.done after failed response = %d, want 1; frames: %s", got, writer.typesString())
	}
	if got := countFramesOfType(frames, "compaction.started"); got != 1 {
		t.Fatalf("compaction.started total = %d, want 1", got)
	}
	if got := len(framesWithField(frames, "error", "command", "compact")); got != 1 {
		t.Fatalf("compact error frames = %d, want 1; frames: %s", got, writer.typesString())
	}
}

// A late response and terminal event from compact A cannot clear compact B.
// The RPC response is correlated by the id omo-webchat generated, while the
// lifecycle event pair is correlated independently by the provider requestId.
func TestStaleCompactResponseAndEndDoNotClearNewerCompact(t *testing.T) {
	writer := newCollectWriter()
	s, commands := newCapturedCommandSession("chat-compact-stale", writer)
	armUserPrompt(s)
	dispatchEvent(s, "agent_settled", `{"type":"agent_settled"}`)

	rpcA := startCapturedCompact(t, s, commands)
	dispatchEvent(s, "compaction_start", `{"type":"compaction_start","reason":"manual","requestId":"provider-a"}`)
	dispatchEvent(s, "compaction_end", `{"type":"compaction_end","reason":"manual","requestId":"provider-a"}`)

	rpcB := startCapturedCompact(t, s, commands)
	if rpcA == rpcB {
		t.Fatalf("compact RPC ids were reused: %q", rpcA)
	}

	// B has not received compaction_start yet. Neither A's late response nor
	// its duplicate end may release B's admission latch.
	dispatchEvent(s, "response", `{"id":"`+rpcA+`","type":"response","command":"compact","success":false,"error":"late A"}`)
	dispatchEvent(s, "compaction_end", `{"type":"compaction_end","reason":"manual","requestId":"provider-a"}`)
	if s.IsFinished() {
		t.Fatal("stale A response/end cleared compact B before its start")
	}
	if got := countFramesOfType(writer.snapshot(), "compaction.done"); got != 1 {
		t.Fatalf("compaction.done after stale A terminal input = %d, want 1", got)
	}
	if got := len(framesWithField(writer.snapshot(), "error", "requestId", rpcA)); got != 1 {
		t.Fatalf("correlated stale A error frames = %d, want 1", got)
	}

	dispatchEvent(s, "compaction_start", `{"type":"compaction_start","reason":"manual","requestId":"provider-b"}`)
	dispatchEvent(s, "compaction_end", `{"type":"compaction_end","reason":"manual","requestId":"provider-a"}`)
	if s.IsFinished() {
		t.Fatal("mismatched provider requestId cleared compact B")
	}
	dispatchEvent(s, "compaction_end", `{"type":"compaction_end","reason":"manual","requestId":"provider-b"}`)
	if !s.IsFinished() {
		t.Fatal("matching provider requestId did not complete compact B")
	}
	if got := countFramesOfType(writer.snapshot(), "compaction.done"); got != 2 {
		t.Fatalf("compaction.done total = %d, want 2", got)
	}
}

// A provider that fails the compact RPC without ever emitting compaction_end
// still clears the latch and emits terminal compaction/error information, so
// the session cannot wedge busy.
func TestFailedCompactResponseWithoutEndClearsLatch(t *testing.T) {
	writer := newCollectWriter()
	s, commands := newCapturedCommandSession("chat-compact-fallback", writer)
	armUserPrompt(s)
	dispatchEvent(s, "agent_settled", `{"type":"agent_settled"}`)
	rpcID := startCapturedCompact(t, s, commands)

	dispatchEvent(s, "compaction_start", `{"type":"compaction_start","reason":"manual","requestId":"c1"}`)
	if s.IsFinished() {
		t.Fatal("session finished while compaction active")
	}

	dispatchEvent(s, "response", `{"id":"`+rpcID+`","type":"response","command":"compact","success":false,"error":"compact exploded"}`)
	frames := writer.snapshot()
	dones := framesWithField(frames, "compaction.done", "error", "compact exploded")
	if len(dones) != 1 {
		t.Fatalf("terminal compaction.done{error} = %d, want 1; frames: %s", len(dones), writer.typesString())
	}
	errs := framesWithField(frames, "error", "command", "compact")
	if len(errs) != 1 {
		t.Fatalf("compact error frames = %d, want 1; frames: %s", len(errs), writer.typesString())
	}
	s.mu.Lock()
	active := s.compactionActive
	s.mu.Unlock()
	if active {
		t.Fatal("latch still set after failed compact response")
	}
	if !s.IsFinished() {
		t.Fatal("failed compact wedged the finished state")
	}
}

// A successful compact response closes the transaction even when
// compaction_end never arrived, emitting a clean terminal frame.
func TestSuccessfulCompactResponseClosesTransaction(t *testing.T) {
	writer := newCollectWriter()
	s, commands := newCapturedCommandSession("chat-compact-success", writer)
	armUserPrompt(s)
	dispatchEvent(s, "agent_settled", `{"type":"agent_settled"}`)
	rpcID := startCapturedCompact(t, s, commands)

	dispatchEvent(s, "compaction_start", `{"type":"compaction_start","reason":"manual","requestId":"c1"}`)
	dispatchEvent(s, "response", `{"id":"`+rpcID+`","type":"response","command":"compact","success":true,"data":{"summary":"trimmed"}}`)

	frames := writer.snapshot()
	if got := countFramesOfType(frames, "compaction.done"); got != 1 {
		t.Fatalf("compaction.done = %d, want 1; frames: %s", got, writer.typesString())
	}
	var done CompactionDoneFrame
	for _, f := range frames {
		_ = json.Unmarshal(f, &done)
	}
	if done.Error != "" {
		t.Fatalf("compaction.done error = %q, want empty on success", done.Error)
	}
	s.mu.Lock()
	active := s.compactionActive
	s.mu.Unlock()
	if active {
		t.Fatal("latch still set after successful compact response")
	}
	if !s.IsFinished() {
		t.Fatal("successful compact wedged the finished state")
	}
}

// Compaction must not wedge idle eviction: the latch un-finishes the session,
// compaction_end re-stamps finishedAt, and both failure paths restore
// idle-finished.
func TestCompactionDoesNotWedgeIdleEviction(t *testing.T) {
	s := newTestSession("chat-compact-idle", nil)
	armUserPrompt(s)
	dispatchEvent(s, "agent_settled", `{"type":"agent_settled"}`)
	if !s.IdleFinished(0, time.Now()) {
		t.Fatal("session not idle-finished before compaction")
	}

	dispatchEvent(s, "compaction_start", `{"type":"compaction_start","reason":"threshold","requestId":"auto-1"}`)
	if s.IsFinished() || s.IdleFinished(0, time.Now()) {
		t.Fatal("compaction-active session reported finished/idle-finished")
	}

	dispatchEvent(s, "compaction_end", `{"type":"compaction_end","reason":"threshold","requestId":"auto-1"}`)
	if !s.IsFinished() || !s.IdleFinished(0, time.Now()) {
		t.Fatal("compaction_end did not restore finished/idle-finished")
	}

	// A manual compact released by its matching failed RPC response also
	// restores idle-finished when compaction_end is absent.
	commands := newCommandCaptureWriter()
	s.proc = &Process{stdin: commands}
	rpcID := startCapturedCompact(t, s, commands)
	dispatchEvent(s, "compaction_start", `{"type":"compaction_start","reason":"manual","requestId":"manual-1"}`)
	dispatchEvent(s, "response", `{"id":"`+rpcID+`","type":"response","command":"compact","success":false,"error":"boom"}`)
	if !s.IdleFinished(0, time.Now()) {
		t.Fatal("failed compact response did not restore idle-finished")
	}
}

// compaction_start emits its frame while holding lifecycleMu, so compaction
// state transitions serialize with every other lifecycle transition.
func TestCompactionStartWaitsForLifecycleLock(t *testing.T) {
	writer := newCollectWriter()
	s := newTestSession("chat-compact-lifecycle-mu", writer)
	blocker := &blockingFrameWriter{entered: make(chan struct{}), release: make(chan struct{})}
	detach := s.Attach(blocker)
	defer detach()

	done := make(chan struct{})
	go func() {
		dispatchEvent(s, "compaction_start", `{"type":"compaction_start","reason":"threshold","requestId":"auto-1"}`)
		close(done)
	}()
	<-blocker.entered

	if s.lifecycleMu.TryLock() {
		s.lifecycleMu.Unlock()
		t.Fatal("beginCompaction emitted compaction.started without holding lifecycleMu")
	}

	close(blocker.release)
	<-done

	if !s.compactionActive {
		t.Fatal("compaction was not latched")
	}
	if got := countFramesOfType(writer.snapshot(), "compaction.started"); got != 1 {
		t.Fatalf("compaction.started = %d, want 1", got)
	}
	if s.IdleFinished(0, time.Now()) {
		t.Fatal("compaction-active session reported idle-finished")
	}
}

func TestCompactionTerminalPublicationHoldsLifecycleLock(t *testing.T) {
	t.Run("matching compaction_end", func(t *testing.T) {
		s, commands := newCapturedCommandSession("chat-compact-end-terminal", nil)
		armUserPrompt(s)
		dispatchEvent(s, "agent_settled", `{"type":"agent_settled"}`)
		_ = startCapturedCompact(t, s, commands)
		dispatchEvent(s, "compaction_start", `{"type":"compaction_start","reason":"manual","requestId":"provider-1"}`)

		assertLifecycleHeldDuringFrame(t, s, func() {
			dispatchEvent(s, "compaction_end", `{"type":"compaction_end","reason":"manual","requestId":"provider-1"}`)
		})
		if !s.IsFinished() {
			t.Fatal("session not finished after compaction_end publication")
		}
	})

	t.Run("matching RPC fallback", func(t *testing.T) {
		s, commands := newCapturedCommandSession("chat-compact-response-terminal", nil)
		armUserPrompt(s)
		dispatchEvent(s, "agent_settled", `{"type":"agent_settled"}`)
		rpcID := startCapturedCompact(t, s, commands)
		dispatchEvent(s, "compaction_start", `{"type":"compaction_start","reason":"manual","requestId":"provider-1"}`)

		assertLifecycleHeldDuringFrame(t, s, func() {
			dispatchEvent(s, "response", `{"id":"`+rpcID+`","type":"response","command":"compact","success":false,"error":"fallback"}`)
		})
		if !s.IsFinished() {
			t.Fatal("session not finished after compact response fallback")
		}
	})
}

// Exactly one of two concurrent compacts wins the latch, and the winner does
// not hold lifecycleMu across a stalled provider write (a stuck stdin must
// not block Close/reaping on other sessions).
func TestCompactDoesNotHoldLifecycleLockAcrossProviderWrite(t *testing.T) {
	writer := newCollectWriter()
	s := startIdleProviderSession(t, "chat-compact-lock-write", writer)
	t.Cleanup(func() {
		if err := s.Close(); err != nil {
			t.Errorf("close session: %v", err)
		}
	})
	armUserPrompt(s)
	dispatchEvent(s, "agent_settled", `{"type":"agent_settled"}`)
	if !s.IsFinished() {
		t.Fatal("session not finished before compact")
	}

	wedge := parkWriterOnBlockedStdin(t, s.proc)
	defer wedge.release()
	results := make(chan error, 2)
	go func() { results <- s.Compact() }()
	go func() { results <- s.Compact() }()

	// Exactly one compact is rejected at the latch without touching stdin.
	var rejected error
	select {
	case rejected = <-results:
	case <-time.After(5 * time.Second):
		t.Fatal("no compact was rejected while the provider write was stalled")
	}
	if rejected == nil {
		t.Fatal("the early compact result was nil; both compacts were accepted")
	}

	// The winner latched before its write (the rejection observed it) but
	// must have released lifecycleMu before blocking on the provider write.
	lifecycleRead := make(chan struct{})
	go func() {
		_ = s.IsFinished()
		close(lifecycleRead)
	}()
	select {
	case <-lifecycleRead:
	case <-time.After(5 * time.Second):
		t.Fatal("lifecycleMu remained held across the provider write")
	}

	wedge.release()
	if err := <-results; err != nil {
		t.Fatalf("accepted compact failed: %v", err)
	}
	if s.IsFinished() {
		t.Fatal("session finished while compaction latch held")
	}
	dispatchEvent(s, "compaction_start", `{"type":"compaction_start","reason":"manual","requestId":"c1"}`)
	dispatchEvent(s, "compaction_end", `{"type":"compaction_end","reason":"manual","requestId":"c1"}`)
	if !s.IsFinished() {
		t.Fatal("compaction_end did not restore the finished state")
	}
}
