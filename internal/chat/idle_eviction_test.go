package chat

import (
	"context"
	"encoding/json"
	"strconv"
	"sync"
	"testing"
	"time"
)

func installIdleEvictionTestRoute(provider *sharedProvider, session *Session, handle string) *sessionRoute {
	session.shared = provider
	session.routingHandle = handle
	route := &sessionRoute{
		session:  session,
		handle:   handle,
		queue:    make(chan sessionDelivery, sessionQueueSize),
		ready:    make(chan struct{}),
		provider: provider,
	}
	provider.sessions[handle] = route
	go route.run()
	route.activate()
	return route
}

func emitIdleEviction(provider *sharedProvider, handle string) bool {
	return provider.route(Event{Type: "response", Raw: json.RawMessage(`{"type":"response","command":"close_session","success":true,"data":{},"sessionId":"` + handle + `"}`)})
}

func waitForExit(t *testing.T, exited <-chan *Session) *Session {
	t.Helper()
	select {
	case session := <-exited:
		return session
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for session exit")
		return nil
	}
}

func TestIdleEvictionRemovesSessionAndReopensStoredIdentity(t *testing.T) {
	commands := make(chan []byte, 8)
	provider := fakeSharedProvider(commands)
	manager := NewManager()
	manager.provider = provider

	const storedIdentity = "/tmp/idle-eviction-session.jsonl"
	opens := make(chan map[string]any, 3)
	stopEngine := make(chan struct{})
	go func() {
		nextRoute := 0
		for {
			select {
			case raw := <-commands:
				var cmd map[string]any
				_ = json.Unmarshal(raw, &cmd)
				id, _ := cmd["id"].(string)
				switch cmd["type"] {
				case "open_session":
					nextRoute++
					handle := "route-" + strconv.Itoa(nextRoute)
					opens <- cmd
					stateIdentity := storedIdentity
					provider.route(Event{Type: "response", Raw: json.RawMessage(`{"type":"response","command":"open_session","success":true,"id":"` + id + `","sessionId":"` + handle + `","data":{"sessionId":"` + handle + `","state":{"sessionFile":"` + stateIdentity + `"}}}`)})
				case "get_state":
					handle, _ := cmd["sessionId"].(string)
					provider.route(Event{Type: "response", Raw: json.RawMessage(`{"type":"response","command":"get_state","success":true,"sessionId":"` + handle + `","data":{"messageCount":1}}`)})
				case "close_session":
					provider.route(Event{Type: "response", Raw: json.RawMessage(`{"type":"response","command":"close_session","success":true,"id":"` + id + `"}`)})
				}
			case <-stopEngine:
				return
			}
		}
	}()
	defer close(stopEngine)
	defer manager.CloseAll()

	exited := make(chan *Session, 1)
	first, _, _, err := manager.AcquireAttach(context.Background(), SessionOptions{
		ID: "idle-chat", Binary: "unused", ProviderContext: context.Background(),
		OnExit: func(session *Session) { exited <- session },
	}, newCollectWriter())
	if err != nil {
		t.Fatalf("first AcquireAttach: %v", err)
	}
	<-opens
	if got := first.PiSessionID(); got != storedIdentity {
		t.Fatalf("stored identity = %q, want %q", got, storedIdentity)
	}

	// Keep the shared engine alive after the first logical session is evicted.
	sibling, _, err := manager.Acquire(context.Background(), SessionOptions{ID: "idle-sibling", Binary: "unused"})
	if err != nil {
		t.Fatalf("acquire sibling: %v", err)
	}
	<-opens

	first.mu.Lock()
	oldHandle := first.routingHandle
	first.mu.Unlock()
	if !emitIdleEviction(provider, oldHandle) {
		t.Fatal("idle eviction notice was not routed")
	}
	if got := waitForExit(t, exited); got != first {
		t.Fatalf("exit callback session = %p, want %p", got, first)
	}
	if got := manager.Get(first.ID()); got != nil {
		t.Fatalf("evicted session remained registered: %p", got)
	}
	first.mu.Lock()
	cleared := first.routingHandle
	first.mu.Unlock()
	if cleared != "" {
		t.Fatalf("routing handle after eviction = %q, want empty", cleared)
	}

	reopened, started, _, err := manager.AcquireAttach(context.Background(), SessionOptions{
		ID: first.ID(), Binary: "unused", PiSessionID: first.PiSessionID(),
	}, nil)
	if err != nil {
		t.Fatalf("reopen evicted session: %v", err)
	}
	if !started || reopened == first {
		t.Fatalf("reopen = %p started=%v, want a new logical session", reopened, started)
	}
	reopenCommand := <-opens
	if got := reopenCommand["sessionPath"]; got != storedIdentity {
		t.Fatalf("reopen sessionPath = %#v, want %q", got, storedIdentity)
	}
	if _, exists := reopenCommand["cwd"]; exists {
		t.Fatalf("resume open unexpectedly carried cwd: %v", reopenCommand)
	}

	// Keep the sibling referenced until after the resume assertions.
	if manager.Get(sibling.ID()) != sibling {
		t.Fatal("sibling was evicted with the idle session")
	}
}

func TestIdleEvictionAcquireWaitsForAtomicRouteEviction(t *testing.T) {
	commands := make(chan []byte, 8)
	provider := fakeSharedProvider(commands)
	manager := NewManager()
	manager.provider = provider

	const storedIdentity = "/tmp/idle-eviction-atomic.jsonl"
	opens := make(chan map[string]any, 2)
	stopEngine := make(chan struct{})
	go func() {
		nextRoute := 0
		for {
			select {
			case raw := <-commands:
				var cmd map[string]any
				_ = json.Unmarshal(raw, &cmd)
				id, _ := cmd["id"].(string)
				switch cmd["type"] {
				case "open_session":
					nextRoute++
					handle := "route-atomic-" + strconv.Itoa(nextRoute)
					opens <- cmd
					provider.route(Event{Type: "response", Raw: json.RawMessage(`{"type":"response","command":"open_session","success":true,"id":"` + id + `","sessionId":"` + handle + `","data":{"sessionId":"` + handle + `","state":{"sessionFile":"` + storedIdentity + `"}}}`)})
				case "get_state":
					handle, _ := cmd["sessionId"].(string)
					provider.route(Event{Type: "response", Raw: json.RawMessage(`{"type":"response","command":"get_state","success":true,"sessionId":"` + handle + `","data":{"sessionFile":"` + storedIdentity + `"}}`)})
				case "close_session":
					provider.route(Event{Type: "response", Raw: json.RawMessage(`{"type":"response","command":"close_session","success":true,"id":"` + id + `"}`)})
				}
			case <-stopEngine:
				return
			}
		}
	}()
	defer close(stopEngine)
	defer manager.CloseAll()

	first, _, err := manager.Acquire(context.Background(), SessionOptions{
		ID: "idle-atomic", Binary: "unused", ProviderContext: context.Background(),
	})
	if err != nil {
		t.Fatalf("first Acquire: %v", err)
	}
	<-opens

	// Keep the synthetic provider owned while the old generation retires.
	manager.mu.Lock()
	manager.pending["idle-atomic-provider-lease"] = true
	manager.mu.Unlock()
	defer func() {
		manager.mu.Lock()
		delete(manager.pending, "idle-atomic-provider-lease")
		manager.mu.Unlock()
	}()

	inCriticalSection := make(chan struct{})
	acquireStarted := make(chan struct{})
	managerLockHeld := make(chan bool, 1)
	manager.afterEvictRouteDetached = func() {
		held := !manager.mu.TryLock()
		if !held {
			manager.mu.Unlock()
		}
		managerLockHeld <- held
		close(inCriticalSection)
		<-acquireStarted
	}

	first.mu.Lock()
	handle := first.routingHandle
	first.mu.Unlock()
	if !emitIdleEviction(provider, handle) {
		t.Fatal("idle eviction notice was not routed")
	}
	select {
	case <-inCriticalSection:
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for route eviction critical section")
	}

	acquired := make(chan attachOutcome, 1)
	go func() {
		close(acquireStarted)
		session, started, detach, acquireErr := manager.AcquireAttach(context.Background(), SessionOptions{
			ID: first.ID(), Binary: "unused", PiSessionID: storedIdentity,
		}, nil)
		acquired <- attachOutcome{session: session, started: started, detach: detach, err: acquireErr}
	}()

	got := waitAttach(t, acquired)
	if !<-managerLockHeld {
		t.Error("idle eviction detached its route without holding Manager.mu")
	}
	if got.err != nil {
		t.Fatalf("racing AcquireAttach: %v", got.err)
	}
	if !got.started || got.session == first {
		t.Fatalf("racing acquire = %p started=%v, want a new logical session", got.session, got.started)
	}
	reopenCommand := <-opens
	if got := reopenCommand["sessionPath"]; got != storedIdentity {
		t.Fatalf("racing reopen sessionPath = %#v, want %q", got, storedIdentity)
	}
}

func TestIdleEvictionEvictsBeforePersistenceDrainAndReopensStoredIdentity(t *testing.T) {
	commands := make(chan []byte, 4)
	provider := fakeSharedProvider(commands)
	manager := NewManager()
	manager.provider = provider
	t.Cleanup(func() {
		manager.mu.Lock()
		manager.sessions = make(map[string]*Session)
		manager.generations = make(map[string]*Session)
		manager.generationDone = make(map[string]chan struct{})
		manager.pending = make(map[string]bool)
		manager.provider = nil
		manager.mu.Unlock()
		manager.CloseAll()
		provider.mu.Lock()
		routes := make([]*sessionRoute, 0, len(provider.sessions))
		for handle, installed := range provider.sessions {
			delete(provider.sessions, handle)
			routes = append(routes, installed)
		}
		provider.mu.Unlock()
		for _, installed := range routes {
			installed.activate()
			close(installed.queue)
		}
		_ = provider.close()
	})

	const storedIdentity = "/tmp/idle-eviction-race.jsonl"
	first := newTestSession("idle-race", nil)
	first.owner = manager
	first.shared = provider
	first.routingHandle = "route-idle-race"
	first.piSessionID = storedIdentity
	// The route is buffered because provider.route sends non-blocking: an
	// unbuffered queue whose worker has not parked on its receive yet takes the
	// default branch, which converts the eviction notice into a queue-overflow
	// teardown instead of delivering it. The buffer makes delivery independent
	// of scheduler timing.
	route := &sessionRoute{
		session: first, handle: first.routingHandle,
		queue: make(chan sessionDelivery, 1), ready: make(chan struct{}), provider: provider,
	}
	provider.sessions[route.handle] = route
	manager.sessions[first.ID()] = first
	manager.generations[first.ID()] = first
	manager.generationDone[first.ID()] = make(chan struct{})
	go route.run()
	route.activate()

	// Hold providerExited in the exact pre-sessionClosed window under test.
	first.activityPersistence.Add(1)
	persistenceReleased := false
	releasePersistence := func() {
		if !persistenceReleased {
			persistenceReleased = true
			first.activityPersistence.Done()
		}
	}
	defer releasePersistence()

	// Observe the detach through the manager hook rather than by receiving from
	// route.queue: the worker owns that item, and competing for it would let the
	// test steal the notice the worker must process.
	detached := make(chan struct{})
	var detachOnce sync.Once
	manager.afterEvictRouteDetached = func() { detachOnce.Do(func() { close(detached) }) }

	if !emitIdleEviction(provider, route.handle) {
		t.Fatal("idle eviction notice was not routed")
	}
	select {
	case <-detached:
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for idle route detach")
	}

	opts := SessionOptions{ID: first.ID(), Binary: "unused", PiSessionID: storedIdentity}
	if manager.Get(first.ID()) == first {
		// Before the fix, the stale entry is still attachable for the whole
		// persistence window. Exercise that path synchronously so the regression
		// fails without relying on scheduler timing.
		stale, started, detach, err := manager.AcquireAttach(context.Background(), opts, nil)
		if detach != nil {
			detach()
		}
		releasePersistence()
		if err != nil {
			t.Fatalf("racing stale AcquireAttach: %v", err)
		}
		if stale == first || !started {
			t.Fatalf("racing acquire returned stale session %p started=%v before persistence drained", stale, started)
		}
	}

	// Keep the synthetic shared provider owned while the old generation drains;
	// a real manager has sibling activity during this race.
	manager.mu.Lock()
	manager.pending["idle-race-provider-lease"] = true
	manager.mu.Unlock()
	acquired := make(chan attachOutcome, 1)
	go func() {
		session, started, detach, err := manager.AcquireAttach(context.Background(), opts, nil)
		acquired <- attachOutcome{session: session, started: started, detach: detach, err: err}
	}()
	// The acquire starts while providerExited is unable to retire the old
	// generation. Once released, it must open from disk rather than attach to
	// the now-handleless session.
	releasePersistence()

	openCommand := decodeCommand(t, <-commands)
	manager.mu.Lock()
	delete(manager.pending, "idle-race-provider-lease")
	manager.mu.Unlock()
	if got := openCommand["sessionPath"]; got != storedIdentity {
		t.Fatalf("racing reopen sessionPath = %#v, want %q", got, storedIdentity)
	}
	id, _ := openCommand["id"].(string)
	provider.route(Event{Type: "response", Raw: json.RawMessage(`{"type":"response","command":"open_session","success":true,"id":"` + id + `","sessionId":"route-reopened","data":{"sessionId":"route-reopened","state":{"sessionFile":"` + storedIdentity + `"}}}`)})

	got := waitAttach(t, acquired)
	if got.err != nil {
		t.Fatalf("racing AcquireAttach: %v", got.err)
	}
	if !got.started || got.session == first {
		t.Fatalf("racing acquire = %p started=%v, want a new logical session", got.session, got.started)
	}
}

func TestIdleEvictionEmitsExactlyOneSessionUnloadedError(t *testing.T) {
	provider := fakeSharedProvider(make(chan []byte, 1))
	writer := newCollectWriter()
	exited := make(chan *Session, 1)
	session := newTestSession("idle-frame", writer)
	session.onExit = func(source *Session) { exited <- source }
	installIdleEvictionTestRoute(provider, session, "route-idle-frame")

	emitIdleEviction(provider, "route-idle-frame")
	writer.waitForType(t, "error", 5*time.Second)
	waitForExit(t, exited)
	frames := writer.snapshot()
	if len(frames) != 1 {
		t.Fatalf("eviction frames = %d, want exactly one; frames=%s", len(frames), writer.typesString())
	}
	var frame ErrorFrame
	if err := json.Unmarshal(frames[0], &frame); err != nil {
		t.Fatalf("decode eviction frame: %v", err)
	}
	if frame.Type != "error" || frame.SessionID != session.ID() || frame.Code != "session_unloaded" || frame.Message == "" {
		t.Fatalf("eviction frame = %+v", frame)
	}
}

func TestRequestedCloseSessionResponseOnlyResolvesPendingRequest(t *testing.T) {
	commands := make(chan []byte, 1)
	provider := fakeSharedProvider(commands)
	writer := newCollectWriter()
	session := newTestSession("requested-close", writer)
	installIdleEvictionTestRoute(provider, session, "route-requested-close")

	closed := make(chan error, 1)
	go func() { closed <- provider.closeSession(session) }()
	cmd := decodeCommand(t, <-commands)
	id, _ := cmd["id"].(string)
	if cmd["type"] != "close_session" || id == "" {
		t.Fatalf("close command = %v", cmd)
	}
	if !provider.route(Event{Type: "response", Raw: json.RawMessage(`{"type":"response","command":"close_session","success":true,"id":"` + id + `","sessionId":"route-requested-close"}`)}) {
		t.Fatal("correlated close response did not resolve its pending request")
	}
	select {
	case err := <-closed:
		if err != nil {
			t.Fatalf("closeSession: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("closeSession did not resolve from its correlated response")
	}

	// Re-delivery after the pending path removed the route must be harmless.
	if emitIdleEviction(provider, "route-requested-close") {
		t.Fatal("already-detached route accepted a second close response")
	}
	if frames := writer.snapshot(); len(frames) != 0 {
		t.Fatalf("requested close emitted client frames: %s", writer.typesString())
	}
	if session.isDone() {
		t.Fatal("requested close response ran the eviction terminal cascade")
	}
}

func TestIdleEvictionForUnknownOrDetachedHandleLeavesSiblingUntouched(t *testing.T) {
	provider := fakeSharedProvider(make(chan []byte, 1))
	sibling := newTestSession("unknown-sibling", newCollectWriter())
	installIdleEvictionTestRoute(provider, sibling, "route-live-sibling")
	defer provider.removeSession("route-live-sibling", sibling)
	detached := newTestSession("already-detached", newCollectWriter())
	detached.shared = provider
	detached.routingHandle = "route-detached"

	if emitIdleEviction(provider, "route-unknown") {
		t.Fatal("unknown eviction handle was routed")
	}
	if emitIdleEviction(provider, "route-detached") {
		t.Fatal("detached eviction handle was routed")
	}
	// Exercise the session-side guards as well: neither a stale handle with no
	// installed route nor a mismatched handle may terminate a live session.
	detached.forwardResponse(json.RawMessage(`{"type":"response","command":"close_session","success":true,"sessionId":"route-detached"}`))
	sibling.forwardResponse(json.RawMessage(`{"type":"response","command":"close_session","success":true,"sessionId":"route-other"}`))
	cleared := newTestSession("cleared-handle", newCollectWriter())
	cleared.shared = provider
	cleared.forwardResponse(json.RawMessage(`{"type":"response","command":"close_session","success":true,"sessionId":"route-old"}`))
	provider.mu.Lock()
	liveRoute := provider.sessions["route-live-sibling"]
	provider.mu.Unlock()
	if liveRoute == nil || liveRoute.session != sibling || !sibling.ProcessAlive() {
		t.Fatal("unknown eviction notice disturbed the live sibling")
	}
	if detached.isDone() || detached.routingHandle != "route-detached" {
		t.Fatal("unknown notice changed the already-detached session")
	}
	if cleared.isDone() || cleared.routingHandle != "" {
		t.Fatal("notice changed a session whose routing handle was already cleared")
	}
}

func TestSiblingRoutesCommandAfterIdleEviction(t *testing.T) {
	commands := make(chan []byte, 1)
	provider := fakeSharedProvider(commands)
	evicted := newTestSession("evicted", newCollectWriter())
	exited := make(chan *Session, 1)
	evicted.onExit = func(source *Session) { exited <- source }
	installIdleEvictionTestRoute(provider, evicted, "route-evicted")
	siblingWriter := newCollectWriter()
	sibling := newTestSession("live-sibling", siblingWriter)
	installIdleEvictionTestRoute(provider, sibling, "route-sibling")
	defer provider.removeSession("route-sibling", sibling)

	emitIdleEviction(provider, "route-evicted")
	waitForExit(t, exited)
	if err := sibling.QueryState(); err != nil {
		t.Fatalf("sibling QueryState after eviction: %v", err)
	}
	cmd := decodeCommand(t, <-commands)
	if cmd["type"] != "get_state" || cmd["sessionId"] != "route-sibling" {
		t.Fatalf("sibling command = %v", cmd)
	}
	provider.route(Event{Type: "response", Raw: json.RawMessage(`{"type":"response","command":"get_state","success":true,"sessionId":"route-sibling","data":{"messageCount":7}}`)})
	siblingWriter.waitForType(t, "state", 5*time.Second)
	if !sibling.ProcessAlive() {
		t.Fatal("sibling was not live after routing its command")
	}
}
