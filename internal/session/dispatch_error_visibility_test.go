package session

import (
	"encoding/json"
	"testing"
)

const observedFailureText = "provider rejected the request"

func publishedAssistant(t *testing.T, frames []Frame) map[string]any {
	t.Helper()
	var message Frame
	count := 0
	for _, frame := range frames {
		if frame.Kind != FrameMessage {
			continue
		}
		message = frame
		count++
	}
	if count != 1 {
		t.Fatalf("published %d FrameMessage, want 1; frames=%+v", count, frames)
	}
	data, ok := message.Data.(map[string]any)
	if !ok {
		t.Fatalf("message data = %T, want map[string]any", message.Data)
	}
	nested, ok := data["message"].(map[string]any)
	if !ok {
		t.Fatalf("nested message = %T, want map[string]any; data=%+v", data["message"], data)
	}
	return nested
}

func noticeKindCount(frames []Frame, kind string) int {
	count := 0
	for _, frame := range frames {
		if frame.Kind != FrameNotice {
			continue
		}
		data, _ := frame.Data.(map[string]any)
		if data["kind"] == kind {
			count++
		}
	}
	return count
}

func assertNoErrorOutput(t *testing.T, frames []Frame) {
	t.Helper()
	if got := noticeKindCount(frames, "continuation_error"); got != 0 {
		t.Fatalf("published %d continuation_error notices, want 0; frames=%+v", got, frames)
	}
	for _, frame := range frames {
		if frame.Kind != FrameMessage {
			continue
		}
		data, _ := frame.Data.(map[string]any)
		nested, _ := data["message"].(map[string]any)
		if _, present := nested["errorMessage"]; present {
			t.Fatalf("published errorMessage on a turn that carried none on the wire: %+v", nested)
		}
	}
}

func TestMessagePayloadCarriesObservedFailureFields(t *testing.T) {
	cases := []struct {
		name string
		raw  map[string]any
	}{
		{
			name: "string-content",
			raw: map[string]any{
				"type": "message_end",
				"message": map[string]any{
					"role":         "assistant",
					"content":      "partial",
					"errorMessage": observedFailureText,
					"stopReason":   "error",
				},
			},
		},
		{
			name: "block-content",
			raw: map[string]any{
				"type": "message_end",
				"message": map[string]any{
					"role": "assistant",
					"content": []any{
						map[string]any{"type": "text", "text": "partial"},
					},
					"errorMessage": observedFailureText,
					"stopReason":   "error",
				},
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			payload := messagePayload(tc.raw)
			nested, ok := payload["message"].(map[string]any)
			if !ok {
				t.Fatalf("payload message = %T, want map[string]any; payload=%+v", payload["message"], payload)
			}
			if nested["errorMessage"] != observedFailureText {
				t.Fatalf("errorMessage = %v, want %q", nested["errorMessage"], observedFailureText)
			}
			if nested["stopReason"] != "error" {
				t.Fatalf("stopReason = %v, want %q", nested["stopReason"], "error")
			}
		})
	}
}

func TestMessagePayloadOmitsAbsentFailureFields(t *testing.T) {
	payload := messagePayload(map[string]any{
		"type": "message_end",
		"message": map[string]any{
			"role":    "assistant",
			"content": "hello",
		},
	})
	nested, ok := payload["message"].(map[string]any)
	if !ok {
		t.Fatalf("payload message = %T, want map[string]any", payload["message"])
	}
	if _, present := nested["errorMessage"]; present {
		t.Fatalf("errorMessage present without a wire value: %+v", nested)
	}
	if _, present := nested["stopReason"]; present {
		t.Fatalf("stopReason present without a wire value: %+v", nested)
	}
}

func TestDispatchFailedTurnCarriesErrorMessageAndStopReason(t *testing.T) {
	for _, eventType := range []string{"message", "message_end"} {
		t.Run(eventType, func(t *testing.T) {
			s, sub := acquireDrained(t, "failed-turn-"+eventType)

			injectEvent(t, s, map[string]any{
				"type": eventType,
				"message": map[string]any{
					"role":         "assistant",
					"content":      "partial",
					"errorMessage": observedFailureText,
					"stopReason":   "error",
				},
			})
			frames := publishCompactionMarker(t, s, sub)

			nested := publishedAssistant(t, frames)
			if nested["errorMessage"] != observedFailureText {
				t.Fatalf("errorMessage = %v, want the wire text verbatim", nested["errorMessage"])
			}
			if nested["stopReason"] != "error" {
				t.Fatalf("stopReason = %v, want %q", nested["stopReason"], "error")
			}
		})
	}
}

func TestDispatchFailedTurnDoesNotInventWording(t *testing.T) {
	s, sub := acquireDrained(t, "failed-turn-verbatim")

	injectEvent(t, s, map[string]any{
		"type": "message_end",
		"message": map[string]any{
			"role":         "assistant",
			"content":      "partial",
			"errorMessage": observedFailureText,
			"stopReason":   "error",
		},
	})
	frames := publishCompactionMarker(t, s, sub)

	nested := publishedAssistant(t, frames)
	if nested["errorMessage"] != observedFailureText {
		t.Fatalf("errorMessage mutated: %v", nested["errorMessage"])
	}
}

func TestDispatchContinuationErrorPublishesDurableNotice(t *testing.T) {
	s, sub := acquireDrained(t, "continuation-error-live")

	injectEvent(t, s, map[string]any{
		"type":    "continuation_error",
		"message": "provider stream ended mid-turn",
	})
	frames := publishCompactionMarker(t, s, sub)

	if got := noticeKindCount(frames, "continuation_error"); got != 1 {
		t.Fatalf("continuation_error produced %d FrameNotice, want 1; frames=%+v", got, frames)
	}
	var notice Frame
	for _, frame := range frames {
		if frame.Kind == FrameNotice {
			notice = frame
			break
		}
	}
	data, ok := notice.Data.(map[string]any)
	if !ok {
		t.Fatalf("notice data = %T, want map[string]any", notice.Data)
	}
	if data["kind"] != "continuation_error" {
		t.Fatalf("notice kind = %v, want continuation_error", data["kind"])
	}
	if data["message"] != "provider stream ended mid-turn" {
		t.Fatalf("notice message = %v, want the wire text verbatim", data["message"])
	}
	nid, _ := data["nid"].(string)
	at, _ := data["at"].(string)
	if nid == "" || at == "" {
		t.Fatalf("continuation_error missing journal identity: nid=%q at=%q", nid, at)
	}

	late := &synchronousApprovalRecorder{recorder: newRecorder(16)}
	lateDetach := s.Attach(late)
	t.Cleanup(lateDetach)
	replayed := drainSync(late.recorder)
	if got := noticeKindCount(replayed, "continuation_error"); got != 1 {
		t.Fatalf("late attach replayed %d continuation_error notices, want 1; frames=%+v", got, replayed)
	}
	for _, frame := range replayed {
		if frame.Kind != FrameNotice {
			continue
		}
		replay, ok := frame.Data.(map[string]any)
		if !ok {
			t.Fatalf("replayed notice data = %T", frame.Data)
		}
		if replay["kind"] != "continuation_error" || replay["message"] != "provider stream ended mid-turn" {
			t.Fatalf("replayed payload mutated: %+v", replay)
		}
		if replay["nid"] != nid || replay["at"] != at {
			t.Fatalf("replayed identity changed: live nid=%q at=%q replay nid=%v at=%v", nid, at, replay["nid"], replay["at"])
		}
		return
	}
}

func TestDispatchCancelledTurnProducesNoErrorOutput(t *testing.T) {
	s, sub := acquireDrained(t, "cancelled-turn")

	injectEvent(t, s, map[string]any{
		"type": "message_end",
		"message": map[string]any{
			"role":       "assistant",
			"content":    []any{map[string]any{"type": "text", "text": "[aborted]"}},
			"stopReason": "aborted",
		},
	})
	frames := publishCompactionMarker(t, s, sub)

	nested := publishedAssistant(t, frames)
	if nested["stopReason"] != "aborted" {
		t.Fatalf("cancelled stopReason = %v, want aborted passthrough", nested["stopReason"])
	}
	assertNoErrorOutput(t, frames)
	if got := counts(frames)[FrameNotice]; got != 0 {
		t.Fatalf("cancelled turn published %d FrameNotice, want 0; frames=%+v", got, frames)
	}
}

func TestDispatchToolOnlyTurnProducesNoErrorOutput(t *testing.T) {
	s, sub := acquireDrained(t, "tool-only-turn")

	injectEvent(t, s, map[string]any{
		"type": "message_end",
		"message": map[string]any{
			"role": "assistant",
			"content": []any{
				map[string]any{"type": "toolCall", "id": "t1", "name": "bash"},
			},
			"stopReason": "toolUse",
		},
	})
	frames := publishCompactionMarker(t, s, sub)

	nested := publishedAssistant(t, frames)
	if nested["stopReason"] != "toolUse" {
		t.Fatalf("tool-only stopReason = %v, want toolUse passthrough", nested["stopReason"])
	}
	assertNoErrorOutput(t, frames)
	if got := counts(frames)[FrameNotice]; got != 0 {
		t.Fatalf("tool-only turn published %d FrameNotice, want 0; frames=%+v", got, frames)
	}
}

func TestDispatchEntriesStreamKeepsFailureFields(t *testing.T) {
	s, sub := acquireDrained(t, "history-failure-fields")

	injectEvent(t, s, map[string]any{
		"type":   "entries.stream",
		"leafId": "leaf-1",
		"final":  true,
		"entries": []any{
			map[string]any{
				"type": "message",
				"id":   "e1",
				"message": map[string]any{
					"role": "assistant",
					"content": []any{
						map[string]any{"type": "text", "text": "partial"},
					},
					"errorMessage": observedFailureText,
					"stopReason":   "error",
				},
			},
		},
	})
	frames := publishCompactionMarker(t, s, sub)

	var page EntriesFrame
	found := false
	for _, frame := range frames {
		if frame.Kind != FrameEntries {
			continue
		}
		page, _ = frame.Data.(EntriesFrame)
		found = true
		break
	}
	if !found {
		t.Fatalf("entries.stream published no FrameEntries; frames=%+v", frames)
	}
	if len(page.Entries) != 1 {
		t.Fatalf("history page entries = %d, want 1", len(page.Entries))
	}
	var entry map[string]any
	if err := json.Unmarshal(page.Entries[0], &entry); err != nil {
		t.Fatalf("history entry: %v", err)
	}
	nested, ok := entry["message"].(map[string]any)
	if !ok {
		t.Fatalf("history nested message = %T; entry=%+v", entry["message"], entry)
	}
	if nested["errorMessage"] != observedFailureText {
		t.Fatalf("history errorMessage = %v, want the wire text verbatim", nested["errorMessage"])
	}
	if nested["stopReason"] != "error" {
		t.Fatalf("history stopReason = %v, want error", nested["stopReason"])
	}
}

func TestDispatchEntriesStreamCancelledAndToolOnlyHaveNoErrorMessage(t *testing.T) {
	cases := []struct {
		name    string
		message map[string]any
	}{
		{
			name: "cancelled",
			message: map[string]any{
				"role":       "assistant",
				"content":    []any{map[string]any{"type": "text", "text": "[aborted]"}},
				"stopReason": "aborted",
			},
		},
		{
			name: "tool-only",
			message: map[string]any{
				"role": "assistant",
				"content": []any{
					map[string]any{"type": "toolCall", "id": "t1", "name": "bash"},
				},
				"stopReason": "toolUse",
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s, sub := acquireDrained(t, "history-"+tc.name)
			injectEvent(t, s, map[string]any{
				"type":   "entries.stream",
				"leafId": "leaf-1",
				"final":  true,
				"entries": []any{
					map[string]any{"type": "message", "id": "e1", "message": tc.message},
				},
			})
			frames := publishCompactionMarker(t, s, sub)
			assertNoErrorOutput(t, frames)
			var page EntriesFrame
			for _, frame := range frames {
				if frame.Kind == FrameEntries {
					page, _ = frame.Data.(EntriesFrame)
					break
				}
			}
			if len(page.Entries) != 1 {
				t.Fatalf("history page entries = %d, want 1; frames=%+v", len(page.Entries), frames)
			}
			var entry map[string]any
			if err := json.Unmarshal(page.Entries[0], &entry); err != nil {
				t.Fatalf("history entry: %v", err)
			}
			nested, _ := entry["message"].(map[string]any)
			if _, present := nested["errorMessage"]; present {
				t.Fatalf("%s history invented errorMessage: %+v", tc.name, nested)
			}
		})
	}
}
