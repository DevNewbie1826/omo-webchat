package chat

// RED pins for the shared-provider mass-death defects (provider-mass-death
// DAG, wave1 pin-baseline). Every test here fails against the current code for
// the pinned reason and turns green only after the corresponding
// implementation wave lands:
//
//	T1  TestSharedProviderWedgedCloseIsLocal        close_session write timeout
//	                                                kills the whole provider
//	                                                (p.close at the close write
//	                                                timeout arm)
//	T2  TestProcessSendDeadlineAndBoundedQueue      Process.Send blocks forever
//	                                                in the OS pipe write
//	                                                (writeMu + unbounded
//	                                                stdin.Write)
//	T3  TestSharedProviderSlowOpenIsLocal /         open_session delay/cancel
//	    TestOpenSessionCancellationIsLocal          kills the whole provider
//	                                                (p.close at the open ctx
//	                                                arms)
//	T5  TestManagerAcquireContextDoesNotOwnProvider a nil ProviderContext lets
//	    TestManagerRequiresProviderContextToStart   the acquire context own
//	                                                (and kill) the provider, or
//	                                                starts one silently
//	                                                (manager ctx fallback)
//
// The fixtures are real node subprocesses driven over a loopback TCP control
// socket. Synchronization is signal- and watchdog-based only: control-socket
// messages, channel witnesses, and bounded deadlines. No sleeps, no polling.
//
// Contracts pinned (provider-mass-death ideal-state contract):
// (a) no session-scoped action terminates the provider process;
// (b) Send returns within finite time;
// (c) open delay/cancel fails only that open — provider and siblings survive;
// (d) provider lifetime belongs to manager lifecycle only.

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

const pinControlPortEnv = "OMO_PIN_CONTROL_PORT"

// pinControlPauseScript answers the first two open_session requests normally.
// After answering the second open it stops reading stdin entirely (so the OS
// pipe becomes the only buffer) and reports "paused" over the control socket,
// which is the test's signal that any further large write will wedge in the
// kernel rather than be drained by the fixture.
const pinControlPauseScript = `const net=require('net');
const send=x=>process.stdout.write(JSON.stringify(x)+'\n');
const sock=net.connect(Number(process.env.` + pinControlPortEnv + `),'127.0.0.1',()=>{});
let n=0;
const handle=x=>{
  if(x.type==='open_session'){n++;
    if(n===2){process.stdin.pause();sock.write('paused\n');}
    send({type:'response',command:'open_session',success:true,id:x.id,sessionId:'route-'+n,data:{sessionId:'route-'+n}});
  } else if(x.type==='close_session'){send({type:'response',command:'close_session',success:true,id:x.id,sessionId:x.sessionId});}
};
let b='';
process.stdin.on('data',c=>{b+=c;for(let i;(i=b.indexOf('\n'))>=0;){const l=b.slice(0,i);b=b.slice(i+1);if(!l)continue;try{handle(JSON.parse(l))}catch(e){process.exit(3)}}});
sock.on('error',()=>process.exit(2));`

// pinSlowOpenScript answers the first open_session normally. The second open is
// acknowledged over the control socket ("open-received") but its response is
// delayed far past any caller deadline, so the open fails while the provider
// stays perfectly healthy.
const pinSlowOpenScript = `const net=require('net');
const send=x=>process.stdout.write(JSON.stringify(x)+'\n');
const sock=net.connect(Number(process.env.` + pinControlPortEnv + `),'127.0.0.1',()=>{});
let n=0;
const handle=x=>{
  if(x.type==='open_session'){n++;
    if(n===2){sock.write('open-received\n');setTimeout(()=>send({type:'response',command:'open_session',success:true,id:x.id,sessionId:'route-2',data:{sessionId:'route-2'}}),10000);return;}
    send({type:'response',command:'open_session',success:true,id:x.id,sessionId:'route-'+n,data:{sessionId:'route-'+n}});
  } else if(x.type==='close_session'){send({type:'response',command:'close_session',success:true,id:x.id,sessionId:x.sessionId});}
  else if(x.id){send({type:'session_info_changed',sessionId:x.sessionId,name:x.id});}
};
let b='';
process.stdin.on('data',c=>{b+=c;for(let i;(i=b.indexOf('\n'))>=0;){const l=b.slice(0,i);b=b.slice(i+1);if(!l)continue;try{handle(JSON.parse(l))}catch(e){process.exit(3)}}});
sock.on('error',()=>process.exit(2));`

// pinSimpleFixtureScript answers every open_session and echoes any other
// command carrying an id back to its session. Used where no wedge or stall is
// needed and the test drives plain request/response round-trips.
const pinSimpleFixtureScript = `const send=x=>process.stdout.write(JSON.stringify(x)+'\n');
let n=0;
const handle=x=>{
  if(x.type==='open_session'){n++;send({type:'response',command:'open_session',success:true,id:x.id,sessionId:'route-'+n,data:{sessionId:'route-'+n}});}
  else if(x.id){send({type:'session_info_changed',sessionId:x.sessionId,name:x.id});}
};
let b='';
process.stdin.on('data',c=>{b+=c;for(let i;(i=b.indexOf('\n'))>=0;){const l=b.slice(0,i);b=b.slice(i+1);if(!l)continue;try{handle(JSON.parse(l))}catch(e){process.exit(3)}}});`

// pinNeverReadScript never reads stdin and reports readiness on stdout. Any
// write larger than the OS pipe buffer then blocks forever inside the kernel.
const pinNeverReadScript = `process.stdin.pause();process.stdout.write('ready\n');setInterval(()=>{},1<<30);`

// entrySignalPipe wraps the provider's stdin and signals exactly when a write
// has entered the underlying writer, i.e. when Process.Send holds writeMu and
// is inside the potentially blocking OS write. The signal is what lets a test
// prove the wedge before it fires the next step.
type entrySignalPipe struct {
	inner   io.WriteCloser
	entered chan struct{}
	once    sync.Once
}

func (w *entrySignalPipe) Write(b []byte) (int, error) {
	w.once.Do(func() { close(w.entered) })
	return w.inner.Write(b)
}

func (w *entrySignalPipe) Close() error { return w.inner.Close() }

func pinNode(t *testing.T) string {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skipf("node not in PATH: %v", err)
	}
	return node
}

func pinControlListener(t *testing.T) (net.Listener, int) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("control listener: %v", err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	return listener, listener.Addr().(*net.TCPAddr).Port
}

// awaitControlLine waits for one exact signal line from the fixture over the
// control socket. The read deadline is a failure watchdog, not a pacing sleep.
func awaitControlLine(t *testing.T, conn net.Conn, reader *bufio.Reader, want string) {
	t.Helper()
	if err := conn.SetReadDeadline(time.Now().Add(5 * time.Second)); err != nil {
		t.Fatalf("control socket deadline: %v", err)
	}
	line, err := reader.ReadString('\n')
	if err != nil {
		t.Fatalf("control socket: waiting for %q: %v", want, err)
	}
	if got := strings.TrimSpace(line); got != want {
		t.Fatalf("control socket: got %q, want %q", got, want)
	}
}

// pinWitnessProviderDeath fails the test when the shared provider dies within
// the window. Intentional provider termination (closing / cancelled by parent)
// delivers no terminal frame to session writers, so the provider's done
// channel is the authoritative death witness: the pump closes it only after
// the process has been killed and reaped. The bounded wait is a failure
// watchdog; on the green path it simply elapses.
func pinWitnessProviderDeath(t *testing.T, provider *sharedProvider, why string) {
	t.Helper()
	select {
	case <-provider.done:
		t.Fatal(why)
	case <-time.After(3 * time.Second):
	}
}

// pinProbeSibling proves the sibling session is still usable with one
// synchronous request/response round-trip through the shared provider.
func pinProbeSibling(t *testing.T, manager *Manager, sibling *Session, writer *collectWriter, marker string) {
	t.Helper()
	if manager.Get(sibling.ID()) == nil {
		t.Fatalf("sibling session %s was evicted from the manager", sibling.ID())
	}
	if err := sibling.sendProvider(map[string]any{"type": "probe", "id": marker}); err != nil {
		t.Fatalf("sibling %s could not send after the pinned action: %v", sibling.ID(), err)
	}
	writer.waitFor(t, 5*time.Second, "probe echo "+marker, func(frames [][]byte) bool {
		for _, frame := range frames {
			if bytes.Contains(frame, []byte(marker)) {
				return true
			}
		}
		return false
	})
}

// TestSharedProviderWedgedCloseIsLocal pins contract (a): the close_session
// write timeout of ONE session must stay local to that session. The fixture is
// a real node subprocess shared by two sessions. After the second open it
// stops reading stdin, so one >=256KiB frame wedges Process.Send inside the
// OS pipe write while holding writeMu — exactly the state the current code
// "escapes" by killing the whole provider (the close_session write-timeout arm
// calls p.close). The closing session's deadline is fired manually once the
// wedge is proven; the sibling session and the provider must survive it.
//
// RED today: p.close() kills the provider and mass-evicts the sibling.
// GREEN after impl-B removes the kill. A sibling round-trip "recovery" step is
// deliberately omitted: impl-A's writer never abandons an already in-flight
// write, so the wedged frame keeps the single writer blocked until the fixture
// resumes reading or the process dies. Sibling survival with no recovery step
// is the required pin; a provider left in this state is reclaimed only by the
// manager lifecycle (peer EOF when the fixture dies, idle release, CloseAll),
// never by the failing session.
func TestSharedProviderWedgedCloseIsLocal(t *testing.T) {
	node := pinNode(t)
	listener, port := pinControlListener(t)
	accepted := make(chan net.Conn, 1)
	go func() {
		if conn, err := listener.Accept(); err == nil {
			accepted <- conn
		}
	}()

	manager := NewManager()
	t.Cleanup(manager.CloseAll)

	sibling, _, _, err := manager.AcquireAttach(context.Background(), SessionOptions{
		ID:     "pin-wedge-sibling",
		Binary: node,
		Args:   []string{"-e", pinControlPauseScript, "--"},
		Env:    append(os.Environ(), pinControlPortEnv+"="+strconv.Itoa(port)),
		// The provider lifetime must never hang on a per-acquire context.
		ProviderContext: context.Background(),
	}, newCollectWriter())
	if err != nil {
		t.Fatal(err)
	}
	closing, _, _, err := manager.AcquireAttach(context.Background(), SessionOptions{
		ID:              "pin-wedge-closing",
		Binary:          node,
		ProviderContext: context.Background(),
	}, newCollectWriter())
	if err != nil {
		t.Fatal(err)
	}
	provider := sibling.shared
	if provider == nil || provider != closing.shared {
		t.Fatalf("sessions do not share one provider: sibling=%v closing=%v", sibling.shared, closing.shared)
	}

	// The fixture signals after the second open that stdin is paused: every
	// further byte lands in the OS pipe and can no longer be drained.
	var conn net.Conn
	select {
	case conn = <-accepted:
	case <-time.After(5 * time.Second):
		t.Fatal("fixture never connected its control socket")
	}
	defer func() { _ = conn.Close() }()
	awaitControlLine(t, conn, bufio.NewReader(conn), "paused")

	// One valid JSON frame with >=256KiB padding, sent through a wrapper that
	// signals when the write has entered the OS write. The frame cannot
	// complete — the fixture is paused, alive, and the frame is far larger
	// than any pipe buffer — so entering the write is the wedge.
	wrapper := &entrySignalPipe{inner: provider.proc.stdin, entered: make(chan struct{})}
	provider.proc.stdin = wrapper
	wedgeResult := make(chan error, 1)
	go func() {
		wedgeResult <- provider.proc.Send(map[string]any{"type": "probe", "padding": strings.Repeat("x", 320*1024)})
	}()
	select {
	case <-wrapper.entered:
	case err := <-wedgeResult:
		t.Fatalf("oversized frame returned before blocking (err=%v); the pipe never wedged", err)
	case <-time.After(10 * time.Second):
		t.Fatal("oversized frame never entered the blocking OS write")
	}

	// Fire the closing session's write deadline (the production default is
	// closeSessionTimeout; the channel replaces it with an exact signal).
	deadline := make(chan time.Time, 1)
	provider.closeDeadline = func() <-chan time.Time { return deadline }
	closeResult := make(chan error, 1)
	go func() { closeResult <- provider.closeSession(closing) }()
	deadline <- time.Now()
	select {
	case err := <-closeResult:
		if err == nil || !strings.Contains(err.Error(), "close_session write timed out") {
			t.Fatalf("close error = %v, want local close_session write timeout", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("close_session did not return after its deadline fired")
	}

	// THE PIN: the sibling session and the provider must survive the closing
	// session's write timeout.
	pinWitnessProviderDeath(t, provider,
		"close_session write timeout killed the whole shared provider: one session's stuck write mass-evicted every sibling (RED: close write-timeout arm calls p.close)")
	select {
	case <-provider.proc.exited:
		t.Fatal("provider process was killed by a session-scoped close timeout")
	default:
	}
	provider.mu.Lock()
	siblingRoute := provider.sessions[sibling.routingHandle]
	state := provider.state
	provider.mu.Unlock()
	if state != sharedProviderStarted {
		t.Fatalf("provider state after close timeout = %d, want still started", state)
	}
	if siblingRoute == nil {
		t.Fatalf("sibling route %q was torn down by the closing session's timeout", sibling.routingHandle)
	}
	if manager.Get(sibling.ID()) == nil {
		t.Fatal("sibling session was evicted from the manager by the closing session's timeout")
	}
	if sibling.isDone() {
		t.Fatal("sibling session was ended by the closing session's timeout")
	}
}

// TestProcessSendDeadlineAndBoundedQueue pins contract (b): Process.Send must
// return within finite time even when the provider never reads stdin. The
// fixture is a real node subprocess that pauses stdin immediately; a single
// oversized frame therefore fills the OS pipe and the current Send blocks
// forever inside stdin.Write under writeMu. The 20s guard is the pin:
// crossing it is the defect.
//
// RED today via the guard. impl-A (writer goroutine, bounded queue, per-Send
// deadline) turns this green and is expected to extend the test from this
// point — the assertions here intentionally pin only "returned within 20s" and
// no queue or error-shape internals.
func TestProcessSendDeadlineAndBoundedQueue(t *testing.T) {
	node := pinNode(t)
	proc, err := Start(context.Background(), ProcessOptions{
		Binary: node,
		Args:   []string{"-e", pinNeverReadScript, "--"},
		Env:    os.Environ(),
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = proc.Close() })

	// Wait for the fixture's readiness line so the write below cannot race
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

	sendResult := make(chan error, 1)
	go func() {
		sendResult <- proc.Send(map[string]any{"type": "probe", "padding": strings.Repeat("x", 320*1024)})
	}()
	select {
	case <-sendResult:
		// impl-A extends here: a bounded Send may return (with an error) once
		// its write deadline expires. This pin deliberately stops at
		// finiteness.
	case <-time.After(20 * time.Second):
		t.Fatal("Send did not return within 20s (unbounded blocking write)")
	}
}

// startStalledOpenFixture starts a manager whose provider answers the first
// open_session normally and stalls the second one's response past any short
// caller deadline. It returns the healthy sibling session (with its writer) plus
// a signal function that waits until the stalled open's command reached the
// fixture — proving the write arm completed and the open is waiting on its
// response.
func startStalledOpenFixture(t *testing.T) (manager *Manager, sibling *Session, writer *collectWriter, provider *sharedProvider, awaitOpenReceived func()) {
	t.Helper()
	node := pinNode(t)
	listener, port := pinControlListener(t)
	accepted := make(chan net.Conn, 1)
	go func() {
		if conn, err := listener.Accept(); err == nil {
			accepted <- conn
		}
	}()

	manager = NewManager()
	t.Cleanup(manager.CloseAll)

	writer = newCollectWriter()
	var err error
	sibling, _, _, err = manager.AcquireAttach(context.Background(), SessionOptions{
		ID:     "pin-stall-sibling",
		Binary: node,
		Args:   []string{"-e", pinSlowOpenScript, "--"},
		Env:    append(os.Environ(), pinControlPortEnv+"="+strconv.Itoa(port)),
		// The provider lifetime must never hang on a per-acquire context.
		ProviderContext: context.Background(),
	}, writer)
	if err != nil {
		t.Fatal(err)
	}
	provider = sibling.shared
	if provider == nil {
		t.Fatal("sibling session has no shared provider")
	}

	awaitOpenReceived = func() {
		t.Helper()
		var conn net.Conn
		select {
		case conn = <-accepted:
		case <-time.After(5 * time.Second):
			t.Fatal("fixture never connected its control socket")
		}
		awaitControlLine(t, conn, bufio.NewReader(conn), "open-received")
	}
	return manager, sibling, writer, provider, awaitOpenReceived
}

// TestSharedProviderSlowOpenIsLocal pins contract (c): a provider that is slow
// to answer open_session must fail only that one open. The fixture delays the
// second open's response past a ~500ms caller deadline while the provider
// stays healthy; the sibling session must remain usable.
//
// RED today: the open ctx cancel arm calls p.close() and kills the provider
// for every sibling.
func TestSharedProviderSlowOpenIsLocal(t *testing.T) {
	manager, sibling, writer, provider, awaitOpenReceived := startStalledOpenFixture(t)
	node := pinNode(t)

	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	openResult := make(chan error, 1)
	go func() {
		_, _, _, err := manager.AcquireAttach(ctx, SessionOptions{
			ID:              "pin-slow-open",
			Binary:          node,
			ProviderContext: context.Background(),
		}, newCollectWriter())
		openResult <- err
	}()
	awaitOpenReceived()

	select {
	case err := <-openResult:
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("slow open error = %v, want context deadline exceeded", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("slow open did not fail within its caller deadline")
	}

	// THE PIN: provider and sibling survive one session's open timeout.
	pinWitnessProviderDeath(t, provider,
		"a slow open_session response killed the whole shared provider: one session's open deadline mass-evicted every sibling (RED: open cancel arm calls p.close)")
	select {
	case <-provider.proc.exited:
		t.Fatal("provider process was killed by a session-scoped open deadline")
	default:
	}
	pinProbeSibling(t, manager, sibling, writer, "pin-probe-after-slow-open")
}

// TestOpenSessionCancellationIsLocal pins contract (c) for explicit caller
// cancellation: cancelling the open context after the request reached the
// provider must fail only that open. The control-socket "open-received" signal
// guarantees the cancellation lands in the response-wait arm, not before the
// request was sent.
//
// RED today: the open ctx cancel arm calls p.close() and kills the provider
// for every sibling.
func TestOpenSessionCancellationIsLocal(t *testing.T) {
	manager, sibling, writer, provider, awaitOpenReceived := startStalledOpenFixture(t)
	node := pinNode(t)

	ctx, cancel := context.WithCancel(context.Background())
	openResult := make(chan error, 1)
	go func() {
		_, _, _, err := manager.AcquireAttach(ctx, SessionOptions{
			ID:              "pin-cancelled-open",
			Binary:          node,
			ProviderContext: context.Background(),
		}, newCollectWriter())
		openResult <- err
	}()
	awaitOpenReceived()
	cancel()

	select {
	case err := <-openResult:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("cancelled open error = %v, want context canceled", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("cancelled open did not return")
	}

	// THE PIN: provider and sibling survive one session's cancelled open.
	pinWitnessProviderDeath(t, provider,
		"an open_session cancellation killed the whole shared provider: one session's cancelled open mass-evicted every sibling (RED: open cancel arm calls p.close)")
	select {
	case <-provider.proc.exited:
		t.Fatal("provider process was killed by a session-scoped open cancellation")
	default:
	}
	pinProbeSibling(t, manager, sibling, writer, "pin-probe-after-open-cancel")
}

// TestManagerAcquireContextDoesNotOwnProvider pins contract (d): the per-
// acquire context bounds only that session's open — it must never own the
// provider process lifetime. The provider is started under a manager-owned
// ProviderContext so cancelling the acquire context after open cannot kill it.
func TestManagerAcquireContextDoesNotOwnProvider(t *testing.T) {
	node := pinNode(t)
	manager := NewManager()
	t.Cleanup(manager.CloseAll)

	acquireCtx, cancel := context.WithCancel(context.Background())
	writer := newCollectWriter()
	session, _, _, err := manager.AcquireAttach(acquireCtx, SessionOptions{
		ID:              "pin-ctx-owner",
		Binary:          node,
		Args:            []string{"-e", pinSimpleFixtureScript, "--"},
		Env:             os.Environ(),
		ProviderContext: context.Background(),
	}, writer)
	if err != nil {
		t.Fatal(err)
	}
	provider := session.shared

	cancel()

	// THE PIN: cancelling the acquire context must not terminate the provider.
	pinWitnessProviderDeath(t, provider,
		"cancelling the acquire context killed the shared provider: a per-acquire context owned the provider lifetime (RED: manager acquire-ctx fallback)")
	select {
	case <-provider.proc.exited:
		t.Fatal("provider process was killed by acquire-context cancellation")
	default:
	}
	pinProbeSibling(t, manager, session, writer, "pin-probe-after-ctx-cancel")
}

// TestManagerRequiresProviderContextToStart pins contract (d) at the start
// boundary: starting a brand-new provider without an explicit ProviderContext
// must fail with an explicit error instead of silently binding the provider's
// lifetime to whatever context happened to be at hand.
//
// RED today: the manager falls back to the acquire context and starts the
// provider silently.
func TestManagerRequiresProviderContextToStart(t *testing.T) {
	node := pinNode(t)
	manager := NewManager()
	t.Cleanup(manager.CloseAll)

	session, started, err := manager.Acquire(context.Background(), SessionOptions{
		ID:     "pin-no-provider-ctx",
		Binary: node,
		Args:   []string{"-e", pinSimpleFixtureScript, "--"},
		Env:    os.Environ(),
		// ProviderContext deliberately nil: starting must refuse explicitly.
	})
	if err == nil {
		t.Fatalf("starting a new provider with a nil ProviderContext succeeded (session=%v started=%v); want an explicit error (RED: manager silently falls back to the acquire context)", session, started)
	}
	if started {
		t.Fatal("provider was started despite the missing ProviderContext")
	}
	// The refusal must name the missing requirement: an incidental failure
	// (start error, fixture failure, ctx error) does not satisfy the contract.
	if !strings.Contains(err.Error(), "ProviderContext") {
		t.Fatalf("nil ProviderContext start failed with %q; want an explicit ProviderContext requirement", err)
	}
}
