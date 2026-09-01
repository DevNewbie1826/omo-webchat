package chat

import (
	"encoding/json"
	"sync"
	"testing"
	"time"
)

func taskExtensionEventJSON(parentSessionID, taskName string) string {
	if parentSessionID == "" {
		return `{"type":"extension_event","name":"omo.task.updated","data":{"tasks":[{"name":"` + taskName + `"}]}}`
	}
	return `{"type":"extension_event","name":"omo.task.updated","data":{"parent_session_id":"` + parentSessionID + `","tasks":[{"name":"` + taskName + `"}]}}`
}

func cachedTaskNames(t *testing.T, s *Session) []string {
	t.Helper()
	pair := s.ActivitySnapshot()
	if len(pair.Task) == 0 {
		return nil
	}
	var payload struct {
		Tasks []struct {
			Name string `json:"name"`
		} `json:"tasks"`
	}
	if err := json.Unmarshal(pair.Task, &payload); err != nil {
		t.Fatalf("task snapshot JSON: %v (%s)", err, pair.Task)
	}
	names := make([]string, 0, len(payload.Tasks))
	for _, task := range payload.Tasks {
		names = append(names, task.Name)
	}
	return names
}

func sessionRouteState(s *Session) (*sharedProvider, string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.shared, s.routingHandle
}

func containsName(names []string, want string) bool {
	for _, name := range names {
		if name == want {
			return true
		}
	}
	return false
}

type routingGateWriter struct {
	entered   chan struct{}
	release   chan struct{}
	delivered chan struct{}
	once      sync.Once
}

func (w *routingGateWriter) WriteJSON([]byte) error {
	w.once.Do(func() {
		close(w.entered)
		<-w.release
	})
	w.delivered <- struct{}{}
	return nil
}

func TestProviderDeathClearsSharedAndHandle(t *testing.T) {
	// Given: two sessions routed on one shared provider.
	provider := fakeSharedProvider(make(chan []byte, 1))
	manager := NewManager()
	t.Cleanup(manager.CloseAll)
	manager.provider = provider

	a := newTestSession("chat-a", nil)
	a.shared = provider
	a.routingHandle = "route-a"
	b := newTestSession("chat-b", nil)
	b.shared = provider
	b.routingHandle = "route-b"
	manager.sessions[a.ID()] = a
	manager.sessions[b.ID()] = b

	// When: the shared provider dies.
	manager.providerExited(provider, providerTermination{
		kind:     providerTerminationUnexpected,
		summary:  "test death",
		sessions: []*Session{a, b},
	})

	// Then: both sessions drop the dead provider pointer and routing handle.
	for _, session := range []*Session{a, b} {
		shared, handle := sessionRouteState(session)
		if shared != nil {
			t.Errorf("session %s shared still set after provider death", session.ID())
		}
		if handle != "" {
			t.Errorf("session %s routingHandle = %q, want empty", session.ID(), handle)
		}
	}
}

func TestForwardExtensionEventDropsMismatchedParent(t *testing.T) {
	// Given: a session whose provider identity is already established.
	writer := newCollectWriter()
	s := newTestSession("chat-drop", writer)
	s.piSessionID = "my-session"
	s.providerSessionID = "my-session"
	before := s.ActivitySnapshot()

	// When: an extension_event arrives tagged with a different parent session.
	dispatchEvent(s, "extension_event", taskExtensionEventJSON("other-session", "foreign-task"))

	// Then: the event is neither cached nor forwarded to the WS writer.
	after := s.ActivitySnapshot()
	if !after.Equal(before) {
		t.Fatalf("ActivitySnapshot changed after mismatched parent: %s", after.Task)
	}
	if got := countFramesOfType(writer.snapshot(), "extensionEvent"); got != 0 {
		t.Fatalf("mismatched extension_event forwarded = %d, want 0; frames: %s", got, writer.typesString())
	}
}

func TestForwardExtensionEventAllowsMatchingParent(t *testing.T) {
	// Given: a session whose provider identity is already established.
	writer := newCollectWriter()
	s := newTestSession("chat-match", writer)
	s.piSessionID = "my-session"
	s.providerSessionID = "my-session"

	// When: an extension_event arrives tagged with this session's identity.
	dispatchEvent(s, "extension_event", taskExtensionEventJSON("my-session", "own-task"))

	// Then: the event is cached and forwarded.
	if got := countFramesOfType(writer.snapshot(), "extensionEvent"); got != 1 {
		t.Fatalf("matching extension_event forwarded = %d, want 1; frames: %s", got, writer.typesString())
	}
	if names := cachedTaskNames(t, s); !containsName(names, "own-task") {
		t.Fatalf("cached task names = %v, want own-task", names)
	}
}

func TestForwardExtensionEventMatchesRuntimeIDWhenResumeIdentityIsFile(t *testing.T) {
	// Given: open_session returned both its durable file identity and provider
	// runtime UUID. The file remains the identity used for future resume.
	writer := newCollectWriter()
	s := newTestSession("chat-runtime-match", writer)
	s.capturePiSessionID(json.RawMessage(`{"sessionFile":"/tmp/runtime-match.jsonl","sessionId":"01a057c8-560c-7039-aff9-24d448001938"}`))
	if got := s.PiSessionID(); got != "/tmp/runtime-match.jsonl" {
		t.Fatalf("resume identity = %q, want session file", got)
	}

	// When: an extension event carries the matching provider runtime UUID.
	dispatchEvent(s, "extension_event", taskExtensionEventJSON("01a057c8-560c-7039-aff9-24d448001938", "runtime-task"))

	// Then: the UUID match permits both forwarding and snapshot caching.
	if got := countFramesOfType(writer.snapshot(), "extensionEvent"); got != 1 {
		t.Fatalf("runtime-matching extension_event forwarded = %d, want 1; frames: %s", got, writer.typesString())
	}
	if names := cachedTaskNames(t, s); !containsName(names, "runtime-task") {
		t.Fatalf("cached task names = %v, want runtime-task", names)
	}
}

func TestForwardExtensionEventAllowsTaggedParentBeforeRuntimeIDCapture(t *testing.T) {
	// Given: only a durable file identity is known; the open-session runtime
	// UUID has not been captured yet.
	writer := newCollectWriter()
	s := newTestSession("chat-runtime-unknown", writer)
	s.capturePiSessionID(json.RawMessage(`{"sessionFile":"/tmp/runtime-unknown.jsonl"}`))

	// When: a parent-tagged event arrives during that initialization window.
	dispatchEvent(s, "extension_event", taskExtensionEventJSON("runtime-not-yet-known", "early-task"))

	// Then: preserve the existing pass-through behavior until a runtime UUID is known.
	if got := countFramesOfType(writer.snapshot(), "extensionEvent"); got != 1 {
		t.Fatalf("pre-runtime extension_event forwarded = %d, want 1; frames: %s", got, writer.typesString())
	}
}

func TestForwardExtensionEventAllowsAbsentParent(t *testing.T) {
	// Given: a session with an established identity and a payload with no parent_session_id.
	writer := newCollectWriter()
	s := newTestSession("chat-absent", writer)
	s.piSessionID = "my-session"

	// When: an extension_event arrives without parent_session_id (legacy / mock-pi).
	dispatchEvent(s, "extension_event", taskExtensionEventJSON("", "legacy-task"))

	// Then: the event is cached and forwarded for backward compatibility.
	if got := countFramesOfType(writer.snapshot(), "extensionEvent"); got != 1 {
		t.Fatalf("parentless extension_event forwarded = %d, want 1; frames: %s", got, writer.typesString())
	}
	if names := cachedTaskNames(t, s); !containsName(names, "legacy-task") {
		t.Fatalf("cached task names = %v, want legacy-task", names)
	}
}

func TestTwoSessionIsolationAfterProviderRestart(t *testing.T) {
	// Given: sessions A and B share a provider; A has already cached its own task.
	provider := fakeSharedProvider(make(chan []byte, 1))
	manager := NewManager()
	t.Cleanup(manager.CloseAll)
	manager.provider = provider

	a := newTestSession("chat-a", newCollectWriter())
	a.piSessionID = "session-a"
	a.providerSessionID = "session-a"
	a.shared = provider
	a.routingHandle = "route-a"
	b := newTestSession("chat-b", newCollectWriter())
	b.piSessionID = "session-b"
	b.providerSessionID = "session-b"
	b.shared = provider
	b.routingHandle = "route-b"
	manager.sessions[a.ID()] = a
	manager.sessions[b.ID()] = b

	dispatchEvent(a, "extension_event", taskExtensionEventJSON("session-a", "alpha-task"))

	// When: the provider dies, B reattaches to a new provider, and B's task
	// events also arrive on A through a stale routing path.
	manager.providerExited(provider, providerTermination{
		kind:     providerTerminationUnexpected,
		summary:  "test death",
		sessions: []*Session{a, b},
	})

	provider2 := fakeSharedProvider(make(chan []byte, 1))
	manager.provider = provider2
	b.shared = provider2
	b.routingHandle = "route-b2"

	bravo := taskExtensionEventJSON("session-b", "bravo-task")
	dispatchEvent(b, "extension_event", bravo)
	dispatchEvent(a, "extension_event", bravo)

	// Then: A's activity cache still reflects only A's task.
	names := cachedTaskNames(t, a)
	if containsName(names, "bravo-task") {
		t.Fatalf("session A activity cache contains B's task after restart: %v", names)
	}
	if !containsName(names, "alpha-task") {
		t.Fatalf("session A lost its own task after restart: %v", names)
	}
}

func TestTwoSessionIsolationDuringConcurrentProviderRestart(t *testing.T) {
	// Given: A and B have live route workers on a shared provider. Hold A's
	// first delivery in its writer so provider exit overlaps route delivery.
	provider := fakeSharedProvider(make(chan []byte, 1))
	manager := NewManager()
	manager.provider = provider

	writerA := &routingGateWriter{
		entered: make(chan struct{}), release: make(chan struct{}), delivered: make(chan struct{}, 2),
	}
	a := newTestSession("chat-concurrent-a", nil)
	a.Attach(writerA)
	a.piSessionID = "session-a"
	a.providerSessionID = "session-a"
	writerB := newCollectWriter()
	b := newTestSession("chat-concurrent-b", writerB)
	b.piSessionID = "session-b"
	b.providerSessionID = "session-b"

	install := func(p *sharedProvider, session *Session, handle string) *sessionRoute {
		route := &sessionRoute{
			session: session, handle: handle,
			queue: make(chan sessionDelivery, sessionQueueSize), ready: make(chan struct{}), provider: p,
		}
		session.mu.Lock()
		session.shared = p
		session.routingHandle = handle
		session.mu.Unlock()
		p.mu.Lock()
		p.sessions[handle] = route
		p.mu.Unlock()
		go route.run()
		route.activate()
		return route
	}
	oldRouteA := install(provider, a, "route-a")
	oldRouteB := install(provider, b, "route-b")
	manager.sessions[a.ID()] = a
	manager.sessions[b.ID()] = b
	var provider2 *sharedProvider
	var newRouteB *sessionRoute
	t.Cleanup(func() {
		oldRouteA.cancel()
		oldRouteB.cancel()
		if newRouteB != nil {
			newRouteB.cancel()
		}
		manager.mu.Lock()
		manager.sessions = make(map[string]*Session)
		manager.provider = nil
		manager.mu.Unlock()
		manager.CloseAll()
		_ = provider.close()
		if provider2 != nil {
			_ = provider2.close()
		}
	})

	if !provider.route(Event{Type: "extension_event", Raw: json.RawMessage(taskExtensionEventJSON("session-a", "alpha-task")), SessionID: "route-a"}) {
		t.Fatal("alpha event was not routed")
	}
	<-writerA.entered

	// When: stale delivery is queued behind A's blocked frame while provider
	// exit and B's reattachment execute on separate coordinated goroutines.
	bravo := json.RawMessage(taskExtensionEventJSON("session-b", "bravo-task"))
	if !provider.route(Event{Type: "extension_event", Raw: bravo, SessionID: "route-a"}) {
		t.Fatal("stale bravo event was not queued on A")
	}
	if !provider.route(Event{Type: "extension_event", Raw: json.RawMessage(taskExtensionEventJSON("session-a", "alpha-after-restart")), SessionID: "route-a"}) {
		t.Fatal("post-restart alpha event was not queued on A")
	}

	provider2 = fakeSharedProvider(make(chan []byte, 1))
	exited := make(chan struct{})
	start := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		<-start
		manager.providerExited(provider, providerTermination{
			kind: providerTerminationUnexpected, summary: "test death", sessions: []*Session{a, b},
		})
		close(exited)
	}()
	go func() {
		defer wg.Done()
		<-start
		<-exited
		newRouteB = install(provider2, b, "route-b2")
		manager.mu.Lock()
		manager.provider = provider2
		manager.sessions[b.ID()] = b
		manager.mu.Unlock()
		provider2.route(Event{Type: "extension_event", Raw: bravo, SessionID: "route-b2"})
	}()
	close(start)
	close(writerA.release)
	wg.Wait()
	if newRouteB == nil {
		t.Fatal("B was not reattached")
	}

	// Then: wait for B's accepted route delivery and both accepted A frames.
	// FIFO makes the second A signal exact proof that the stale frame between
	// them was processed, not merely left queued when assertions ran.
	writerB.waitForType(t, "extensionEvent", sessionDeliveryTimeout)
	for delivered := 0; delivered < 2; delivered++ {
		select {
		case <-writerA.delivered:
		case <-time.After(sessionDeliveryTimeout):
			t.Fatal("timed out waiting for A's queued route deliveries")
		}
	}
	namesB := cachedTaskNames(t, b)
	if !containsName(namesB, "bravo-task") {
		t.Fatalf("session B did not cache its reattached task: %v", namesB)
	}
	namesA := cachedTaskNames(t, a)
	if containsName(namesA, "bravo-task") || !containsName(namesA, "alpha-after-restart") {
		t.Fatalf("session A cache after concurrent restart = %v, want alpha only", namesA)
	}
}
