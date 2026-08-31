package chat

import (
	"context"
	"encoding/json"
	"io"
	"os/exec"
	"sync"
	"testing"
	"time"
)

type cancellableBlockingPipe struct {
	started chan struct{}
	release chan struct{}
	once    sync.Once
}

func (p *cancellableBlockingPipe) Write([]byte) (int, error) {
	p.once.Do(func() { close(p.started) })
	<-p.release
	return 0, io.ErrClosedPipe
}

func (p *cancellableBlockingPipe) Close() error {
	select {
	case <-p.release:
	default:
		close(p.release)
	}
	return nil
}

// A cancelled open must be local to the open that is being cancelled: the
// provider wedged mid-write stays wedged for impl-A to unblock, but the
// cancellation itself must not terminate the process and mass-evict every
// sibling session. RED until impl-B removes the p.close escalation from the
// open write cancel arm (shared_provider_requests.go).
func TestOpenSessionWriteCancellationIsLocal(t *testing.T) {
	pipe := &cancellableBlockingPipe{started: make(chan struct{}), release: make(chan struct{})}
	// Releases the wedged writer once the assertions are done so the abandoned
	// Send goroutine can drain; a no-op when the provider was (wrongly) killed,
	// because closeProcess below already released it.
	defer pipe.Close()
	provider := &sharedProvider{
		proc:     &Process{stdin: pipe},
		state:    sharedProviderStarted,
		sessions: make(map[string]*sessionRoute),
		pending:  make(map[string]pendingProviderRequest),
		requests: make(map[string]*sessionRoute),
		done:     make(chan struct{}),
	}
	provider.closeProcess = func() error {
		_ = pipe.Close()
		close(provider.done)
		return nil
	}

	ctx, cancel := context.WithCancel(context.Background())
	openResult := make(chan error, 1)
	go func() {
		openResult <- provider.openSession(ctx, newTestSession("blocked-open", nil), SessionOptions{Cwd: t.TempDir()})
	}()
	<-pipe.started
	cancel()
	select {
	case err := <-openResult:
		if err == nil || err != context.Canceled {
			t.Fatalf("open error = %v, want context canceled", err)
		}
	case <-time.After(time.Second):
		t.Fatal("cancelled open remained blocked in Process.Send")
	}
	select {
	case <-provider.done:
		t.Fatal("cancelled open write terminated the shared provider: one session's cancelled open mass-evicted every sibling (RED: open cancel arm calls p.close)")
	default:
	}
	provider.mu.Lock()
	state := provider.state
	pending := len(provider.pending)
	provider.mu.Unlock()
	if state != sharedProviderStarted {
		t.Fatalf("provider state after cancelled open = %d, want still started", state)
	}
	if pending != 0 {
		t.Fatalf("cancelled open left %d pending requests", pending)
	}
}

type channelBlockingWriter struct {
	entered chan struct{}
	release chan struct{}
}

func (w *channelBlockingWriter) WriteJSON([]byte) error {
	select {
	case <-w.entered:
	default:
		close(w.entered)
	}
	<-w.release
	return nil
}

func TestSharedProviderBlockedSessionWriterDoesNotStallAnotherSession(t *testing.T) {
	blocked := &channelBlockingWriter{entered: make(chan struct{}), release: make(chan struct{})}
	defer close(blocked.release)
	writerB := newCollectWriter()
	sessionA := newTestSession("chat-blocked", nil)
	sessionA.Attach(blocked)
	sessionB := newTestSession("chat-free", writerB)

	routeA := &sessionRoute{session: sessionA, queue: make(chan sessionDelivery, sessionQueueSize), ready: make(chan struct{})}
	routeB := &sessionRoute{session: sessionB, queue: make(chan sessionDelivery, sessionQueueSize), ready: make(chan struct{})}
	close(routeA.ready)
	close(routeB.ready)
	go routeA.run()
	go routeB.run()
	provider := &sharedProvider{
		sessions: map[string]*sessionRoute{"route-a": routeA, "route-b": routeB},
		pending:  make(map[string]pendingProviderRequest),
		requests: make(map[string]*sessionRoute),
	}

	provider.route(Event{Type: "session_info_changed", Raw: json.RawMessage(`{"type":"session_info_changed","sessionId":"route-a","name":"blocked"}`)})
	<-blocked.entered
	provider.route(Event{Type: "session_info_changed", Raw: json.RawMessage(`{"type":"session_info_changed","sessionId":"route-b","name":"delivered"}`)})
	writerB.waitForType(t, "chat.name", time.Second)
}

func TestSharedProviderCloseSessionWaitsForProviderResponse(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skipf("node not in PATH: %v", err)
	}
	script := `let b='';
const send=x=>process.stdout.write(JSON.stringify(x)+'\n');
process.stdin.on('data',c=>{b+=c;for(let n=b.indexOf('\n');n>=0;n=b.indexOf('\n')){const line=b.slice(0,n);b=b.slice(n+1);if(!line)continue;const x=JSON.parse(line);
if(x.type==='open_session')send({type:'response',command:'open_session',success:true,id:x.id,sessionId:'route-1',data:{sessionId:'route-1',state:{sessionId:'durable-1'}}});
else if(x.type==='close_session')send({type:'session_info_changed',sessionId:'route-1',name:'close-received',closeId:x.id});
else if(x.type==='release_close')send({type:'response',command:'close_session',success:true,id:x.closeId,sessionId:'route-1'});
}});`
	manager := NewManager()
	t.Cleanup(manager.CloseAll)
	writer := newCollectWriter()
	session, _, _, err := manager.AcquireAttach(context.Background(), SessionOptions{ID: "chat-close-ack", Binary: node, Args: []string{"-e", script, "--"}, ProviderContext: context.Background()}, writer)
	if err != nil {
		t.Fatal(err)
	}
	provider := session.shared
	closed := make(chan struct{})
	go func() {
		manager.Stop(session.ID())
		close(closed)
	}()
	writer.waitForType(t, "chat.name", time.Second)
	select {
	case <-closed:
		t.Fatal("session was released before close_session response")
	default:
	}

	provider.mu.Lock()
	var closeID string
	for id := range provider.pending {
		closeID = id
	}
	provider.mu.Unlock()
	if closeID == "" {
		t.Fatal("close_session request was not pending")
	}
	if err := provider.proc.Send(map[string]any{"type": "release_close", "closeId": closeID}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("session was not released after close_session response")
	}
}

func TestManagerProviderDeathEvictsWhileLifecycleDeliveryBlocked(t *testing.T) {
	manager := NewManager()
	t.Cleanup(manager.CloseAll)
	provider := &sharedProvider{}
	blocked := &channelBlockingWriter{entered: make(chan struct{}), release: make(chan struct{})}
	defer close(blocked.release)
	old := newTestSession("chat-old-provider", nil)
	old.shared = provider
	old.routingHandle = "old-route"
	old.owner = manager
	old.Attach(blocked)
	route := &sessionRoute{session: old, handle: old.routingHandle, queue: make(chan sessionDelivery, 1), ready: make(chan struct{})}
	manager.provider = provider
	manager.sessions[old.ID()] = old
	go route.run()
	route.activate()
	route.queue <- sessionDelivery{event: &Event{Type: "agent_start", Raw: json.RawMessage(`{"type":"agent_start"}`)}}
	<-blocked.entered
	if old.lifecycleMu.TryLock() {
		old.lifecycleMu.Unlock()
		t.Fatal("blocked lifecycle delivery did not hold lifecycleMu")
	}

	termination := providerTermination{kind: providerTerminationUnexpected, summary: "test death", sessions: []*Session{old}}
	exited := make(chan struct{})
	go func() {
		manager.providerExited(provider, termination)
		close(exited)
	}()
	// Completion is an exact signal that global provider teardown did not wait
	// for the lifecycle lock held by the wedged client delivery.
	<-exited
	go route.terminate(termination)
	if got := manager.Get(old.ID()); got != nil {
		t.Fatalf("dead session remained acquirable: %p", got)
	}
	fresh, started, err := manager.Acquire(context.Background(), managedMockOptions(t, "chat-fresh-provider"))
	if err != nil {
		t.Fatal(err)
	}
	if !started || fresh.shared == provider {
		t.Fatalf("acquire returned dead provider session: started=%v shared=%p dead=%p", started, fresh.shared, provider)
	}
}

func TestSharedProviderTerminationPreservesDecodeAndIntentionalKinds(t *testing.T) {
	decodeWriter := newCollectWriter()
	decodeExited := make(chan struct{})
	decodeSession := newTestSession("chat-decode", decodeWriter)
	decodeSession.onExit = func(*Session) { close(decodeExited) }
	decodeSession.providerExited(providerTermination{kind: providerTerminationDecodeFailed, message: "bad provider JSON"})
	<-decodeExited
	frames := decodeWriter.snapshot()
	if len(frames) != 1 {
		t.Fatalf("decode termination frames = %d, want exactly one", len(frames))
	}
	var decodeError ErrorFrame
	if err := json.Unmarshal(frames[0], &decodeError); err != nil || decodeError.Code != "decode_failed" {
		t.Fatalf("decode termination frame = %s, want decode_failed", frames[0])
	}

	intentionalWriter := newCollectWriter()
	intentionalSession := newTestSession("chat-shutdown", intentionalWriter)
	intentionalSession.providerExited(providerTermination{kind: providerTerminationIntentional, summary: "cancelled by parent"})
	if frames := intentionalWriter.snapshot(); len(frames) != 0 {
		t.Fatalf("intentional shutdown emitted frames: %s", intentionalWriter.typesString())
	}
}
