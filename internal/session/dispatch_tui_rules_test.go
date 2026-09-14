package session

import (
	"encoding/json"
	"testing"
)

// The engine TUI transcript rules, mirrored as observed engine behavior:
// fire-and-forget notify asks become journaled notices, lifecycle markers
// stay transcript-silent, and only custom entry types the transcript renders
// are mirrored into the notice feed.

// dropAttachReady removes the attach-time ready marker so silence assertions
// see only the frames a dispatched event produced.
func dropAttachReady(frames []Frame) []Frame {
	var out []Frame
	for _, f := range frames {
		if f.Kind != FrameReady {
			out = append(out, f)
		}
	}
	return out
}

func TestDispatchNotifyBecomesJournaledEngineNotice(t *testing.T) {
	// Given a live session with no pending asks.
	s, sub := acquireDrained(t, "tui-notify-journaled")

	// When a fire-and-forget notify request arrives on the dispatch path.
	injectEvent(t, s, map[string]any{
		"type":       "extension_ui_request",
		"id":         "notice-1",
		"method":     "notify",
		"message":    "Turn stats: 5.2k in, 1.1k out",
		"notifyType": "turn_stats",
	})
	frames := publishCompactionMarker(t, s, sub)

	// Then exactly one FrameNotice is published with the engine_notify kind,
	// the raw message verbatim, the notifyType, and journal identity - and no
	// approval frame is produced for it.
	if got := counts(frames)[FrameNotice]; got != 1 {
		t.Fatalf("notify produced %d FrameNotice, want 1; frames=%+v", got, frames)
	}
	if got := counts(frames)[FrameApproval]; got != 0 {
		t.Fatalf("notify produced %d FrameApproval, want 0; frames=%+v", got, frames)
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
		t.Fatalf("notify notice data = %T, want map[string]any", notice.Data)
	}
	if data["kind"] != "engine_notify" {
		t.Fatalf("notify notice kind = %v, want engine_notify", data["kind"])
	}
	if data["message"] != "Turn stats: 5.2k in, 1.1k out" {
		t.Fatalf("notify notice message = %v, want the raw message verbatim", data["message"])
	}
	if data["notifyType"] != "turn_stats" {
		t.Fatalf("notify notice notifyType = %v, want turn_stats", data["notifyType"])
	}
	nid, _ := data["nid"].(string)
	at, _ := data["at"].(string)
	if nid == "" || at == "" {
		t.Fatalf("notify notice missing journal identity: nid=%q at=%q", nid, at)
	}

	// A client attaching after the broadcast restores the notice from the
	// journal and never sees a retained ask.
	late := &synchronousApprovalRecorder{recorder: newRecorder(16)}
	lateDetach := s.Attach(late)
	t.Cleanup(lateDetach)
	replayed := drainSync(late.recorder)
	if got := counts(replayed)[FrameNotice]; got != 1 {
		t.Fatalf("late attach replayed %d FrameNotice, want 1; frames=%+v", got, replayed)
	}
	if hasApproval(replayed, "notice-1") {
		t.Fatalf("notify retained as a pending approval for replay: %+v", replayed)
	}
}

func TestDispatchNotifyOmitsAbsentNotifyType(t *testing.T) {
	// Given a live session.
	s, sub := acquireDrained(t, "tui-notify-bare")

	// When a notify request without a notifyType arrives.
	injectEvent(t, s, map[string]any{
		"type":    "extension_ui_request",
		"id":      "notice-2",
		"method":  "notify",
		"message": "m2",
	})
	frames := publishCompactionMarker(t, s, sub)

	// Then the single engine_notify notice carries no notifyType field.
	if got := counts(frames)[FrameNotice]; got != 1 {
		t.Fatalf("notify produced %d FrameNotice, want 1; frames=%+v", got, frames)
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
		t.Fatalf("notify notice data = %T, want map[string]any", notice.Data)
	}
	if data["kind"] != "engine_notify" || data["message"] != "m2" {
		t.Fatalf("notify notice payload mutated: kind=%v message=%v", data["kind"], data["message"])
	}
	if _, present := data["notifyType"]; present {
		t.Fatalf("absent notifyType leaked into the notice: %+v", data)
	}
}

func TestDispatchTranscriptSilentEventsPublishNothing(t *testing.T) {
	kinds := []string{
		"turn_start",
		"turn_end",
		"agent_idle",
		"loaded_surfaces_changed",
		"message_start",
		"tool_hook_status",
		"thinking_level_changed",
	}
	for _, kind := range kinds {
		t.Run(kind, func(t *testing.T) {
			// Given a live session.
			s, sub := acquireDrained(t, "tui-silent-"+kind)

			// When a transcript-silent lifecycle event is dispatched.
			injectEvent(t, s, map[string]any{"type": kind, "marker": kind})
			frames := publishCompactionMarker(t, s, sub)

			// Then no frame of any kind is published for it.
			if eventFrames := dropAttachReady(frames); len(eventFrames) != 0 {
				t.Fatalf("%s published frames, want none: %+v", kind, eventFrames)
			}
		})
	}
}

// Keep projection coverage independent of the currently empty production shown set.
func useShownCustomFixture(t *testing.T) {
	t.Helper()
	previous := transcriptShownCustomTypes
	transcriptShownCustomTypes = []string{"test-shown-custom"}
	t.Cleanup(func() { transcriptShownCustomTypes = previous })
}

func TestDispatchEntryAppendedMirrorsShownCustomType(t *testing.T) {
	useShownCustomFixture(t)
	// Given a live session.
	s, sub := acquireDrained(t, "tui-entry-shown")

	// When an entry_appended event carries a custom entry whose customType the
	// engine transcript renders.
	injectEvent(t, s, map[string]any{
		"type": "entry_appended",
		"entry": map[string]any{
			"type":       "custom",
			"id":         "entry-1",
			"customType": "test-shown-custom",
			"data":       map[string]any{"goals": []any{"g1"}},
		},
	})
	frames := publishCompactionMarker(t, s, sub)

	// Then exactly one FrameNotice is published whose kind is the customType
	// and whose payload hoists the entry data fields, with journal identity.
	if got := counts(frames)[FrameNotice]; got != 1 {
		t.Fatalf("entry_appended produced %d FrameNotice, want 1; frames=%+v", got, frames)
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
		t.Fatalf("entry notice data = %T, want map[string]any", notice.Data)
	}
	if data["kind"] != "test-shown-custom" {
		t.Fatalf("entry notice kind = %v, want test-shown-custom", data["kind"])
	}
	goals, _ := data["goals"].([]any)
	if len(goals) != 1 || goals[0] != "g1" {
		t.Fatalf("entry data not hoisted: %+v", data)
	}
	for _, key := range []string{"id", "type", "data", "customType"} {
		if _, present := data[key]; present {
			t.Fatalf("envelope key %q leaked into notice: %+v", key, data)
		}
	}
	nid, _ := data["nid"].(string)
	at, _ := data["at"].(string)
	if nid == "" || at == "" {
		t.Fatalf("entry notice missing journal identity: nid=%q at=%q", nid, at)
	}
}

func TestDispatchEntryAppendedProjectsDisplayFields(t *testing.T) {
	useShownCustomFixture(t)
	// Given a live session.
	s, sub := acquireDrained(t, "tui-entry-display")

	// When an entry_appended event carries a shown custom entry whose data
	// object is the display box (title/why/values) plus session envelope keys.
	injectEvent(t, s, map[string]any{
		"type": "entry_appended",
		"entry": map[string]any{
			"type":       "custom",
			"customType": "test-shown-custom",
			"id":         "entry-1",
			"parentId":   "parent-1",
			"timestamp":  json.Number("1710000000000"),
			"data": map[string]any{
				"title":   "QA_TITLE",
				"why":     "QA_WHY",
				"warm":    2,
				"savings": json.Number("9007199254740993"),
			},
		},
	})
	frames := publishCompactionMarker(t, s, sub)

	// Then exactly one notice is published whose Data (minus kind) hoists
	// title/why/warm/savings to the top level with savings as json.Number,
	// and drops the session envelope keys.
	if got := counts(frames)[FrameNotice]; got != 1 {
		t.Fatalf("entry_appended produced %d FrameNotice, want 1; frames=%+v", got, frames)
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
		t.Fatalf("entry notice data = %T, want map[string]any", notice.Data)
	}
	if data["kind"] != "test-shown-custom" {
		t.Fatalf("entry notice kind = %v, want test-shown-custom", data["kind"])
	}
	nid, _ := data["nid"].(string)
	at, _ := data["at"].(string)
	if nid == "" || at == "" {
		t.Fatalf("entry notice missing journal identity: nid=%q at=%q", nid, at)
	}
	if data["title"] != "QA_TITLE" || data["why"] != "QA_WHY" {
		t.Fatalf("display fields not hoisted: %+v", data)
	}
	if n, ok := data["savings"].(json.Number); !ok || n != "9007199254740993" {
		encoded, _ := json.Marshal(data["savings"])
		t.Fatalf("savings = %s (%T), want json.Number 9007199254740993", encoded, data["savings"])
	}
	if n, ok := data["warm"].(json.Number); !ok || n != "2" {
		encoded, _ := json.Marshal(data["warm"])
		t.Fatalf("warm = %s (%T), want json.Number 2", encoded, data["warm"])
	}
	for _, key := range []string{"id", "parentId", "timestamp", "type", "data", "customType"} {
		if _, present := data[key]; present {
			t.Fatalf("envelope key %q leaked into notice: %+v", key, data)
		}
	}
}

func TestDispatchEntryAppendedDropsEnvelopeWhenDataIsNotObject(t *testing.T) {
	useShownCustomFixture(t)
	cases := []struct {
		name  string
		entry map[string]any
		want  map[string]any
	}{
		{
			name: "data_absent",
			entry: map[string]any{
				"type":       "custom",
				"customType": "test-shown-custom",
				"id":         "entry-1",
				"parentId":   "parent-1",
				"timestamp":  json.Number("1"),
				"note":       "QA_NOTE",
			},
			want: map[string]any{"note": "QA_NOTE"},
		},
		{
			name: "data_string",
			entry: map[string]any{
				"type":       "custom",
				"customType": "test-shown-custom",
				"id":         "entry-1",
				"data":       "QA_DATA",
			},
			want: map[string]any{"data": "QA_DATA"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			// Given a live session.
			s, sub := acquireDrained(t, "tui-entry-flat-"+tc.name)

			// When a shown custom entry has no data object.
			injectEvent(t, s, map[string]any{"type": "entry_appended", "entry": tc.entry})
			frames := publishCompactionMarker(t, s, sub)

			// Then remaining non-envelope fields are carried and envelope keys are dropped.
			if got := counts(frames)[FrameNotice]; got != 1 {
				t.Fatalf("entry_appended produced %d FrameNotice, want 1; frames=%+v", got, frames)
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
				t.Fatalf("entry notice data = %T, want map[string]any", notice.Data)
			}
			if data["kind"] != "test-shown-custom" {
				t.Fatalf("entry notice kind = %v, want test-shown-custom", data["kind"])
			}
			for k, want := range tc.want {
				if data[k] != want {
					t.Fatalf("field %q = %v, want %v; data=%+v", k, data[k], want, data)
				}
			}
			for _, key := range []string{"id", "parentId", "timestamp", "type", "customType"} {
				if _, present := data[key]; present {
					t.Fatalf("envelope key %q leaked into notice: %+v", key, data)
				}
			}
		})
	}
}

func TestDispatchEntryAppendedPreservesNumericLiterals(t *testing.T) {
	useShownCustomFixture(t)
	// Finite literals take the ordinary decode path (float64 rounding);
	// 1e400 takes the overflow path (initial Unmarshal fails). Each is a
	// shown-set custom entry so the projection, not the unmapped fallback,
	// is the unit under test.
	cases := []struct {
		name    string
		literal string
	}{
		{name: "finite_integer", literal: "9007199254740993"},
		{name: "finite_decimal", literal: "12345678901234567890.123456"},
		{name: "overflow_exponent", literal: "1e400"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			// Given a live session and a shown-set custom entry.
			s, sub := acquireDrained(t, "tui-entry-numeric-"+tc.name)
			number := json.Number(tc.literal)
			want := map[string]any{
				"kind":   "test-shown-custom",
				"value":  number,
				"nested": []any{number, nil, true},
			}

			// When the shown custom entry is dispatched.
			injectEvent(t, s, map[string]any{
				"type": "entry_appended",
				"entry": map[string]any{
					"type":       "custom",
					"id":         "entry-1",
					"customType": "test-shown-custom",
					"data": map[string]any{
						"value":  number,
						"nested": []any{number, nil, true},
					},
				},
			})
			frames := publishCompactionMarker(t, s, sub)

			// Then exactly one notice is published with the numeric literals
			// preserved verbatim, and journal replay presents the same payload.
			assertShownCustomNumericNotice(t, frames, want)
			late := &synchronousApprovalRecorder{recorder: newRecorder(16)}
			lateDetach := s.Attach(late)
			t.Cleanup(lateDetach)
			assertShownCustomNumericNotice(t, drainSync(late.recorder), want)
		})
	}
}

func assertShownCustomNumericNotice(t *testing.T, frames []Frame, want map[string]any) {
	t.Helper()
	literal := want["value"].(json.Number)
	if got := counts(frames)[FrameNotice]; got != 1 {
		t.Fatalf("shown entry produced %d FrameNotice, want 1 for literal %s; frames=%+v", got, literal, frames)
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
		t.Fatalf("entry notice data = %T, want map[string]any", notice.Data)
	}
	nid, _ := data["nid"].(string)
	at, _ := data["at"].(string)
	if nid == "" || at == "" {
		t.Fatalf("entry notice missing journal identity: nid=%q at=%q", nid, at)
	}
	if n, ok := data["value"].(json.Number); !ok || n != literal {
		encoded, _ := json.Marshal(data["value"])
		t.Fatalf("value = %s (%T), want verbatim %s", encoded, data["value"], literal)
	}
	wantPayload, err := json.Marshal(want)
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
}

func TestDispatchEntryAppendedUnknownCustomTypeStaysSilent(t *testing.T) {
	cases := []struct {
		name  string
		entry map[string]any
	}{
		{
			name: "unshown_custom_type",
			entry: map[string]any{
				"type":       "custom",
				"id":         "entry-2",
				"customType": "senpi-task.usage",
				"data":       map[string]any{"tokens": 12},
			},
		},
		{
			name: "unshown_overflow_exponent",
			entry: map[string]any{
				"type":       "custom",
				"id":         "entry-2",
				"customType": "senpi-task.usage",
				"data":       map[string]any{"value": json.Number("1e400")},
			},
		},
		{
			name: "non_custom_entry",
			entry: map[string]any{
				"type":    "message",
				"id":      "entry-3",
				"role":    "assistant",
				"content": "hello",
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			// Given a live session.
			s, sub := acquireDrained(t, "tui-entry-"+tc.name)

			// When an entry_appended event carries an entry the engine
			// transcript does not render.
			injectEvent(t, s, map[string]any{"type": "entry_appended", "entry": tc.entry})
			frames := publishCompactionMarker(t, s, sub)

			// Then no frame is published for it.
			if eventFrames := dropAttachReady(frames); len(eventFrames) != 0 {
				t.Fatalf("%s published frames, want none: %+v", tc.name, eventFrames)
			}
		})
	}
}

func TestDispatchInteractiveApprovalStillRetained(t *testing.T) {
	// Given a live session.
	s, first := acquireDrained(t, "tui-approval-select")

	// When an interactive select request arrives.
	injectEvent(t, s, approvalEvent("approval-tui", "select"))
	_, live := first.await(t, FrameApproval)

	// Then the approval frame is published and retained for a later attach.
	if live.ApprovalID != "approval-tui" {
		t.Fatalf("live approval id = %q", live.ApprovalID)
	}
	late := &synchronousApprovalRecorder{recorder: newRecorder(16)}
	lateDetach := s.Attach(late)
	t.Cleanup(lateDetach)
	if frames := drainSync(late.recorder); !hasApproval(frames, "approval-tui") {
		t.Fatalf("interactive approval not retained for replay: %+v", frames)
	}
}

func TestDispatchNonInteractiveStatusMethodStillApproval(t *testing.T) {
	// Given a live session.
	s, sub := acquireDrained(t, "tui-approval-status")

	// When a non-interactive, non-notify ui request arrives.
	injectEvent(t, s, map[string]any{
		"type":   "extension_ui_request",
		"id":     "status-1",
		"method": "setStatus",
	})
	frames := publishCompactionMarker(t, s, sub)

	// Then the current approval-frame behavior is unchanged and nothing is
	// retained for a later attach.
	if got := counts(frames)[FrameApproval]; got != 1 {
		t.Fatalf("setStatus produced %d FrameApproval, want 1; frames=%+v", got, frames)
	}
	late := &synchronousApprovalRecorder{recorder: newRecorder(16)}
	lateDetach := s.Attach(late)
	t.Cleanup(lateDetach)
	if frames := drainSync(late.recorder); hasApproval(frames, "status-1") {
		t.Fatalf("setStatus retained for replay: %+v", frames)
	}
}

func TestDispatchHighReasoningWarningStillRawNotice(t *testing.T) {
	// Given a live session.
	s, sub := acquireDrained(t, "tui-warning-pinned")

	// When a previously-listed notice kind arrives.
	injectEvent(t, s, map[string]any{
		"type":    "high_reasoning_warning",
		"message": "reasoning budget low",
	})
	frames := publishCompactionMarker(t, s, sub)

	// Then exactly one verbatim notice is published for it.
	if got := counts(frames)[FrameNotice]; got != 1 {
		t.Fatalf("high_reasoning_warning produced %d FrameNotice, want 1; frames=%+v", got, frames)
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
	if data["kind"] != "high_reasoning_warning" || data["message"] != "reasoning budget low" {
		t.Fatalf("notice payload mutated: %+v", data)
	}
}
