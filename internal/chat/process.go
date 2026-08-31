package chat

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sync"
	"time"
)

type Event struct {
	Type       string            `json:"-"`
	Raw        json.RawMessage   `json:"-"`
	ReceivedAt time.Time         `json:"-"`
	Page       []json.RawMessage `json:"-"`
	LeafID     string            `json:"-"`
	Final      bool              `json:"-"`
	SessionID  string            `json:"-"`
	RequestID  string            `json:"-"`
}

type ProcessOptions struct {
	Binary string
	Args   []string
	Cwd    string
	Env    []string
}

type Process struct {
	cmd     *exec.Cmd
	stdin   io.WriteCloser
	stdout  io.ReadCloser
	ctx     context.Context
	cancel  context.CancelFunc
	writeMu sync.Mutex
	// waitReturned closes once cmd.Wait has stored the raw result, so the
	// reaper and CloseAfterEOF can observe the leader's exit without
	// consuming the channel.
	waitReturned chan struct{}
	// parentWatchDone closes once watchParent has arbitrated parent
	// cancellation against the leader's exit; reap waits on it before
	// classifying so a concurrent parent cancel is never lost.
	parentWatchDone chan struct{}
	// exited closes when the reaper has reaped the leader. closeErr is written
	// before it closes, so every reader that waits on it observes the result
	// without further synchronization.
	exited   chan struct{}
	closeErr error
	exitMu   sync.Mutex
	exit     exitRecord
}

// exitRecord is the evidence of why the provider ended. The Wait goroutine
// writes rawErr and waitReturned; cancelWith writes cancelReason and
// waitReadyAtCancel atomically with the cancellation decision; reap
// classifies into code, signal, cause, and ambiguous. All classification
// writes finish before exited closes, so ExitSummary reads a settled record
// after <-exited; the lock also keeps a late Close (after the leader was
// reaped) from racing recordExit.
type exitRecord struct {
	rawErr            error
	waitReturned      bool
	cancelReason      string // "", "session_close", "pump_eof", or "parent"
	waitReadyAtCancel bool   // leader already reaped when the cancel was recorded
	code              int
	signal            string
	cause             string // cancelReason when omo-webchat killed it; "" for self-exit
	ambiguous         bool
}

func Start(parent context.Context, opts ProcessOptions) (*Process, error) {
	if opts.Binary == "" {
		return nil, errors.New("chat: binary is required")
	}
	if err := parent.Err(); err != nil {
		return nil, err
	}
	// The command runs on a private context so exec.CommandContext's internal
	// watcher can never cancel it unrecorded: it would kill asynchronously and
	// the exit would look spontaneous. watchParent forwards parent
	// cancellation through cancelWith instead, which attributes the kill
	// before it happens.
	ctx, cancel := context.WithCancel(context.Background())
	cmd := exec.CommandContext(ctx, opts.Binary, opts.Args...)
	cmd.Dir = opts.Cwd
	cmd.Env = opts.Env
	configureProcGroup(cmd)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		cancel()
		return nil, fmt.Errorf("chat: stdin pipe: %w", err)
	}
	// Own the stdout pipe rather than using cmd.StdoutPipe so cmd.Wait reaps
	// the leader without waiting for, or closing, the read end. A descendant
	// that inherits stdout would otherwise keep Wait—and every shutdown path
	// behind it—blocked until it dies.
	pr, pw, err := os.Pipe()
	if err != nil {
		cancel()
		return nil, fmt.Errorf("chat: stdout pipe: %w", err)
	}
	cmd.Stdout = pw
	cmd.Stderr = nil
	if err := cmd.Start(); err != nil {
		cancel()
		_ = pr.Close()
		_ = pw.Close()
		return nil, fmt.Errorf("chat: start %s: %w", opts.Binary, err)
	}
	// The child group owns the write end now; the parent must release it or
	// stdout never reaches EOF when the group dies.
	_ = pw.Close()
	p := &Process{
		cmd:             cmd,
		stdin:           stdin,
		stdout:          pr,
		ctx:             ctx,
		cancel:          cancel,
		waitReturned:    make(chan struct{}),
		parentWatchDone: make(chan struct{}),
		exited:          make(chan struct{}),
	}
	go p.watchParent(parent)
	go p.reap()
	return p, nil
}

// watchParent forwards parent cancellation into cancelWith so the kill is
// attributed to the parent. It arbitrates against the leader's raw exit
// rather than reap completion: if the parent cancels in the same instant the
// leader exits, the select could otherwise pick the exit side and drop a
// concurrent cancellation, turning a genuine race into a false self-exit.
// The waitReturned side checks parent.Err() and records anyway.
func (p *Process) watchParent(parent context.Context) {
	defer close(p.parentWatchDone)
	select {
	case <-parent.Done():
		p.cancelWith("parent")
	case <-p.waitReturned:
		if parent.Err() != nil {
			p.cancelWith("parent")
		}
	}
}

func (p *Process) Send(cmd map[string]any) error {
	b, err := json.Marshal(cmd)
	if err != nil {
		return fmt.Errorf("chat: marshal command: %w", err)
	}
	p.writeMu.Lock()
	defer p.writeMu.Unlock()
	if _, err := p.stdin.Write(append(b, '\n')); err != nil {
		return fmt.Errorf("chat: write command: %w", err)
	}
	return nil
}

// Events forwards stdout frames until the pipe closes. The reaper kills the
// process group when the leader exits, so every writer of stdout dies and the
// read end reaches EOF even if a descendant outlived the leader. Events is the
// sole reader, so it releases the read end once drained.
//
// Frames are read with a streaming JSON decoder (see readFrames): omo
// get_entries responses are token-streamed into bounded pages so a large
// history never buffers in full, and every other frame is reconstructed for the
// existing raw-consuming handlers. A decode error is fatal — the provider
// stream is corrupt and cannot be resynchronized — and is surfaced as a
// decode_error event before the channel closes.
func (p *Process) Events(out chan<- Event) {
	dec := json.NewDecoder(p.stdout)
	if err := p.readFrames(dec, out); err != nil {
		if msg, merr := json.Marshal(err.Error()); merr == nil {
			out <- Event{Type: "decode_error", Raw: msg}
		}
	}
	_ = p.stdout.Close()
	close(out)
}

func (p *Process) Abort() {
	_ = p.Send(map[string]any{"type": "abort"})
}

// reap waits for the leader independently of stdout EOF and owns the group
// kill on every path. It does not rely on CommandContext's watchCtx: that
// goroutine kills asynchronously, and its select between waitDone and
// ctx.Done can skip the kill entirely if the leader exits concurrently with
// cancellation—leaving a descendant that inherited stdout alive behind a
// reaped leader. Killing the group here, synchronously, in both the
// requested-shutdown and spontaneous-exit branches guarantees no descendant
// outlives the reap.
func (p *Process) reap() {
	go func() {
		err := p.cmd.Wait()
		p.exitMu.Lock()
		p.exit.rawErr = err
		p.exit.waitReturned = true
		p.exitMu.Unlock()
		close(p.waitReturned)
	}()

	// The select only decides who kills and drains; it is never used to
	// classify the exit — Go picks arbitrarily when both cases are ready, and
	// the raw result plus the recorded cancellation decide the cause in
	// recordExit.
	select {
	case <-p.ctx.Done():
		// Shutdown was requested: kill the group ourselves, then reap.
		_ = killProcGroup(p.cmd)
		<-p.waitReturned
	case <-p.waitReturned:
		// Leader exited on its own: reap descendants that inherited stdout so
		// they stop holding the pipe and Events reaches EOF.
		_ = killProcGroup(p.cmd)
	}
	// watchParent may still be recording a concurrent parent cancellation;
	// classify only after it has arbitrated.
	<-p.parentWatchDone
	p.recordExit()
	p.cancel()
	err := p.exit.rawErr
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) && exitErr.ExitCode() == -1 {
		err = nil
	}
	p.closeErr = err
	close(p.exited)
}

// recordExit classifies the exit from the recorded cancellation and the raw
// Wait evidence. Only the unambiguous cases get a definitive label: no
// cancellation → self-exit, the raw code/signal is the cause; a cancellation
// recorded while the leader was running whose raw result is the signal our
// group kill delivers → omo-webchat killed it, the signal is ours, not the
// original cause. Anything concurrent — a cancellation recorded after the
// leader was already reaped, or raw evidence our kill never landed — is
// ambiguous.
func (p *Process) recordExit() {
	p.exitMu.Lock()
	defer p.exitMu.Unlock()
	p.exit.code, p.exit.signal = exitEvidence(p.exit.rawErr)
	switch {
	case p.exit.cancelReason == "":
		// (a) self-exit: raw code/signal is the cause.
	case p.exit.waitReadyAtCancel:
		// The leader had already been reaped when the cancellation was
		// recorded: the exit and the cancel raced, so no definitive cause
		// exists.
		p.exit.ambiguous = true
	case !isKillSignal(p.exit.signal):
		// The cancellation was recorded while the leader was unreaped, but
		// the raw result is a death our kill could not have caused (a
		// landed SIGKILL would replace any other exit signal). The leader
		// was already exiting when the cancellation landed — e.g. the EOF
		// cancellation raced Wait publication — so the cause is a race.
		p.exit.ambiguous = true
	default:
		// (b) The cancellation was recorded while the leader was still
		// running and the raw signal is exactly what our kill delivers:
		// omo-webchat killed it.
		p.exit.cause = p.exit.cancelReason
	}
}

// cancelWith records why the process is being cancelled — and whether the
// leader had already been reaped at that instant — before cancelling. The
// reaper classifies the exit solely from this record plus the raw Wait
// evidence, so the attribution is fixed at cancel time instead of being
// inferred from a select race. Only the first cancellation is recorded;
// later calls are idempotent.
func (p *Process) cancelWith(reason string) {
	p.exitMu.Lock()
	if p.exit.cancelReason == "" {
		p.exit.cancelReason = reason
		p.exit.waitReadyAtCancel = p.exit.waitReturned
	}
	p.exitMu.Unlock()
	p.cancel()
}

// ExitSummary describes why the provider ended, for the pi_eof message and
// server logs. It blocks until the reaper has reaped the leader. Concurrent
// exits and cancellations are reported as ambiguous with the raw evidence,
// never as a definitive cause.
func (p *Process) ExitSummary() string {
	<-p.exited
	p.exitMu.Lock()
	defer p.exitMu.Unlock()
	raw := fmt.Sprintf("code %d", p.exit.code)
	if p.exit.signal != "" {
		raw = "signal " + p.exit.signal
	}
	switch {
	case p.exit.ambiguous:
		if p.exit.waitReadyAtCancel {
			return "ambiguous: waitDone ready and ctx cancelled concurrently (raw: " + raw + ")"
		}
		return "ambiguous: exit raced a concurrent cancellation (raw: " + raw + ")"
	case p.exit.cause != "":
		return "cancelled by " + p.exit.cause
	default:
		return "self-exit: " + raw
	}
}

// Close kills the process group and reaps the leader. Every shutdown path
// (Session.Close, Manager.Stop) converges here: cancel is idempotent and the
// reaper runs cmd.Wait exactly once, so every caller observes the same
// cached result.
func (p *Process) Close() error {
	p.cancelWith("session_close")
	<-p.exited
	return p.closeErr
}

// CloseAfterEOF reaps a provider whose stdout pipe already reached EOF. The
// pump calls this instead of Close: normally the leader has already exited
// and this returns the cached result without issuing a cancellation, so a
// spontaneous exit is never attributed to the pump's teardown. The raw Wait
// result can still be landing when EOF arrives (EOF wakes the pump faster
// than wait4 publishes the result); the EOF cancellation is then recorded
// immediately, and recordExit resolves the race — raw evidence that our
// SIGKILL never landed marks the exit ambiguous instead of blaming the pump.
func (p *Process) CloseAfterEOF() error {
	select {
	case <-p.exited:
		return p.closeErr
	default:
	}
	p.exitMu.Lock()
	ready := p.exit.waitReturned
	p.exitMu.Unlock()
	if !ready {
		p.cancelWith("pump_eof")
	}
	<-p.exited
	return p.closeErr
}
