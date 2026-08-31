package chat

import (
	"encoding/json"
	"reflect"
	"testing"
)

func Test_session_info_changed_emits_name_frame_and_callback(t *testing.T) {
	// Given
	writer := newCollectWriter()
	session := newTestSession("chat-1", writer)
	var gotSession *Session
	var gotName string
	session.onProviderName = func(source *Session, name string) {
		gotSession = source
		gotName = name
	}

	// When
	session.dispatch(Event{
		Type: "session_info_changed",
		Raw:  json.RawMessage(`{"type":"session_info_changed","name":"Weekly review"}`),
	})

	// Then
	frames := writer.snapshot()
	if len(frames) != 1 {
		t.Fatalf("frame count = %d, want 1; frames: %s", len(frames), writer.typesString())
	}
	var got NameFrame
	if err := json.Unmarshal(frames[0], &got); err != nil {
		t.Fatalf("unmarshal name frame: %v", err)
	}
	want := NameFrame{Type: "chat.name", SessionID: "chat-1", Name: "Weekly review", Origin: "provider"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("name frame = %+v, want %+v", got, want)
	}
	if gotSession != session || gotName != "Weekly review" {
		t.Fatalf("OnProviderName(session=%p, name=%q), want (%p, %q)", gotSession, gotName, session, "Weekly review")
	}
}

func Test_set_session_name_failure_emits_no_error_frame(t *testing.T) {
	// Given
	writer := newCollectWriter()
	session := newTestSession("chat-1", writer)

	// When
	session.dispatch(Event{
		Type: "response",
		Raw:  json.RawMessage(`{"type":"response","command":"set_session_name","success":false,"error":"rename failed"}`),
	})

	// Then
	if frames := writer.snapshot(); len(frames) != 0 {
		t.Fatalf("expected no frames after set_session_name failure, got: %s", writer.typesString())
	}
}
