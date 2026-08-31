package chat

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"syscall"
	"testing"
	"time"
)

func mockPiScript(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	script := filepath.Join(filepath.Dir(file), "..", "..", "test", "mock-pi", "mock-pi.mjs")
	if _, err := os.Stat(script); err != nil {
		t.Skipf("mock-pi not found at %s: %v", script, err)
	}
	return script
}

func startMockPi(t *testing.T, env ...string) *Process {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skipf("node not in PATH: %v", err)
	}
	script := mockPiScript(t)
	proc, err := Start(context.Background(), ProcessOptions{
		Binary: node,
		Args:   []string{script},
		Env:    append(os.Environ(), env...),
	})
	if err != nil {
		t.Fatalf("start mock-pi: %v", err)
	}
	return proc
}

func cleanupProcess(t *testing.T, proc *Process) {
	t.Helper()
	t.Cleanup(func() {
		if err := proc.Close(); err != nil {
			t.Errorf("close process: %v", err)
		}
	})
}

func collectUntil(t *testing.T, proc *Process, wantType string, timeout time.Duration) []Event {
	t.Helper()
	events := make(chan Event, 64)
	go proc.Events(events)
	var got []Event
	deadline := time.After(timeout)
	for {
		select {
		case ev, ok := <-events:
			if !ok {
				return got
			}
			got = append(got, ev)
			if ev.Type == wantType {
				return got
			}
		case <-deadline:
			t.Fatalf("timed out waiting for %q; got %d events: %v", wantType, len(got), typesOf(got))
		}
	}
}

func typesOf(evs []Event) []string {
	out := make([]string, len(evs))
	for i, e := range evs {
		out[i] = e.Type
	}
	return out
}

func TestProcess_PromptStreamAndSettled(t *testing.T) {
	proc := startMockPi(t, "MOCK_PI_UNICODE=1", "MOCK_PI_CHUNKS=3")
	cleanupProcess(t, proc)

	if err := proc.Send(map[string]any{"type": "prompt", "message": "hello", "id": "r1"}); err != nil {
		t.Fatalf("send prompt: %v", err)
	}
	got := collectUntil(t, proc, "agent_settled", 5*time.Second)

	types := typesOf(got)
	if !slices.Contains(types, "agent_start") {
		t.Fatalf("missing agent_start: %v", types)
	}
	if types[len(types)-1] != "agent_settled" {
		t.Fatalf("last event not agent_settled: %v", types)
	}
	deltas := 0
	sawUnicode := false
	for _, ev := range got {
		if ev.Type != "message_update" {
			continue
		}
		var det struct {
			AssistantMessageEvent struct {
				Type    string `json:"type"`
				Partial struct {
					Text string `json:"text"`
				} `json:"partial"`
			} `json:"assistantMessageEvent"`
		}
		if err := json.Unmarshal(ev.Raw, &det); err != nil {
			t.Fatalf("unmarshal message_update: %v", err)
		}
		if det.AssistantMessageEvent.Type == "text_delta" {
			deltas++
			if strings.Contains(det.AssistantMessageEvent.Partial.Text, "\u2028") {
				sawUnicode = true
			}
		}
	}
	if deltas != 3 {
		t.Fatalf("expected 3 text_delta events, got %d", deltas)
	}
	if !sawUnicode {
		t.Fatalf("U+2028 not preserved through the subprocess pipe")
	}
}

func TestProcess_AbortStopsStream(t *testing.T) {
	proc := startMockPi(t, "MOCK_PI_CHUNKS=50", "MOCK_PI_CHUNK_MODE=signal")
	cleanupProcess(t, proc)
	events := make(chan Event, 64)
	go proc.Events(events)

	if err := proc.Send(map[string]any{"type": "prompt", "message": strings.Repeat("x", 200), "id": "r2"}); err != nil {
		t.Fatalf("send prompt: %v", err)
	}
	var got []Event
	aborted := false
	timer := time.NewTimer(3 * time.Second)
	defer timer.Stop()
stream:
	for {
		select {
		case ev := <-events:
			got = append(got, ev)
			if ev.Type == "message_update" && !aborted {
				var update struct {
					AssistantMessageEvent struct {
						Type string `json:"type"`
					} `json:"assistantMessageEvent"`
				}
				if json.Unmarshal(ev.Raw, &update) == nil && update.AssistantMessageEvent.Type == "text_delta" {
					proc.Abort()
					aborted = true
				}
			}
			if ev.Type == "agent_settled" {
				break stream
			}
		case <-timer.C:
			t.Fatalf("timed out waiting for settlement; events: %v", typesOf(got))
		}
	}
	if !aborted {
		t.Fatal("stream settled before the first text delta could be aborted")
	}

	var stopReason string
	deltas := 0
	for _, ev := range got {
		switch ev.Type {
		case "message_update":
			var update struct {
				AssistantMessageEvent struct {
					Type string `json:"type"`
				} `json:"assistantMessageEvent"`
			}
			if json.Unmarshal(ev.Raw, &update) == nil && update.AssistantMessageEvent.Type == "text_delta" {
				deltas++
			}
		case "message_end":
			var m struct {
				Message struct {
					StopReason string `json:"stopReason"`
				} `json:"message"`
			}
			if err := json.Unmarshal(ev.Raw, &m); err == nil {
				stopReason = m.Message.StopReason
			}
		}
	}
	if deltas != 1 {
		t.Fatalf("expected exactly one text delta before abort, got %d (events: %v)", deltas, typesOf(got))
	}
	if stopReason != "aborted" {
		t.Fatalf("expected stopReason=aborted after abort, got %q (events: %v)", stopReason, typesOf(got))
	}
}

func TestProcessCloseTreatsCancellationAsSuccess(t *testing.T) {
	proc := startMockPi(t)
	if err := proc.Close(); err != nil {
		t.Fatalf("close process: %v", err)
	}
}

func TestProcessClosePreservesUnexpectedExitFailure(t *testing.T) {
	shell, err := exec.LookPath("sh")
	if err != nil {
		t.Skipf("sh not in PATH: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	proc, err := Start(ctx, ProcessOptions{Binary: shell, Args: []string{"-c", "exit 7"}, Env: os.Environ()})
	if err != nil {
		t.Fatalf("start process: %v", err)
	}
	closed := false
	t.Cleanup(func() {
		if !closed {
			if closeErr := proc.Close(); closeErr != nil {
				t.Errorf("cleanup process: %v", closeErr)
			}
		}
	})
	events := make(chan Event)
	go proc.Events(events)
	select {
	case _, ok := <-events:
		if ok {
			t.Fatal("unexpected event from exit-only process")
		}
	case <-ctx.Done():
		t.Fatal("timed out waiting for process exit")
	}
	err = proc.Close()
	closed = true
	var exitErr *exec.ExitError
	if !errors.As(err, &exitErr) || exitErr.ExitCode() != 7 {
		t.Fatalf("close error = %v, want exit status 7", err)
	}
}

func startScriptProcess(t *testing.T, script string) *Process {
	t.Helper()
	shell, err := exec.LookPath("sh")
	if err != nil {
		t.Skipf("sh not in PATH: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	t.Cleanup(cancel)
	proc, err := Start(ctx, ProcessOptions{Binary: shell, Args: []string{"-c", script}})
	if err != nil {
		t.Fatalf("start process: %v", err)
	}
	return proc
}

// selfSegvExitErr runs a process that kills itself with SIGSEGV and returns
// the raw Wait error plus the platform's raw signal name (e.g. "SIGSEGV" on
// linux, "segmentation fault" on darwin).
func selfSegvExitErr(t *testing.T) (*exec.ExitError, string) {
	t.Helper()
	shell, err := exec.LookPath("sh")
	if err != nil {
		t.Skipf("sh not in PATH: %v", err)
	}
	cmd := exec.Command(shell, "-c", "kill -SEGV $$")
	runErr := cmd.Run()
	if runErr == nil {
		t.Fatal("self-SIGSEGV exited cleanly, want ExitError")
	}
	var exitErr *exec.ExitError
	if !errors.As(runErr, &exitErr) {
		t.Fatalf("self-SIGSEGV produced %v, want ExitError", runErr)
	}
	ws, ok := exitErr.ProcessState.Sys().(syscall.WaitStatus)
	if !ok || !ws.Signaled() {
		t.Fatalf("self-SIGSEGV not reported as a signal: %v", exitErr.ProcessState)
	}
	return exitErr, ws.Signal().String()
}

func exit7Err(t *testing.T) *exec.ExitError {
	t.Helper()
	shell, err := exec.LookPath("sh")
	if err != nil {
		t.Skipf("sh not in PATH: %v", err)
	}
	cmd := exec.Command(shell, "-c", "exit 7")
	runErr := cmd.Run()
	if runErr == nil {
		t.Fatal("exit 7 exited cleanly, want ExitError")
	}
	var exitErr *exec.ExitError
	if !errors.As(runErr, &exitErr) {
		t.Fatalf("exit 7 produced %v, want ExitError", runErr)
	}
	return exitErr
}

// The provider killed itself with a signal: the raw signal must survive in
// the exit summary even though closeErr erases signaled exits.
func TestProcessExitSummarySelfSignal(t *testing.T) {
	_, name := selfSegvExitErr(t)
	proc := startScriptProcess(t, "kill -SEGV $$")
	<-proc.exited
	if got, want := proc.ExitSummary(), "self-exit: signal "+name; got != want {
		t.Fatalf("exit summary = %q, want %q", got, want)
	}
	if err := proc.Close(); err != nil {
		t.Fatalf("close process: %v", err)
	}
}

func TestProcessExitSummarySelfCode(t *testing.T) {
	proc := startScriptProcess(t, "exit 7")
	<-proc.exited
	if got, want := proc.ExitSummary(), "self-exit: code 7"; got != want {
		t.Fatalf("exit summary = %q, want %q", got, want)
	}
	if err := proc.Close(); exitCodeOf(err) != 7 {
		t.Fatalf("close error = %v, want cached exit status 7", err)
	}
}

// Closing a live provider is recorded as a session cancellation: the exit
// summary must say omo-webchat killed it, not that it exited on its own.
func TestProcessExitSummaryCancelledWhileRunning(t *testing.T) {
	if _, err := exec.LookPath("sleep"); err != nil {
		t.Skipf("sleep not in PATH: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	t.Cleanup(cancel)
	proc, err := Start(ctx, ProcessOptions{Binary: "sleep", Args: []string{"30"}})
	if err != nil {
		t.Fatalf("start process: %v", err)
	}
	if err := proc.Close(); err != nil {
		t.Fatalf("close process: %v", err)
	}
	if got, want := proc.ExitSummary(), "cancelled by session_close"; got != want {
		t.Fatalf("exit summary = %q, want %q", got, want)
	}
}

// Parent cancellation must be attributed to the parent and must beat a later
// explicit Close. The watcher records asynchronously, so the test waits on
// parentWatchDone — the watcher closes it only after recording.
func TestProcessExitSummaryParentCancel(t *testing.T) {
	if _, err := exec.LookPath("sleep"); err != nil {
		t.Skipf("sleep not in PATH: %v", err)
	}
	parent, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	proc, err := Start(parent, ProcessOptions{Binary: "sleep", Args: []string{"30"}})
	if err != nil {
		t.Fatalf("start process: %v", err)
	}
	cancel()
	<-proc.parentWatchDone
	if err := proc.Close(); err != nil {
		t.Fatalf("close process: %v", err)
	}
	if got, want := proc.ExitSummary(), "cancelled by parent"; got != want {
		t.Fatalf("exit summary = %q, want %q", got, want)
	}
}

// A cancellation recorded after the leader was already reaped is a
// concurrent race: the summary must say ambiguous with the raw evidence and
// never invent a cause. The ordering evidence is injected directly because
// the race window is not reachable deterministically from live processes.
func TestProcessExitSummaryAmbiguousRace(t *testing.T) {
	exitErr, name := selfSegvExitErr(t)
	p := &Process{exited: make(chan struct{})}
	close(p.exited)
	p.exit.rawErr = exitErr
	p.exit.waitReturned = true
	p.exit.cancelReason = "session_close"
	p.exit.waitReadyAtCancel = true
	p.recordExit()
	want := "ambiguous: waitDone ready and ctx cancelled concurrently (raw: signal " + name + ")"
	if got := p.ExitSummary(); got != want {
		t.Fatalf("exit summary = %q, want %q", got, want)
	}

	// The other race flavor: the EOF cancellation is recorded while the
	// leader is unreaped, but the raw result shows our SIGKILL never landed
	// (a normal exit). The exit raced the kill — ambiguous, not pump_eof.
	p2 := &Process{exited: make(chan struct{})}
	close(p2.exited)
	p2.exit.rawErr = exit7Err(t)
	p2.exit.waitReturned = true
	p2.exit.cancelReason = "pump_eof"
	p2.exit.waitReadyAtCancel = false
	p2.recordExit()
	want2 := "ambiguous: exit raced a concurrent cancellation (raw: code 7)"
	if got := p2.ExitSummary(); got != want2 {
		t.Fatalf("exit summary = %q, want %q", got, want2)
	}
}

// The pi_eof frame must carry the exit evidence so the next occurrence is
// diagnosable. Determinism is engineered end to end: the leader blocks on
// stdin until the test releases it (so the writer is attached before any
// frame can be sent — the broadcaster only forwards future frames), and a
// background descendant holds stdout (so EOF only arrives after the reaper
// has published the leader's raw Wait result, and the pump reaps without
// cancelling — a clean self-exit attribution).
func TestSessionPiEOFMessageCarriesExitSummary(t *testing.T) {
	shell, err := exec.LookPath("sh")
	if err != nil {
		t.Skipf("sh not in PATH: %v", err)
	}
	if _, err := exec.LookPath("sleep"); err != nil {
		t.Skipf("sleep not in PATH: %v", err)
	}
	writer := newCollectWriter()
	session, err := StartSession(context.Background(), SessionOptions{
		ID:     "chat-pieof",
		Binary: shell,
		Args:   []string{"-c", "read x; sleep 30 & exit 7"},
	})
	if err != nil {
		t.Fatalf("start session: %v", err)
	}
	t.Cleanup(func() { _ = session.Close() })
	session.Attach(writer)
	if err := session.proc.Send(map[string]any{"type": "release"}); err != nil {
		t.Fatalf("release leader: %v", err)
	}
	select {
	case <-session.pumpDone:
	case <-time.After(10 * time.Second):
		t.Fatal("pump did not finish after leader exit")
	}
	for _, f := range writer.snapshot() {
		var ef ErrorFrame
		if json.Unmarshal(f, &ef) == nil && ef.Type == "error" && ef.Code == "pi_eof" {
			if want := "Omo process ended (self-exit: code 7)"; ef.Message != want {
				t.Fatalf("pi_eof message = %q, want %q", ef.Message, want)
			}
			return
		}
	}
	t.Fatal("no pi_eof frame delivered")
}
