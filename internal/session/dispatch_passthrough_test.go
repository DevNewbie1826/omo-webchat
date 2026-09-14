package session

import (
	"testing"
)

func acquireDrained(t *testing.T, chatID string) (*Session, *recorder) {
	t.Helper()
	d := newDaemon(t)
	mgr := testManager(t, dial(t, d), newMemStore(), 64)
	sub := &synchronousApprovalRecorder{recorder: newRecorder(16)}
	s, _, detach := acquire(t, mgr, testChat{id: chatID, cwd: t.TempDir()}, sub)
	t.Cleanup(detach)
	_ = drainSync(sub.recorder)
	return s, sub.recorder
}

func TestDispatchUnlistedEventPublishesRawNotice(t *testing.T) {
	// Given a live session with no dedicated mapping for this event type.
	s, sub := acquireDrained(t, "passthrough-unlisted")

	// When an unlisted engine event arrives on the dispatch path.
	injectEvent(t, s, map[string]any{
		"type":     "provider_lifecycle_hint",
		"message":  "m1",
		"severity": "info",
		"meta":     map[string]any{"k": "v"},
	})
	frames := publishCompactionMarker(t, s, sub)

	// Then exactly one FrameNotice is published with the event kind, payload
	// fields carried verbatim, and journal identity stamped.
	got := counts(frames)[FrameNotice]
	if got != 1 {
		t.Fatalf("unlisted event produced %d FrameNotice, want 1; frames=%+v", got, frames)
	}
	var notice Frame
	for _, f := range frames {
		if f.Kind == FrameNotice {
			notice = f
			break
		}
	}
	data, ok := notice.Data.(map[string]any)
	if !ok {
		t.Fatalf("notice data = %T, want map[string]any", notice.Data)
	}
	if data["kind"] != "provider_lifecycle_hint" {
		t.Fatalf("notice kind = %v, want provider_lifecycle_hint", data["kind"])
	}
	if data["message"] != "m1" || data["severity"] != "info" {
		t.Fatalf("notice payload mutated: message=%v severity=%v", data["message"], data["severity"])
	}
	meta, _ := data["meta"].(map[string]any)
	if meta["k"] != "v" {
		t.Fatalf("notice meta not carried verbatim: %+v", data["meta"])
	}
	nid, _ := data["nid"].(string)
	at, _ := data["at"].(string)
	if nid == "" || at == "" {
		t.Fatalf("notice missing journal identity: nid=%q at=%q", nid, at)
	}
}

func TestDispatchListedNoticeKindStillPublishes(t *testing.T) {
	// Given a live session.
	s, sub := acquireDrained(t, "passthrough-listed")

	// When a previously allowlisted notice kind arrives.
	injectEvent(t, s, map[string]any{"type": "auto_retry_start"})
	_, notice := sub.await(t, FrameNotice)

	// Then it still publishes as FrameNotice with that kind.
	data, ok := notice.Data.(map[string]any)
	if !ok {
		t.Fatalf("notice data = %T, want map[string]any", notice.Data)
	}
	if data["kind"] != "auto_retry_start" {
		t.Fatalf("notice kind = %v, want auto_retry_start", data["kind"])
	}
}

func TestDispatchMappedEventsDoNotPublishNotice(t *testing.T) {
	cases := []struct {
		name string
		ev   map[string]any
		want FrameKind
	}{
		{name: "state", ev: map[string]any{"type": "state"}, want: FrameState},
		{name: "message", ev: map[string]any{"type": "message"}, want: FrameMessage},
		{name: "agent_start", ev: map[string]any{"type": "agent_start"}, want: FrameRunStarted},
		{name: "tool_execution_start", ev: map[string]any{"type": "tool_execution_start"}, want: FrameTool},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			// Given a live session with a dedicated frame mapping for this event.
			s, sub := acquireDrained(t, "passthrough-"+tc.name)

			// When the mapped engine event is dispatched.
			injectEvent(t, s, tc.ev)
			prior, got := sub.await(t, tc.want)

			// Then the dedicated frame is published and no FrameNotice is.
			if got.Kind != tc.want {
				t.Fatalf("%s produced kind %s, want %s", tc.name, got.Kind, tc.want)
			}
			if counts(prior)[FrameNotice] != 0 {
				t.Fatalf("%s published FrameNotice before %s: %+v", tc.name, tc.want, prior)
			}
			if trailing := publishCompactionMarker(t, s, sub); counts(trailing)[FrameNotice] != 0 {
				t.Fatalf("%s published trailing FrameNotice: %+v", tc.name, trailing)
			}
		})
	}
}
