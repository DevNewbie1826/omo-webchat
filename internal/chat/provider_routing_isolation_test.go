package chat

import (
	"encoding/json"
	"testing"
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
	a.shared = provider
	a.routingHandle = "route-a"
	b := newTestSession("chat-b", newCollectWriter())
	b.piSessionID = "session-b"
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
