package session

import (
	"encoding/json"
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
	// Two independent fixtures: finite numbers take the normal default
	// branch; an overflowing exponent takes the fallback path. Nested
	// arrays/null/booleans ride with the finite event so both decode
	// paths pin the full payload contract.
	cases := []struct {
		name  string
		chat  string
		event map[string]any
		want  map[string]any
	}{
		{
			name: "normal_finite_numbers",
			chat: "passthrough-unlisted-normal",
			event: map[string]any{
				"type":      "provider_lifecycle_hint",
				"sessionId": "raw-session-id",
				"message":   "m1",
				"severity":  "info",
				"meta":      map[string]any{"k": "v"},
				"intValue":  json.Number("9007199254740993"),
				"smallInt":  json.Number("42"),
				"decValue":  json.Number("12345678901234567890.123456"),
				"nested":    []any{map[string]any{"value": json.Number("9007199254740993")}, nil, true, false},
			},
			want: map[string]any{
				"kind":     "provider_lifecycle_hint",
				"message":  "m1",
				"severity": "info",
				"meta":     map[string]any{"k": "v"},
				"intValue": json.Number("9007199254740993"),
				"smallInt": json.Number("42"),
				"decValue": json.Number("12345678901234567890.123456"),
				"nested":   []any{map[string]any{"value": json.Number("9007199254740993")}, nil, true, false},
			},
		},
		{
			name: "overflow_exponent",
			chat: "passthrough-unlisted-overflow",
			event: map[string]any{
				"type":      "provider_lifecycle_hint",
				"sessionId": "raw-session-id",
				"message":   "m1",
				"severity":  "info",
				"meta":      map[string]any{"k": "v"},
				"intValue":  json.Number("9007199254740993"),
				"expValue":  json.Number("1e400"),
			},
			want: map[string]any{
				"kind":     "provider_lifecycle_hint",
				"message":  "m1",
				"severity": "info",
				"meta":     map[string]any{"k": "v"},
				"intValue": json.Number("9007199254740993"),
				"expValue": json.Number("1e400"),
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			// Given a live session with no dedicated mapping for this event type.
			s, sub := acquireDrained(t, tc.chat)

			// When an unlisted event arrives on the dispatch path.
			injectEvent(t, s, tc.event)
			frames := publishCompactionMarker(t, s, sub)

			// Then exactly one FrameNotice is published with the event kind, payload
			// fields carried verbatim (including numeric literals), envelope fields
			// stripped, and journal identity stamped.
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
			nid, _ := data["nid"].(string)
			at, _ := data["at"].(string)
			if nid == "" || at == "" {
				t.Fatalf("notice missing journal identity: nid=%q at=%q", nid, at)
			}
			if _, present := data["sessionId"]; present {
				t.Fatalf("sessionId leaked into notice payload: %+v", data)
			}
			if _, present := data["type"]; present {
				t.Fatalf("type leaked into notice payload: %+v", data)
			}
			if n, ok := data["intValue"].(json.Number); !ok || n != "9007199254740993" {
				t.Fatalf("intValue = %T(%v), want json.Number 9007199254740993", data["intValue"], data["intValue"])
			}
			wantPayload, err := json.Marshal(tc.want)
			if err != nil {
				t.Fatalf("marshal expected payload: %v", err)
			}
			stripped := cloneAnyMap(data)
			delete(stripped, "nid")
			delete(stripped, "at")
			gotPayload, err := json.Marshal(stripped)
			if err != nil {
				t.Fatalf("marshal notice payload: %v", err)
			}
			if string(gotPayload) != string(wantPayload) {
				t.Fatalf("notice payload = %s, want %s", gotPayload, wantPayload)
			}
		})
	}
}

func TestDispatchListedNoticeKindsStillPublish(t *testing.T) {
	kinds := []string{
		"high_reasoning_warning",
		"retry_fallback_applied",
		"retry_fallback_reverted",
		"retry_fallback_succeeded",
		"retry_fallback_exhausted",
		"server_fallback_aborted",
		"auto_retry_start",
		"auto_retry_end",
		"extension_notify",
	}
	for _, kind := range kinds {
		t.Run(kind, func(t *testing.T) {
			// Given a live session.
			s, sub := acquireDrained(t, "passthrough-listed-"+kind)

			// When a previously allowlisted notice kind arrives.
			injectEvent(t, s, map[string]any{
				"type":     kind,
				"message":  "m-" + kind,
				"severity": "info",
				"meta":     map[string]any{"k": kind},
			})
			frames := publishCompactionMarker(t, s, sub)

			// Then exactly one FrameNotice is published with that kind and payload shape intact.
			if got := counts(frames)[FrameNotice]; got != 1 {
				t.Fatalf("%s produced %d FrameNotice, want 1; frames=%+v", kind, got, frames)
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
				t.Fatalf("%s notice data = %T, want map[string]any", kind, notice.Data)
			}
			if data["kind"] != kind {
				t.Fatalf("%s notice kind = %v, want %s", kind, data["kind"], kind)
			}
			if data["message"] != "m-"+kind || data["severity"] != "info" {
				t.Fatalf("%s payload mutated: message=%v severity=%v", kind, data["message"], data["severity"])
			}
			meta, _ := data["meta"].(map[string]any)
			if meta["k"] != kind {
				t.Fatalf("%s meta not carried: %+v", kind, data["meta"])
			}
		})
	}
}

func TestDispatchMappedEventsDoNotPublishNotice(t *testing.T) {
	cases := []struct {
		name  string
		ev    map[string]any
		want  FrameKind
		setup func(*testing.T, *Session, *recorder)
	}{
		{name: "state", ev: map[string]any{"type": "state"}, want: FrameState},
		{name: "state_changed", ev: map[string]any{"type": "state_changed"}, want: FrameState},
		{name: "message", ev: map[string]any{"type": "message"}, want: FrameMessage},
		{name: "message_end", ev: map[string]any{"type": "message_end"}, want: FrameMessage},
		{name: "message_update", ev: map[string]any{"type": "message_update"}, want: FrameMessageDelta},
		{name: "message_delta", ev: map[string]any{"type": "message_delta"}, want: FrameMessageDelta},
		{name: "tool_execution_start", ev: map[string]any{"type": "tool_execution_start"}, want: FrameTool},
		{name: "tool_execution_update", ev: map[string]any{"type": "tool_execution_update"}, want: FrameTool},
		{name: "tool_execution_end", ev: map[string]any{"type": "tool_execution_end"}, want: FrameTool},
		{name: "commands_changed", ev: map[string]any{"type": "commands_changed"}, want: FrameCommands},
		{name: "extension_event", ev: map[string]any{"type": "extension_event", "name": "allowed", "data": map[string]any{"x": 1}}, want: FrameExtensionEvent},
		{name: "extension_ui_request", ev: map[string]any{"type": "extension_ui_request", "id": "approval-1", "requestId": "client-7", "method": "select"}, want: FrameApproval},
		{name: "entries.stream", ev: map[string]any{"type": "entries.stream", "entries": []any{map[string]any{"x": 1}}, "leafId": "leaf", "final": true}, want: FrameEntries},
		{name: "compaction_start", ev: map[string]any{"type": "compaction_start", "reason": "threshold", "requestId": "auto-1"}, want: FrameCompactionStart},
		{
			name: "compaction_end",
			ev:   map[string]any{"type": "compaction_end", "requestId": "auto-1"},
			want: FrameCompactionDone,
			setup: func(t *testing.T, s *Session, sub *recorder) {
				injectEvent(t, s, map[string]any{"type": "compaction_start", "reason": "threshold", "requestId": "auto-1"})
				sub.await(t, FrameCompactionStart)
			},
		},
		{name: "agent_start", ev: map[string]any{"type": "agent_start"}, want: FrameRunStarted},
		{
			name: "agent_settled",
			ev:   map[string]any{"type": "agent_settled", "reason": "end_turn"},
			want: FrameRunDone,
			setup: func(t *testing.T, s *Session, sub *recorder) {
				injectEvent(t, s, map[string]any{"type": "agent_start"})
				sub.await(t, FrameRunStarted)
			},
		},
		{name: "agent_end", ev: map[string]any{"type": "agent_end"}},
		{name: "session_unloaded", ev: map[string]any{"type": "session_unloaded"}},
		{name: "session_closed", ev: map[string]any{"type": "session_closed"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			// Given a live session with a dedicated frame mapping for this event.
			s, sub := acquireDrained(t, "passthrough-"+tc.name)
			if tc.setup != nil {
				tc.setup(t, s, sub)
			}

			// When the mapped engine event is dispatched.
			injectEvent(t, s, tc.ev)

			// Then the dedicated frame is published (when the mapping emits one)
			// and no FrameNotice is produced by the passthrough path.
			if tc.want != "" {
				prior, got := sub.await(t, tc.want)
				if got.Kind != tc.want {
					t.Fatalf("%s produced kind %s, want %s", tc.name, got.Kind, tc.want)
				}
				if counts(prior)[FrameNotice] != 0 {
					t.Fatalf("%s published FrameNotice before %s: %+v", tc.name, tc.want, prior)
				}
			}
			if trailing := publishCompactionMarker(t, s, sub); counts(trailing)[FrameNotice] != 0 {
				t.Fatalf("%s published trailing FrameNotice: %+v", tc.name, trailing)
			}
		})
	}
}
