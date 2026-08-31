package chat

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"
)

const (
	// DefaultSendTimeout bounds every Send: one absolute deadline covers both
	// waiting for queue space and waiting for the frame's own write
	// completion. Zero-value options mean these defaults (per-process fields,
	// never package globals, so concurrent tests cannot race them).
	DefaultSendTimeout = 10 * time.Second
	// DefaultSendQueueDepth is the FIFO depth feeding the single writer
	// goroutine.
	DefaultSendQueueDepth = 64

	// stderrRotateBytes is the per-file budget of the provider-stderr sink.
	// One backup file carries the same budget, so captured stderr is hard-
	// capped at twice this size on disk.
	stderrRotateBytes = 10 << 20
	stderrDirPerm     = 0o700
	stderrFilePerm    = 0o600
)

// ErrSendTimeout is the timeout family returned by Send: both a full queue
// and a write that did not complete in time wrap it (plus
// context.DeadlineExceeded), so callers can errors.Is against either.
var ErrSendTimeout = errors.New("chat: provider command write timed out")

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
	// StderrPath captures the provider's stderr into a bounded rotating file
	// pair (path plus one .1 backup, 10MiB each). Opening the sink is part of
	// starting the provider: an open failure fails the start. Empty leaves
	// stderr unwired (/dev/null).
	StderrPath string
	// SendTimeout bounds each Send (enqueue wait plus write-completion wait
	// under one absolute deadline). Zero means DefaultSendTimeout.
	SendTimeout time.Duration
	// SendQueueDepth is the writer queue bound. Zero means
	// DefaultSendQueueDepth.
	SendQueueDepth int
}

// writeRequest is one marshaled JSONL frame travelling to the writer
// goroutine. deadline is the caller's absolute completion deadline: the
// writer discards an expired frame that has not been written yet, but never
// abandons a write already in flight — the deadline bounds the caller's wait,
// and the syscall itself is released by the provider lifecycle (process
// death closes the pipe).
type writeRequest struct {
	frame    []byte
	deadline time.Time
	// done is buffered so a caller already released by its own deadline can
	// never block the writer on completion.
	done chan error
}

func (r *writeRequest) complete(err error) { r.done <- err }

type Process struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stdout io.ReadCloser
	ctx    context.Context
	cancel context.CancelFunc

	// Finite-send machinery. ONE writer goroutine owns stdin; Senders never
	// touch it. The writer reads p.stdin on every write so a test may swap
	// the field to observe or wedge the stream after Start.
	writeQueue      chan *writeRequest
	writerClose     chan struct{} // closed by Close to release the writer
	writerDone      chan struct{} // closed when the writer goroutine has exited
	writerOnce      sync.Once
	closeWriterOnce sync.Once
	sendTimeout     time.Duration
	sendQueueDepth  int
	// A real write error is terminal for the pipe: it is latched here and
	// drains every queued waiter; later Sends fail fast with it.
	stickyMu  sync.Mutex
	stickyErr error

	stderrPath string
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
	p := &Process{
		ctx:             ctx,
		cancel:          cancel,
		sendTimeout:     opts.SendTimeout,
		sendQueueDepth:  opts.SendQueueDepth,
		stderrPath:      opts.StderrPath,
		waitReturned:    make(chan struct{}),
		parentWatchDone: make(chan struct{}),
		exited:          make(chan struct{}),
	}
	p.writerOnce.Do(p.spawnWriter)
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
	// Own the stderr pipe like stdout: an *os.File is passed to the child as
	// a raw fd, so cmd.Wait never waits for stderr EOF — a descendant that
	// inherited stderr can hold it open without ever blocking a reap. The
	// drain goroutine below is the only reader and is fully detached.
	var stderrR, stderrW *os.File
	var sink *stderrSink
	if opts.StderrPath != "" {
		// Opening the capture sink is part of starting the provider.
		sink, err = openStderrSink(opts.StderrPath)
		if err != nil {
			cancel()
			_ = stdin.Close()
			_ = pr.Close()
			_ = pw.Close()
			return nil, fmt.Errorf("chat: provider stderr sink: %w", err)
		}
		stderrR, stderrW, err = os.Pipe()
		if err != nil {
			cancel()
			_ = stdin.Close()
			_ = pr.Close()
			_ = pw.Close()
			_ = sink.Close()
			return nil, fmt.Errorf("chat: stderr pipe: %w", err)
		}
		cmd.Stderr = stderrW
	}
	if err := cmd.Start(); err != nil {
		cancel()
		_ = pr.Close()
		_ = pw.Close()
		if stderrR != nil {
			_ = stderrR.Close()
			_ = stderrW.Close()
			_ = sink.Close()
		}
		return nil, fmt.Errorf("chat: start %s: %w", opts.Binary, err)
	}
	p.cmd = cmd
	p.stdin = stdin
	p.stdout = pr
	// The child group owns the write ends now; the parent must release them
	// or stdout/stderr never reach EOF when the group dies.
	_ = pw.Close()
	if stderrW != nil {
		_ = stderrW.Close()
		go drainStderr(stderrR, sink)
	}
	go p.watchParent(parent)
	go p.reap()
	return p, nil
}

// spawnWriter constructs the finite-send plumbing and starts the single
// writer goroutine. It runs through writerOnce so a hand-built Process (tests)
// lazily gets the same machinery on its first Send or Close.
func (p *Process) spawnWriter() {
	if p.sendTimeout <= 0 {
		p.sendTimeout = DefaultSendTimeout
	}
	if p.sendQueueDepth <= 0 {
		p.sendQueueDepth = DefaultSendQueueDepth
	}
	if p.writeQueue == nil {
		p.writeQueue = make(chan *writeRequest, p.sendQueueDepth)
	}
	if p.writerClose == nil {
		p.writerClose = make(chan struct{})
	}
	p.writerDone = make(chan struct{})
	go p.writeLoop()
}

func (p *Process) writeLoop() {
	defer close(p.writerDone)
	for {
		select {
		case req := <-p.writeQueue:
			p.writeOne(req)
		case <-p.writerClose:
			// Released by Close: drain whatever is still queued without
			// writing (the provider is being torn down) and exit. Late
			// enqueuers simply time out against their own deadlines.
			for {
				select {
				case req := <-p.writeQueue:
					if err := p.stickyWriteError(); err != nil {
						req.complete(err)
						continue
					}
					req.complete(errors.New("chat: provider write cancelled by close"))
				default:
					return
				}
			}
		}
	}
}

// writeOne handles one dequeued frame. An expired frame is discarded without
// writing — its caller was already released. A frame whose OS write has begun
// is never abandoned: if the provider is wedged, the write stays in flight
// until the provider lifecycle (process death) closes the pipe and returns
// EPIPE, which latches the sticky error and drains the queue.
func (p *Process) writeOne(req *writeRequest) {
	if err := p.stickyWriteError(); err != nil {
		req.complete(err)
		return
	}
	if !req.deadline.IsZero() && time.Now().After(req.deadline) {
		req.complete(p.writeTimeoutError("frame expired before write"))
		return
	}
	// p.stdin is read at write time so a swapped writer (tests) is honored.
	_, err := p.stdin.Write(req.frame)
	if err != nil {
		err = fmt.Errorf("chat: write command: %w", err)
		p.setSticky(err)
	}
	req.complete(err)
}

func (p *Process) setSticky(err error) {
	p.stickyMu.Lock()
	if p.stickyErr == nil {
		p.stickyErr = err
	}
	p.stickyMu.Unlock()
}

func (p *Process) stickyWriteError() error {
	p.stickyMu.Lock()
	defer p.stickyMu.Unlock()
	return p.stickyErr
}

func (p *Process) writeTimeoutError(reason string) error {
	return fmt.Errorf("chat: command not written (%s) within %s: %w (%w)", reason, p.sendTimeout, ErrSendTimeout, context.DeadlineExceeded)
}

// Send marshals cmd into one JSONL frame and hands it to the process's single
// writer goroutine. It then waits for THAT frame's completion under ONE
// absolute deadline that covers both the queue-full wait and the write itself
// — the deadline is never reset once the writer dequeues the frame. A full
// queue and a write that did not complete in time return the same
// errors.Is-able timeout family (ErrSendTimeout and context.DeadlineExceeded).
// A real write error latches and is returned (sticky) to every later sender.
func (p *Process) Send(cmd map[string]any) error {
	b, err := json.Marshal(cmd)
	if err != nil {
		return fmt.Errorf("chat: marshal command: %w", err)
	}
	p.writerOnce.Do(p.spawnWriter)
	if err := p.stickyWriteError(); err != nil {
		return err
	}
	frame := make([]byte, 0, len(b)+1)
	frame = append(frame, b...)
	frame = append(frame, '\n')
	deadline := time.Now().Add(p.sendTimeout)
	req := &writeRequest{frame: frame, deadline: deadline, done: make(chan error, 1)}
	select {
	case p.writeQueue <- req:
	case <-time.After(time.Until(deadline)):
		return p.writeTimeoutError("queue is full")
	}
	select {
	case err := <-req.done:
		return err
	case <-time.After(time.Until(deadline)):
		return p.writeTimeoutError("write did not complete")
	}
}

// stderrSink appends the provider's stderr into a bounded rotating file pair:
// the active file carries at most stderrRotateBytes and is rotated into a
// single backup with the same budget when full (hard total: two files). A
// write crossing the budget boundary is split at the boundary; a single
// chunk larger than the budget keeps only its latest tail beyond the kept
// files. Sink failures are logged once and then degrade to discard-mode so
// the drain can never block the provider.
type stderrSink struct {
	path    string // active file
	backup  string // rotated backup
	file    *os.File
	written int64
	logged  bool
}

// openStderrSink opens the capture sink. A pre-existing active file that
// already exceeds the budget is rotated before start, so a fresh provider
// never appends into an oversized log.
func openStderrSink(path string) (*stderrSink, error) {
	if err := os.MkdirAll(filepath.Dir(path), stderrDirPerm); err != nil {
		return nil, fmt.Errorf("create stderr log directory: %w", err)
	}
	backup := path + ".1"
	if info, err := os.Stat(path); err == nil {
		if info.Size() > stderrRotateBytes {
			// Replaces any previous backup: exactly one is kept.
			if err := os.Rename(path, backup); err != nil {
				return nil, fmt.Errorf("rotate oversized stderr log: %w", err)
			}
		}
	} else if !os.IsNotExist(err) {
		return nil, fmt.Errorf("stat stderr log: %w", err)
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, stderrFilePerm)
	if err != nil {
		return nil, fmt.Errorf("open stderr log: %w", err)
	}
	_ = f.Chmod(stderrFilePerm)
	info, err := f.Stat()
	if err != nil {
		_ = f.Close()
		return nil, fmt.Errorf("stat stderr log: %w", err)
	}
	return &stderrSink{path: path, backup: backup, file: f, written: info.Size()}, nil
}

// Write implements io.Writer for the stderr drain. It always consumes the
// whole chunk and never returns an error: the first sink failure logs once
// and switches the sink to discard mode so the drain goroutine keeps reading
// and the provider can never block on its stderr.
func (s *stderrSink) Write(p []byte) (int, error) {
	total := len(p)
	for len(p) > 0 {
		if s.file == nil {
			return total, nil
		}
		space := stderrRotateBytes - s.written
		if space <= 0 {
			if !s.rotate() {
				return total, nil
			}
			continue
		}
		n := len(p)
		if int64(n) > space {
			n = int(space)
		}
		written, err := s.file.Write(p[:n])
		s.written += int64(written)
		if err != nil {
			s.fail(err)
			return total, nil
		}
		p = p[written:]
		if s.written >= stderrRotateBytes && !s.rotate() {
			return total, nil
		}
	}
	return total, nil
}

// rotate moves the active file to the single backup slot and starts a fresh
// one. It returns false (and latches the failure) when capture cannot
// continue.
func (s *stderrSink) rotate() bool {
	_ = s.file.Close()
	s.file = nil
	if err := os.Rename(s.path, s.backup); err != nil && !os.IsNotExist(err) {
		s.fail(err)
		return false
	}
	f, err := os.OpenFile(s.path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, stderrFilePerm)
	if err != nil {
		s.fail(err)
		return false
	}
	_ = f.Chmod(stderrFilePerm)
	s.file = f
	s.written = 0
	return true
}

// fail logs the first sink error once (structured) and discards everything
// after it.
func (s *stderrSink) fail(err error) {
	if s.logged {
		return
	}
	s.logged = true
	slog.Warn("provider stderr capture failed; discarding provider stderr", "path", s.path, "err", err)
}

// Close flushes the sink boundary: it closes the active file and stops all
// further capture. Called only by the drain goroutine at EOF.
func (s *stderrSink) Close() error {
	if s.file == nil {
		return nil
	}
	err := s.file.Close()
	s.file = nil
	return err
}

// drainStderr copies the provider's stderr into the rotating sink until EOF.
// It is fully detached from the reaper: cmd.Wait never observes this pipe,
// so nothing here can delay an exit; a sink failure degrades to discard
// mode inside Write.
func drainStderr(src *os.File, sink *stderrSink) {
	_, _ = io.Copy(sink, src)
	_ = src.Close()
	_ = sink.Close()
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

// Close kills the process group and reaps the leader, then reaps the stdin
// writer goroutine. The writer is released by both hands: closing
// writerClose ends its select loop, and the group kill closes the pipe read
// end, so any in-flight OS write returns EPIPE and the queue drains. A
// wedged writer therefore never outlives Close (the syscall release belongs
// to the provider lifecycle, not to any caller deadline).
func (p *Process) Close() error {
	p.writerOnce.Do(p.spawnWriter)
	p.closeWriterOnce.Do(func() { close(p.writerClose) })
	p.cancelWith("session_close")
	<-p.exited
	<-p.writerDone
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
