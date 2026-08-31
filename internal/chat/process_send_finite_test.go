package chat

import (
	"bufio"
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
	"testing"
	"time"
)

// ctxReleasingWedgePipe replaces a process's stdin to simulate a provider
// that stopped draining it: the writer goroutine parks inside the Write
// exactly like a blocked OS pipe write. The park is released by process
// death (ctx cancellation — mirroring the EPIPE a real pipe returns when the
// group kill closes the read end) or by an explicit manual release, which
// reports success so the stream stays usable afterwards.
type ctxReleasingWedgePipe struct {
	proc        *Process
	doRelease   chan struct{}
	releaseOnce sync.Once
	entered     chan struct{}
	enteredOnce sync.Once
}

func (w *ctxReleasingWedgePipe) Write([]byte) (int, error) {
	w.enteredOnce.Do(func() { close(w.entered) })
	select {
	case <-w.proc.ctx.Done():
		return 0, io.ErrClosedPipe
	case <-w.doRelease:
		return 0, nil
	}
}

// release un-wedges the pipe reporting write success, so the stream stays
// usable afterwards. Idempotent.
func (w *ctxReleasingWedgePipe) release() {
	w.releaseOnce.Do(func() { close(w.doRelease) })
}

func (*ctxReleasingWedgePipe) Close() error { return nil }

// parkWriterOnBlockedStdin swaps the process's stdin for a wedge pipe and
// parks the writer goroutine inside one in-flight write. It returns the
// wedge; call release to un-wedge with the stream intact. The wait for the
// writer to enter the pipe is bounded so a regression that never reaches the
// write fails the test instead of hanging it.
func parkWriterOnBlockedStdin(t *testing.T, proc *Process) *ctxReleasingWedgePipe {
	t.Helper()
	wedge := &ctxReleasingWedgePipe{proc: proc, doRelease: make(chan struct{}), entered: make(chan struct{})}
	proc.stdin = wedge
	go func() { _ = proc.Send(map[string]any{"type": "wedge"}) }()
	select {
	case <-wedge.entered:
	case <-time.After(10 * time.Second):
		t.Fatal("writer never entered the wedged stdin write")
	}
	return wedge
}

// TestProcessSendFiniteDeadlineBoundedQueueAndWriterReap extends the T2 pin
// (TestProcessSendDeadlineAndBoundedQueue) with the impl-A contract: a short
// injected per-process deadline makes BOTH the first (wedged) OS write and a
// queue-full sender return the same errors.Is-able timeout family, the queue
// never grows past its bound (64 observed), and Close reaps the writer
// goroutine.
func TestProcessSendFiniteDeadlineBoundedQueueAndWriterReap(t *testing.T) {
	node := pinNode(t)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	const deadline = 750 * time.Millisecond
	proc, err := Start(ctx, ProcessOptions{
		Binary:         node,
		Args:           []string{"-e", pinNeverReadScript, "--"},
		Env:            os.Environ(),
		SendTimeout:    deadline,
		SendQueueDepth: DefaultSendQueueDepth,
	})
	if err != nil {
		t.Fatal(err)
	}

	// Wait for the fixture's readiness line so the sends below cannot race
	// process startup; the read deadline only detects failure.
	ready := make(chan error, 1)
	go func() {
		if f, ok := proc.stdout.(interface{ SetReadDeadline(time.Time) error }); ok {
			_ = f.SetReadDeadline(time.Now().Add(10 * time.Second))
		}
		line, err := bufio.NewReader(proc.stdout).ReadString('\n')
		if err != nil {
			ready <- err
			return
		}
		if got := strings.TrimSpace(line); got != "ready" {
			ready <- errors.New("fixture startup line was " + got)
			return
		}
		ready <- nil
	}()
	select {
	case err := <-ready:
		if err != nil {
			t.Fatalf("never-reading fixture never became ready: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("never-reading fixture never became ready")
	}

	// Sender 1 parks the writer inside the OS write (320KiB into a paused
	// fixture). Its caller deadline — not the writer — releases it; a
	// timeout here proves the writer is parked inside an unfinished write.
	firstResult := make(chan error, 1)
	go func() {
		firstResult <- proc.Send(map[string]any{"type": "probe", "padding": strings.Repeat("x", 320*1024)})
	}()
	collectSendResult(t, firstResult, "first in-flight write", 10*time.Second)

	// Senders 2..65 occupy the entire queue behind the in-flight write. The
	// hook is registered before triggering them and acknowledges each exact
	// enqueue boundary; no queue-length polling is needed.
	const queueSends = DefaultSendQueueDepth
	enqueued := make(chan struct{}, queueSends)
	proc.afterEnqueue = func(*writeRequest) { enqueued <- struct{}{} }
	results := make(chan error, queueSends)
	for i := 0; i < queueSends; i++ {
		go func() {
			results <- proc.Send(map[string]any{"type": "queued"})
		}()
	}
	watchdog := time.NewTimer(5 * time.Second)
	defer watchdog.Stop()
	for i := 0; i < queueSends; i++ {
		select {
		case <-enqueued:
		case <-watchdog.C:
			t.Fatalf("writer queue accepted only %d of %d frames", i, queueSends)
		}
	}
	if got := len(proc.writeQueue); got != queueSends {
		t.Fatalf("observed queue length = %d, want the bound %d", got, queueSends)
	}

	// Sender 66 cannot be enqueued: the bounded queue is full.
	overflowResult := make(chan error, 1)
	go func() {
		overflowResult <- proc.Send(map[string]any{"type": "overflow"})
	}()

	// Every sender — the queue-full one and the queued ones alike — returns
	// within finite time with the same timeout family.
	collectSendResult(t, overflowResult, "queue-full sender", 10*time.Second)
	for i := 0; i < queueSends; i++ {
		collectSendResult(t, results, "queued sender", 10*time.Second)
	}

	// Close must reap the writer goroutine: it is released by writerClose
	// and by the group kill's EPIPE on the in-flight write.
	closeResult := make(chan error, 1)
	go func() { closeResult <- proc.Close() }()
	select {
	case err := <-closeResult:
		if err != nil {
			t.Fatalf("close process: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("Close blocked: the writer goroutine was not released")
	}
	select {
	case <-proc.writerDone:
	default:
		t.Fatal("writer goroutine was not reaped after Close")
	}
}

// Zero-value options must mean the documented defaults, asserted by value.
func TestProcessSendZeroValueOptionsMeanDefaults(t *testing.T) {
	if _, err := exec.LookPath("sleep"); err != nil {
		t.Skipf("sleep not in PATH: %v", err)
	}
	proc, err := Start(context.Background(), ProcessOptions{Binary: "sleep", Args: []string{"30"}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = proc.Close() })
	if proc.sendTimeout != DefaultSendTimeout {
		t.Fatalf("zero-value SendTimeout = %v, want %v", proc.sendTimeout, DefaultSendTimeout)
	}
	if DefaultSendTimeout != 10*time.Second {
		t.Fatalf("DefaultSendTimeout = %v, want exactly 10s", DefaultSendTimeout)
	}
	if proc.sendQueueDepth != DefaultSendQueueDepth {
		t.Fatalf("zero-value SendQueueDepth = %d, want %d", proc.sendQueueDepth, DefaultSendQueueDepth)
	}
	if cap(proc.writeQueue) != 64 {
		t.Fatalf("zero-value queue capacity = %d, want exactly 64", cap(proc.writeQueue))
	}
}

func collectSendResult(t *testing.T, result <-chan error, what string, timeout time.Duration) {
	t.Helper()
	select {
	case err := <-result:
		if !errors.Is(err, ErrSendTimeout) {
			t.Fatalf("%s error = %v, want the ErrSendTimeout family", what, err)
		}
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("%s error = %v, want context.DeadlineExceeded in the family", what, err)
		}
	case <-time.After(timeout):
		t.Fatalf("%s did not return within %s (unbounded Send)", what, timeout)
	}
}

type twoStagePipe struct {
	firstEntered  chan struct{}
	firstRelease  chan struct{}
	secondEntered chan struct{}
	secondRelease chan struct{}
	mu            sync.Mutex
	writes        int
}

func (p *twoStagePipe) Write(b []byte) (int, error) {
	p.mu.Lock()
	p.writes++
	n := p.writes
	p.mu.Unlock()
	if n == 1 {
		close(p.firstEntered)
		<-p.firstRelease
	} else {
		close(p.secondEntered)
		<-p.secondRelease
	}
	return len(b), nil
}
func (p *twoStagePipe) Close() error {
	select {
	case <-p.firstRelease:
	default:
		close(p.firstRelease)
	}
	select {
	case <-p.secondRelease:
	default:
		close(p.secondRelease)
	}
	return nil
}

func TestProcessSendDeadlineIncludesSubstantialQueueWait(t *testing.T) {
	const sendDeadline = 240 * time.Millisecond
	pipe := &twoStagePipe{
		firstEntered: make(chan struct{}), firstRelease: make(chan struct{}),
		secondEntered: make(chan struct{}), secondRelease: make(chan struct{}),
	}
	proc := &Process{stdin: pipe, sendTimeout: sendDeadline, sendQueueDepth: 2}
	enqueued := make(chan struct{}, 2)
	proc.afterEnqueue = func(*writeRequest) { enqueued <- struct{}{} }
	proc.writerOnce.Do(proc.spawnWriter)
	defer proc.stopWriter()

	first := make(chan error, 1)
	go func() { first <- proc.Send(map[string]any{"type": "first"}) }()
	select {
	case <-pipe.firstEntered:
	case <-time.After(time.Second):
		t.Fatal("first write never entered")
	}

	// Consume the first Send's enqueue witness before triggering the second.
	select {
	case <-enqueued:
	case <-time.After(time.Second):
		t.Fatal("first frame enqueue was not observed")
	}
	second := make(chan error, 1)
	started := time.Now()
	go func() { second <- proc.Send(map[string]any{"type": "second"}) }()
	select {
	case <-enqueued:
	case <-time.After(time.Second):
		t.Fatal("second frame was not enqueued")
	}

	// Queue residence consumes most of the one absolute budget. Time is the
	// behavior under test; this timer controls dequeue rather than guessing
	// when it happened, and secondEntered witnesses the exact dequeue/write.
	time.AfterFunc(170*time.Millisecond, func() { close(pipe.firstRelease) })
	select {
	case <-pipe.secondEntered:
	case <-time.After(time.Second):
		t.Fatal("second frame was not dequeued after the first write released")
	}
	select {
	case err := <-second:
		if !errors.Is(err, ErrSendTimeout) {
			t.Fatalf("second Send error = %v, want timeout", err)
		}
		if elapsed := time.Since(started); elapsed >= 330*time.Millisecond {
			t.Fatalf("deadline reset after dequeue: Send took %v", elapsed)
		}
	case <-time.After(330 * time.Millisecond):
		t.Fatal("second Send outlived its absolute enqueue-time deadline")
	}
	close(pipe.secondRelease)
	select {
	case err := <-first:
		if err != nil {
			t.Fatalf("first Send: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("first Send did not complete")
	}
}
