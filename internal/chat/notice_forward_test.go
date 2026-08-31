package chat

import (
	"encoding/json"
	"reflect"
	"strconv"
	"testing"
)

// noticeEnvelope is the parsed shape of a "notice" client frame.
type noticeEnvelope struct {
	Type      string          `json:"type"`
	SessionID string          `json:"sessionId"`
	Kind      string          `json:"kind"`
	Payload   json.RawMessage `json:"payload"`
	At        string          `json:"at"`
}

func collectNoticeFrames(t *testing.T, frames [][]byte) []noticeEnvelope {
	t.Helper()
	var out []noticeEnvelope
	for _, f := range frames {
		var env noticeEnvelope
		if json.Unmarshal(f, &env) == nil && env.Type == "notice" {
			out = append(out, env)
		}
	}
	return out
}

// Every omo advisory event family must forward as exactly one "notice" frame
// whose kind is the omo event type verbatim and whose payload is the bare
// advisory object without the provider's type or routing handle.
func TestAdvisoryEventsForwardedAsNotice(t *testing.T) {
	cases := []struct {
		eventType string
		payload   string
	}{
		{"high_reasoning_warning", `{"modelId":"gpt-5.6-sol","provider":"openai-codex","thinkingLevel":"xhigh"}`},
		{"retry_fallback_applied", `{"from":"a","to":"b","chainKey":"k","reason":"rate_limited"}`},
		{"retry_fallback_reverted", `{"from":"a","to":"b"}`},
		{"retry_fallback_succeeded", `{"to":"b"}`},
		{"retry_fallback_exhausted", `{"chainKey":"k"}`},
		{"server_fallback_aborted", `{"from":"a","to":"b","chainConfigured":true}`},
		{"auto_retry_start", `{"attempt":1}`},
		{"auto_retry_end", `{"attempt":2,"succeeded":true}`},
		{"summarization_retry_attempt_start", `{"attempt":1}`},
		{"summarization_retry_scheduled", `{"delayMs":500}`},
		{"summarization_retry_finished", `{"succeeded":true}`},
		{"settings_source_selected", `{"source":"project"}`},
	}
	for i, tc := range cases {
		t.Run(tc.eventType, func(t *testing.T) {
			writer := newCollectWriter()
			s := newTestSession("chat-notice-"+tc.eventType, writer)

			dispatchEvent(s, tc.eventType, `{"type":"`+tc.eventType+`","sessionId":"rpc-`+strconv.Itoa(i+1)+`",`+tc.payload[1:])
			frames := collectNoticeFrames(t, writer.snapshot())
			if len(frames) != 1 {
				t.Fatalf("notice frames = %d, want exactly 1; frames: %s", len(frames), writer.typesString())
			}
			env := frames[0]
			if env.Kind != tc.eventType {
				t.Fatalf("notice kind = %q, want %q", env.Kind, tc.eventType)
			}
			if env.SessionID != "chat-notice-"+tc.eventType {
				t.Fatalf("notice sessionId = %q, want chat-notice-%s", env.SessionID, tc.eventType)
			}
			var got, want any
			if err := json.Unmarshal(env.Payload, &got); err != nil {
				t.Fatalf("payload is not valid JSON: %v (%s)", err, env.Payload)
			}
			if err := json.Unmarshal([]byte(tc.payload), &want); err != nil {
				t.Fatalf("fixture payload is not valid JSON: %v", err)
			}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("payload = %s, want bare advisory object %s", env.Payload, tc.payload)
			}
		})
	}
}

// An extension_ui_request with method "notify" must forward as one notice
// frame of kind extension_notify carrying id/message/title (only the fields
// present), while the approval-path methods keep their behavior.
func TestExtensionNotifyForwardedAsNotice(t *testing.T) {
	writer := newCollectWriter()
	s := newTestSession("chat-ext-notify", writer)

	dispatchEvent(s, "extension_ui_request", `{"type":"extension_ui_request","id":"n1","method":"notify","title":"Heads up","message":"Compaction scheduled"}`)
	frames := collectNoticeFrames(t, writer.snapshot())
	if len(frames) != 1 {
		t.Fatalf("notice frames = %d, want exactly 1; frames: %s", len(frames), writer.typesString())
	}
	env := frames[0]
	if env.Kind != "extension_notify" {
		t.Fatalf("notice kind = %q, want extension_notify", env.Kind)
	}
	var got, want any
	if err := json.Unmarshal(env.Payload, &got); err != nil {
		t.Fatalf("payload is not valid JSON: %v (%s)", err, env.Payload)
	}
	if err := json.Unmarshal([]byte(`{"id":"n1","message":"Compaction scheduled","title":"Heads up"}`), &want); err != nil {
		t.Fatalf("fixture payload is not valid JSON: %v", err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("payload = %s, want id+message+title", env.Payload)
	}

	// A notify without title still forwards; title must be absent, not "".
	writer2 := newCollectWriter()
	s2 := newTestSession("chat-ext-notify-2", writer2)
	dispatchEvent(s2, "extension_ui_request", `{"type":"extension_ui_request","id":"n2","method":"notify","message":"only message"}`)
	frames2 := collectNoticeFrames(t, writer2.snapshot())
	if len(frames2) != 1 || frames2[0].Kind != "extension_notify" {
		t.Fatalf("notice frames = %+v, want exactly one extension_notify", frames2)
	}
	var payload map[string]any
	if err := json.Unmarshal(frames2[0].Payload, &payload); err != nil {
		t.Fatalf("payload is not valid JSON: %v (%s)", err, frames2[0].Payload)
	}
	if _, present := payload["title"]; present {
		t.Fatalf("absent title must not appear in payload: %s", frames2[0].Payload)
	}
	if payload["message"] != "only message" || payload["id"] != "n2" {
		t.Fatalf("payload = %s, want id+message passthrough", frames2[0].Payload)
	}
}

// The approval path must be untouched: a select-shaped extension_ui_request
// still yields an approval frame and no notice.
func TestApprovalSelectUnchangedByNoticeForwarding(t *testing.T) {
	writer := newCollectWriter()
	s := newTestSession("chat-select-approval", writer)

	dispatchEvent(s, "extension_ui_request", `{"type":"extension_ui_request","id":"a1","method":"select","title":"Pick","message":"one","options":["a","b"]}`)
	if got := countFramesOfType(writer.snapshot(), "approval"); got != 1 {
		t.Fatalf("approval frames = %d, want 1; frames: %s", got, writer.typesString())
	}
	if got := countFramesOfType(writer.snapshot(), "notice"); got != 0 {
		t.Fatalf("notice frames for select = %d, want 0; frames: %s", got, writer.typesString())
	}
}

// Transient notices are ephemeral: they forward live but must never enter
// the activity snapshot cache, so a client attaching afterwards receives no
// notice replay. Durable kinds have their own replay contract (see
// notice_durable_test.go); high_reasoning_warning is durable by design.
func TestTransientNoticesNeverReplayedToLateSubscriber(t *testing.T) {
	writer := newCollectWriter()
	s := newTestSession("chat-notice-ephemeral", writer)

	dispatchEvent(s, "auto_retry_start", `{"type":"auto_retry_start","attempt":1}`)
	if got := countFramesOfType(writer.snapshot(), "notice"); got != 1 {
		t.Fatalf("live notice frames = %d, want 1; frames: %s", got, writer.typesString())
	}

	late := newCollectWriter()
	s.Attach(late)
	if got := countFramesOfType(late.snapshot(), "notice"); got != 0 {
		t.Fatalf("replayed notice frames = %d, want 0 (transient notices must never be cached); frames: %s", got, late.typesString())
	}
}
