package chat

import (
	"context"
	"encoding/json"
	"io"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type commandPipe struct {
	commands chan []byte
}

func (p *commandPipe) Write(b []byte) (int, error) {
	copyOfB := append([]byte(nil), b...)
	p.commands <- copyOfB
	return len(b), nil
}

func (p *commandPipe) Close() error { return nil }

func fakeSharedProvider(commands chan []byte) *sharedProvider {
	p := &sharedProvider{
		proc:     &Process{stdin: &commandPipe{commands: commands}},
		state:    sharedProviderStarted,
		sessions: make(map[string]*sessionRoute),
		pending:  make(map[string]pendingProviderRequest),
		requests: make(map[string]*sessionRoute),
		done:     make(chan struct{}),
	}
	// Synthetic providers have no process pump to publish shutdown. Model the
	// constructor's close contract instead of exposing a partial Process to
	// asynchronous Manager release.
	p.closeProcess = func() error {
		close(p.done)
		return nil
	}
	return p
}

func decodeCommand(t *testing.T, raw []byte) map[string]any {
	t.Helper()
	var cmd map[string]any
	if err := json.Unmarshal(raw, &cmd); err != nil {
		t.Fatalf("decode command %q: %v", raw, err)
	}
	return cmd
}

type gateWriter struct {
	entered chan struct{}
	release chan struct{}
	once    sync.Once
}

func (w *gateWriter) WriteJSON([]byte) error {
	w.once.Do(func() { close(w.entered) })
	<-w.release
	return nil
}

func TestSharedProviderQueueOverflowWhileLifecycleDeliveryBlockedDoesNotStallPump(t *testing.T) {
	commands := make(chan []byte, 4)
	provider := fakeSharedProvider(commands)
	manager := NewManager()
	manager.provider = provider
	defer func() {
		manager.mu.Lock()
		manager.provider = nil
		manager.sessions = make(map[string]*Session)
		manager.pending = make(map[string]bool)
		manager.mu.Unlock()
		manager.CloseAll()
	}()

	writer := &gateWriter{entered: make(chan struct{}), release: make(chan struct{})}
	defer close(writer.release)
	session := newTestSession("overflow", nil)
	session.owner = manager
	session.shared = provider
	session.routingHandle = "route-overflow"
	session.onExit = func(source *Session) { manager.StopIfCurrent(source.ID(), source) }
	session.Attach(writer)
	route := &sessionRoute{session: session, handle: session.routingHandle, queue: make(chan sessionDelivery, sessionQueueSize), ready: make(chan struct{})}
	provider.sessions[route.handle] = route
	manager.sessions[session.ID()] = session

	siblingWriter := newCollectWriter()
	sibling := newTestSession("sibling", siblingWriter)
	sibling.shared = provider
	sibling.routingHandle = "route-sibling"
	siblingRoute := &sessionRoute{session: sibling, handle: sibling.routingHandle, queue: make(chan sessionDelivery, sessionQueueSize), ready: make(chan struct{})}
	provider.sessions[siblingRoute.handle] = siblingRoute
	manager.sessions[sibling.ID()] = sibling
	go siblingRoute.run()
	siblingRoute.activate()

	go route.run()
	route.activate()
	// agent_start publishes run.started while holding lifecycleMu. This is the
	// real lifecycle delivery that previously wedged overflow handling.
	route.queue <- sessionDelivery{event: &Event{Type: "agent_start", Raw: json.RawMessage(`{"type":"agent_start"}`)}}
	<-writer.entered
	if session.lifecycleMu.TryLock() {
		session.lifecycleMu.Unlock()
		t.Fatal("blocked lifecycle delivery did not hold lifecycleMu")
	}
	for i := 0; i < sessionQueueSize; i++ {
		route.queue <- sessionDelivery{event: &Event{Type: "decode_error", Raw: json.RawMessage(`"queued"`)}}
	}

	provider.route(Event{Type: "decode_error", Raw: json.RawMessage(`{"sessionId":"route-overflow"}`)})
	if got := manager.Get(session.ID()); got != nil {
		t.Fatalf("overflowed session remained registered: %p", got)
	}
	<-route.stopped

	// Neither provider-side teardown nor another session's frame may queue
	// behind the blocked lifecycle lock.
	provider.route(Event{Type: "session_info_changed", Raw: json.RawMessage(`{"sessionId":"route-sibling","name":"delivered"}`)})
	siblingWriter.waitForType(t, "chat.name", time.Second)

	acquired := make(chan struct {
		session *Session
		err     error
	}, 1)
	go func() {
		s, _, err := manager.Acquire(context.Background(), SessionOptions{ID: session.ID(), Binary: "unused"})
		acquired <- struct {
			session *Session
			err     error
		}{s, err}
	}()

	for handled := 0; handled < 2; handled++ {
		cmd := decodeCommand(t, <-commands)
		id, _ := cmd["id"].(string)
		switch cmd["type"] {
		case "close_session":
			provider.route(Event{Type: "response", Raw: json.RawMessage(`{"type":"response","success":true,"id":"` + id + `"}`)})
		case "open_session":
			provider.route(Event{Type: "response", Raw: json.RawMessage(`{"type":"response","success":true,"id":"` + id + `","sessionId":"route-new","data":{"sessionId":"route-new","state":{}}}`)})
		default:
			t.Fatalf("unexpected command: %v", cmd)
		}
	}
	result := <-acquired
	if result.err != nil {
		t.Fatalf("Acquire after overflow: %v", result.err)
	}
	if result.session == session {
		t.Fatal("Acquire returned the overflowed session")
	}
	provider.removeSession("route-new", result.session)
	provider.removeSession("route-sibling", sibling)
}

type closeableGateWriter struct {
	entered  chan struct{}
	closed   chan struct{}
	returned chan struct{}
	closeOne sync.Once
}

func (w *closeableGateWriter) WriteJSON([]byte) error {
	close(w.entered)
	<-w.closed
	close(w.returned)
	return io.ErrClosedPipe
}

func (w *closeableGateWriter) Close() error {
	w.closeOne.Do(func() { close(w.closed) })
	return nil
}

func TestSharedProviderBlockedWriterDoesNotTearDownSession(t *testing.T) {
	commands := make(chan []byte, 1)
	provider := fakeSharedProvider(commands)
	manager := NewManager()
	manager.provider = provider
	defer func() {
		manager.mu.Lock()
		manager.provider = nil
		manager.sessions = make(map[string]*Session)
		manager.pending = make(map[string]bool)
		manager.mu.Unlock()
		manager.CloseAll()
	}()

	writer := &closeableGateWriter{entered: make(chan struct{}), closed: make(chan struct{}), returned: make(chan struct{})}
	terminated := make(chan struct{})
	session := newTestSession("delivery-timeout", nil)
	session.owner = manager
	session.shared = provider
	session.routingHandle = "route-timeout"
	session.onExit = func(*Session) { close(terminated) }
	session.Attach(writer)
	route := &sessionRoute{
		session: session, handle: session.routingHandle,
		queue: make(chan sessionDelivery, 1), ready: make(chan struct{}),
		provider: provider,
		// Per-delivery fresh short deadline: dispatch no longer runs the
		// subscriber's WriteJSON inline, so every delivery must complete well
		// inside this window and the timeout teardown must never engage —
		// even with a writer wedged inside WriteJSON the whole time.
		deliveryDeadline: func() <-chan time.Time { return time.After(50 * time.Millisecond) },
	}
	provider.sessions[route.handle] = route
	manager.sessions[session.ID()] = session
	go route.run()
	route.activate()
	t.Cleanup(route.cancel)

	blockedEvent := func() *Event {
		return &Event{Type: "decode_error", Raw: json.RawMessage(`"blocked delivery"`)}
	}
	route.queue <- sessionDelivery{event: blockedEvent()}
	<-writer.entered

	// Saturate the wedged subscriber's FIFO: one frame held inside WriteJSON
	// plus subscriberQueueSize buffered frames, then one more to overflow it.
	// The overflow detaches only that subscriber: its closer releases the
	// wedged writer while the session, route, and provider all survive.
	for i := 0; i < subscriberQueueSize+1; i++ {
		route.queue <- sessionDelivery{event: blockedEvent()}
	}
	select {
	case <-writer.returned:
	case <-time.After(5 * time.Second):
		t.Fatal("overflowed subscriber was never detached and released")
	}

	if got := manager.Get(session.ID()); got != session {
		t.Fatal("session was evicted by a slow subscriber")
	}
	provider.mu.Lock()
	installed := provider.sessions[route.handle]
	provider.mu.Unlock()
	if installed != route {
		t.Fatal("route was torn down by a slow subscriber")
	}
	if !session.ProcessAlive() {
		t.Fatal("session did not survive the slow subscriber")
	}
	select {
	case <-terminated:
		t.Fatal("slow subscriber terminated the session")
	default:
	}
	select {
	case <-provider.done:
		t.Fatal("slow subscriber killed the shared provider")
	default:
	}
	select {
	case cmd := <-commands:
		t.Fatalf("unexpected provider command %v; slow subscribers must not close sessions", cmd)
	default:
	}
}

func TestSharedProviderFailedStartAndConcurrentSessionTeardownAreSafe(t *testing.T) {
	failedManager := NewManager()
	t.Cleanup(failedManager.CloseAll)
	if _, _, err := failedManager.Acquire(context.Background(), SessionOptions{ID: "failed-start", Binary: t.TempDir() + "/missing-omo", ProviderContext: context.Background()}); err == nil {
		t.Fatal("provider start unexpectedly succeeded")
	}
	failedManager.mu.Lock()
	published := failedManager.provider
	failedManager.mu.Unlock()
	if published != nil {
		t.Fatalf("failed provider start was published: %p", published)
	}
	// The explicit pre-start state is harmless if shutdown reaches it through
	// synthetic construction or a future constructor refactor.
	if err := (&sharedProvider{}).close(); err != nil {
		t.Fatalf("close unstarted provider: %v", err)
	}

	provider := fakeSharedProvider(make(chan []byte, 1))
	closeEntered := make(chan struct{})
	allowClose := make(chan struct{})
	var closeCalls atomic.Int32
	provider.closeProcess = func() error {
		if closeCalls.Add(1) == 1 {
			close(closeEntered)
		}
		<-allowClose
		close(provider.done)
		return nil
	}

	manager := NewManager()
	t.Cleanup(manager.CloseAll)
	manager.provider = provider
	first := newTestSession("release-first", nil)
	second := newTestSession("release-second", nil)
	manager.sessions[first.ID()] = first
	manager.sessions[second.ID()] = second

	start := make(chan struct{})
	released := make(chan struct{}, 2)
	for _, session := range []*Session{first, second} {
		go func() {
			<-start
			manager.sessionClosed(session)
			released <- struct{}{}
		}()
	}
	close(start)
	<-released
	<-released
	select {
	case <-closeEntered:
		t.Fatal("concurrent session teardown started shared provider shutdown")
	default:
	}
	manager.mu.Lock()
	published = manager.provider
	manager.mu.Unlock()
	if published != provider {
		t.Fatalf("concurrent session teardown unpublished provider: got %p, want %p", published, provider)
	}

	// Server shutdown remains the provider lifetime boundary. A concurrent
	// direct close must join that shutdown rather than invoke Process.Close
	// again.
	managerClosed := make(chan struct{})
	go func() {
		manager.CloseAll()
		close(managerClosed)
	}()
	<-closeEntered
	joined := make(chan struct{})
	go func() {
		_ = provider.close()
		close(joined)
	}()
	close(allowClose)
	<-managerClosed
	<-joined
	if got := closeCalls.Load(); got != 1 {
		t.Fatalf("process close calls = %d, want 1", got)
	}
}

func TestManagerLockOrderAllowsProviderExitDuringBlockedSweepAcquireAndClose(t *testing.T) {
	provider := fakeSharedProvider(make(chan []byte, 1))
	manager := NewManager()
	t.Cleanup(manager.CloseAll)
	manager.provider = provider
	manager.idleFor = 0

	session := newTestSession("lock-order", nil)
	session.owner = manager
	session.shared = provider
	session.runDone = true
	session.finishedAt = time.Now().Add(-time.Second)
	manager.sessions[session.ID()] = session

	reapReachedLifecycle := make(chan struct{})
	var hookOnce sync.Once
	manager.beforeReapLifecycle = func() {
		hookOnce.Do(func() { close(reapReachedLifecycle) })
	}

	// Hold lifecycleMu while sweep reaches the lifecycle boundary. The manager
	// lock must remain available to provider exit, acquire, and close paths.
	session.lifecycleMu.Lock()
	sweepDone := make(chan struct{})
	go func() {
		manager.sweepOnce()
		close(sweepDone)
	}()
	<-reapReachedLifecycle

	acquireDone := make(chan struct{})
	go func() {
		_, _, _ = manager.Acquire(context.Background(), SessionOptions{ID: session.ID(), Binary: t.TempDir() + "/missing-omo"})
		close(acquireDone)
	}()
	closeDone := make(chan struct{})
	go func() {
		_ = session.Close()
		close(closeDone)
	}()
	providerExitDone := make(chan struct{})
	go func() {
		manager.providerExited(provider, providerTermination{kind: providerTerminationUnexpected, summary: "lock-order test", sessions: []*Session{session}})
		close(providerExitDone)
	}()

	select {
	case <-providerExitDone:
		// Provider exit made progress while lifecycleMu remained held.
	case <-time.After(time.Second):
		session.lifecycleMu.Unlock()
		t.Fatal("provider exit blocked behind sweep holding Manager.mu")
	}
	session.lifecycleMu.Unlock()

	for name, done := range map[string]<-chan struct{}{
		"acquire": acquireDone,
		"close":   closeDone,
		"sweep":   sweepDone,
	} {
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Fatalf("%s did not complete after lifecycle release", name)
		}
	}

	// Prove the shutdown handshake itself does not acquire Manager.mu before
	// sweepDone. CloseAll may take the lock only after this exact signal.
	shutdownManager := NewManager()
	shutdownManager.mu.Lock()
	handshakeDone := make(chan struct{})
	shutdownManager.afterSweepStopped = func() { close(handshakeDone) }
	shutdownDone := make(chan struct{})
	go func() {
		shutdownManager.CloseAll()
		close(shutdownDone)
	}()
	select {
	case <-handshakeDone:
	case <-time.After(time.Second):
		shutdownManager.mu.Unlock()
		t.Fatal("sweep shutdown handshake waited while holding Manager.mu")
	}
	shutdownManager.mu.Unlock()
	select {
	case <-shutdownDone:
	case <-time.After(time.Second):
		t.Fatal("CloseAll did not complete after Manager.mu was released")
	}
}

func TestSharedProviderCloseResponseTimeoutCleansRouteAndLeavesSiblingWritable(t *testing.T) {
	commands := make(chan []byte, 2)
	provider := fakeSharedProvider(commands)
	deadline := make(chan time.Time, 1)
	provider.closeDeadline = func() <-chan time.Time { return deadline }
	sendCompleted := make(chan struct{})
	provider.afterCloseSend = func() { close(sendCompleted) }

	closing := newTestSession("closing", nil)
	closing.shared = provider
	closing.routingHandle = "route-closing"
	closingRoute := &sessionRoute{session: closing, handle: closing.routingHandle, queue: make(chan sessionDelivery, 1), ready: make(chan struct{})}
	provider.sessions[closingRoute.handle] = closingRoute
	go closingRoute.run()
	closingRoute.activate()

	sibling := newTestSession("sibling", nil)
	sibling.shared = provider
	sibling.routingHandle = "route-sibling"
	siblingRoute := &sessionRoute{session: sibling, handle: sibling.routingHandle, queue: make(chan sessionDelivery, 1), ready: make(chan struct{})}
	provider.sessions[siblingRoute.handle] = siblingRoute
	go siblingRoute.run()
	siblingRoute.activate()

	closed := make(chan error, 1)
	go func() { closed <- provider.closeSession(closing) }()
	closeCmd := decodeCommand(t, <-commands)
	if closeCmd["type"] != "close_session" {
		t.Fatalf("command type = %v, want close_session", closeCmd["type"])
	}
	// commandPipe receiving the bytes only proves Write's channel send. This
	// post-Send signal proves sendResult is populated before the response
	// deadline fires, so only the response-timeout branch is selectable.
	<-sendCompleted
	deadline <- time.Now()
	if err := <-closed; err == nil || !strings.Contains(err.Error(), "response timed out") {
		t.Fatalf("close error = %v, want response timeout", err)
	}
	provider.mu.Lock()
	leaked := provider.sessions["route-closing"]
	provider.mu.Unlock()
	if leaked != nil {
		t.Fatal("timed-out close left its route installed")
	}
	if closing.routingHandle != "" {
		t.Fatalf("routing handle = %q after timeout, want empty", closing.routingHandle)
	}

	if err := provider.send(sibling, map[string]any{"type": "get_state"}); err != nil {
		t.Fatalf("sibling send after timeout: %v", err)
	}
	siblingCmd := decodeCommand(t, <-commands)
	if siblingCmd["type"] != "get_state" || siblingCmd["sessionId"] != "route-sibling" {
		t.Fatalf("sibling command = %v", siblingCmd)
	}
	provider.removeSession("route-sibling", sibling)
}

func TestManagerProviderExitBetweenOpenAndRegistrationRejectsStaleSession(t *testing.T) {
	commands := make(chan []byte, 1)
	provider := fakeSharedProvider(commands)
	manager := NewManager()
	manager.provider = provider
	reached := make(chan struct{})
	release := make(chan struct{})
	manager.beforeOpenRegister = func() {
		close(reached)
		<-release
	}
	defer func() {
		manager.mu.Lock()
		manager.provider = nil
		manager.sessions = make(map[string]*Session)
		manager.pending = make(map[string]bool)
		manager.mu.Unlock()
		manager.CloseAll()
	}()

	result := make(chan error, 1)
	go func() {
		_, _, err := manager.Acquire(context.Background(), SessionOptions{ID: "opening", Binary: "unused"})
		result <- err
	}()
	cmd := decodeCommand(t, <-commands)
	id, _ := cmd["id"].(string)
	provider.route(Event{Type: "response", Raw: json.RawMessage(`{"type":"response","success":true,"id":"` + id + `","sessionId":"route-opening","data":{"sessionId":"route-opening","state":{}}}`)})
	<-reached

	provider.mu.Lock()
	route := provider.sessions["route-opening"]
	delete(provider.sessions, "route-opening")
	provider.mu.Unlock()
	if route == nil {
		t.Fatal("open response did not install its route")
	}
	manager.providerExited(provider, providerTermination{kind: providerTerminationUnexpected, summary: "test exit", sessions: []*Session{route.session}})
	go route.terminate(providerTermination{kind: providerTerminationUnexpected, summary: "test exit"})
	close(release)

	if err := <-result; err == nil || !strings.Contains(err.Error(), "ended while opening") {
		t.Fatalf("Acquire error = %v, want provider-ended error", err)
	}
	if got := manager.Get("opening"); got != nil {
		t.Fatalf("stale opening session was registered: %p", got)
	}
}

func TestManagerRegistrationRefusedWhileSharedProviderClosing(t *testing.T) {
	commands := make(chan []byte, 1)
	provider := fakeSharedProvider(commands)
	closeEntered := make(chan struct{})
	finishClose := make(chan struct{})
	provider.closeProcess = func() error {
		close(closeEntered)
		<-finishClose
		close(provider.done)
		return nil
	}

	manager := NewManager()
	manager.provider = provider
	registerReached := make(chan struct{})
	registerRelease := make(chan struct{})
	manager.beforeOpenRegister = func() {
		close(registerReached)
		<-registerRelease
	}
	defer func() {
		manager.mu.Lock()
		manager.provider = nil
		manager.sessions = make(map[string]*Session)
		manager.pending = make(map[string]bool)
		manager.mu.Unlock()
		manager.CloseAll()
	}()

	result := make(chan error, 1)
	go func() {
		_, _, err := manager.Acquire(context.Background(), SessionOptions{ID: "opening-during-close", Binary: "unused"})
		result <- err
	}()
	openCmd := decodeCommand(t, <-commands)
	id, _ := openCmd["id"].(string)
	provider.route(Event{Type: "response", Raw: json.RawMessage(`{"type":"response","success":true,"id":"` + id + `","sessionId":"route-closing-open","data":{"sessionId":"route-closing-open","state":{}}}`)})
	<-registerReached

	closed := make(chan struct{})
	go func() {
		_ = provider.close()
		close(closed)
	}()
	<-closeEntered
	provider.mu.Lock()
	state := provider.state
	provider.mu.Unlock()
	if state != sharedProviderClosing {
		t.Fatalf("provider state = %v, want closing", state)
	}

	close(registerRelease)
	if err := <-result; err == nil || !strings.Contains(err.Error(), "ended while opening") {
		t.Fatalf("Acquire error = %v, want provider-ended error", err)
	}
	if got := manager.Get("opening-during-close"); got != nil {
		t.Fatalf("session was registered on closing provider: %p", got)
	}

	close(finishClose)
	<-closed
	provider.mu.Lock()
	var opened *sessionRoute
	for _, route := range provider.sessions {
		opened = route
	}
	provider.mu.Unlock()
	if opened != nil {
		provider.removeSession(opened.handle, opened.session)
	}
}

type orderedGateWriter struct {
	entered chan struct{}
	release chan struct{}
	mu      sync.Mutex
	frames  [][]byte
	once    sync.Once
}

func (w *orderedGateWriter) WriteJSON(frame []byte) error {
	w.once.Do(func() {
		close(w.entered)
		<-w.release
	})
	w.mu.Lock()
	w.frames = append(w.frames, append([]byte(nil), frame...))
	w.mu.Unlock()
	return nil
}

func TestSessionRouteDrainsQueuedFramesBeforeTerminalFrame(t *testing.T) {
	writer := &orderedGateWriter{entered: make(chan struct{}), release: make(chan struct{})}
	session := newTestSession("ordered", nil)
	delivered := make(chan struct{})
	session.onExit = func(*Session) { close(delivered) }
	session.Attach(writer)
	route := &sessionRoute{session: session, handle: "ordered-route", queue: make(chan sessionDelivery, 2), ready: make(chan struct{})}
	go route.run()
	route.activate()
	route.queue <- sessionDelivery{event: &Event{Type: "decode_error", Raw: json.RawMessage(`"first"`)}}
	<-writer.entered
	route.queue <- sessionDelivery{event: &Event{Type: "decode_error", Raw: json.RawMessage(`"second"`)}}
	terminated := make(chan struct{})
	go func() {
		route.terminate(providerTermination{kind: providerTerminationUnexpected, summary: "terminal"})
		close(terminated)
	}()
	close(writer.release)
	<-terminated
	// The callback is the exact signal that the worker delivered its final
	// item; no sleep or polling is involved.
	<-delivered

	writer.mu.Lock()
	frames := append([][]byte(nil), writer.frames...)
	writer.mu.Unlock()
	if len(frames) != 3 {
		t.Fatalf("delivered %d frames, want 3", len(frames))
	}
	var messages []string
	var codes []string
	for _, raw := range frames {
		var frame ErrorFrame
		if err := json.Unmarshal(raw, &frame); err != nil {
			t.Fatalf("decode frame: %v", err)
		}
		messages = append(messages, frame.Message)
		codes = append(codes, frame.Code)
	}
	if messages[0] != "first" || messages[1] != "second" || codes[2] != "pi_eof" {
		t.Fatalf("delivery order messages=%v codes=%v", messages, codes)
	}
}

var _ io.WriteCloser = (*commandPipe)(nil)
