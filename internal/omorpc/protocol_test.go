package omorpc

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"testing"
	"testing/iotest"
)

// mustJSON marshals v or fails the test.
func mustJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return string(b)
}

func TestProtocolEncodeFrameLF(t *testing.T) {
	enc, err := EncodeFrame(map[string]any{"type": "probe"})
	if err != nil {
		t.Fatalf("EncodeFrame: %v", err)
	}
	if !bytes.HasSuffix(enc, []byte{'\n'}) || bytes.HasSuffix(enc, []byte("\n\n")) {
		t.Fatalf("frame must end with exactly one LF, got %q", enc)
	}
	if bytes.Contains(bytes.TrimSuffix(enc, []byte{'\n'}), []byte{'\n'}) {
		t.Fatalf("frame must be a single line, got %q", enc)
	}
}

// TestProtocolEncodeRequestTable pins the exact wire record for every command
// in the typed union. encoding/json sorts map keys, so exact-string matches
// are deterministic.
func TestProtocolEncodeRequestTable(t *testing.T) {
	cases := []struct {
		name string
		cmd  Command
		want string
	}{
		{"get_protocol_info", GetProtocolInfo{}, `{"id":"r1","type":"get_protocol_info"}`},
		{"open_session_cwd", OpenSession{CWD: "/tmp/wk"}, `{"cwd":"/tmp/wk","id":"r1","type":"open_session"}`},
		{"open_session_resume", OpenSession{SessionPath: "/tmp/s.jsonl"}, `{"id":"r1","sessionPath":"/tmp/s.jsonl","type":"open_session"}`},
		{"close_session", CloseSession{SessionID: "rpc-1"}, `{"id":"r1","sessionId":"rpc-1","type":"close_session"}`},
		{"list_sessions", ListSessions{}, `{"id":"r1","type":"list_sessions"}`},
		{"prompt", Prompt{SessionID: "rpc-1", Message: "hi", StreamingBehavior: StreamingFollowUp}, `{"id":"r1","message":"hi","sessionId":"rpc-1","streamingBehavior":"followUp","type":"prompt"}`},
		{"prompt_steer", Prompt{SessionID: "rpc-1", Message: "hi", StreamingBehavior: StreamingSteer}, `{"id":"r1","message":"hi","sessionId":"rpc-1","streamingBehavior":"steer","type":"prompt"}`},
		{"steer", Steer{SessionID: "rpc-1", Message: "go left"}, `{"id":"r1","message":"go left","sessionId":"rpc-1","type":"steer"}`},
		{"follow_up", FollowUp{SessionID: "rpc-1", Message: "again"}, `{"id":"r1","message":"again","sessionId":"rpc-1","type":"follow_up"}`},
		{"abort", Abort{SessionID: "rpc-1"}, `{"id":"r1","sessionId":"rpc-1","type":"abort"}`},
		{"get_state", GetState{SessionID: "rpc-1"}, `{"id":"r1","sessionId":"rpc-1","type":"get_state"}`},
		{"get_available_models", GetAvailableModels{SessionID: "rpc-1"}, `{"id":"r1","sessionId":"rpc-1","type":"get_available_models"}`},
		{"get_entries", GetEntries{SessionID: "rpc-1"}, `{"id":"r1","sessionId":"rpc-1","type":"get_entries"}`},
		{"get_entries_since", GetEntries{SessionID: "rpc-1", Since: "entry-7"}, `{"id":"r1","sessionId":"rpc-1","since":"entry-7","type":"get_entries"}`},
		{"get_messages", GetMessages{SessionID: "rpc-1"}, `{"id":"r1","sessionId":"rpc-1","type":"get_messages"}`},
		{"get_commands", GetCommands{SessionID: "rpc-1"}, `{"id":"r1","sessionId":"rpc-1","type":"get_commands"}`},
		{"get_session_stats", GetSessionStats{SessionID: "rpc-1"}, `{"id":"r1","sessionId":"rpc-1","type":"get_session_stats"}`},
		{"set_session_name", SetSessionName{SessionID: "rpc-1", Name: "work"}, `{"id":"r1","name":"work","sessionId":"rpc-1","type":"set_session_name"}`},
		{"set_model", SetModel{SessionID: "rpc-1", Provider: "anthropic", ModelID: "claude-x"}, `{"id":"r1","modelId":"claude-x","provider":"anthropic","sessionId":"rpc-1","type":"set_model"}`},
		{"set_thinking_level", SetThinkingLevel{SessionID: "rpc-1", Level: "high"}, `{"id":"r1","level":"high","sessionId":"rpc-1","type":"set_thinking_level"}`},
		{"compact", Compact{SessionID: "rpc-1"}, `{"id":"r1","sessionId":"rpc-1","type":"compact"}`},
		{"set_auto_compaction_off", SetAutoCompaction{SessionID: "rpc-1", Enabled: false}, `{"enabled":false,"id":"r1","sessionId":"rpc-1","type":"set_auto_compaction"}`},
		{"set_auto_compaction_on", SetAutoCompaction{SessionID: "rpc-1", Enabled: true}, `{"enabled":true,"id":"r1","sessionId":"rpc-1","type":"set_auto_compaction"}`},
		{"extension_request", ExtensionRequest{SessionID: "rpc-1", Name: "pick", Data: json.RawMessage(`{"a":1}`)}, `{"data":{"a":1},"id":"r1","name":"pick","sessionId":"rpc-1","type":"extension_request"}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := EncodeRequest("r1", tc.cmd)
			if err != nil {
				t.Fatalf("EncodeRequest: %v", err)
			}
			if string(got) != tc.want+"\n" {
				t.Fatalf("wire mismatch\n got: %s\nwant: %s", got, tc.want+"\n")
			}
		})
	}
}

// TestProtocolExtensionUIResponseOneWay pins the one-way extension_ui_response:
// no fresh correlation id is assigned; the native dialog id travels unchanged.
func TestProtocolExtensionUIResponseOneWay(t *testing.T) {
	cmd := ExtensionUIResponse{SessionID: "rpc-7", ID: "dlg-42", Value: json.RawMessage(`{"choice":"ok"}`)}
	got, err := EncodeNotification(cmd)
	if err != nil {
		t.Fatalf("EncodeNotification: %v", err)
	}
	want := `{"id":"dlg-42","sessionId":"rpc-7","type":"extension_ui_response","value":{"choice":"ok"}}` + "\n"
	if string(got) != want {
		t.Fatalf("wire mismatch\n got: %s\nwant: %s", got, want)
	}
}

func TestProtocolRequestID(t *testing.T) {
	a, b := NewRequestID(), NewRequestID()
	if a == "" || b == "" || a == b {
		t.Fatalf("NewRequestID must produce distinct non-empty ids, got %q and %q", a, b)
	}
}

// TestProtocolDecodeClassify covers inbound classification: response envelopes
// vs unsolicited events, unknown event preservation, CRLF tolerance, and
// malformed input.
func TestProtocolDecodeClassify(t *testing.T) {
	cases := []struct {
		name    string
		line    string
		wantErr bool
		check   func(t *testing.T, in *Inbound)
	}{
		{
			name: "response_success_with_session",
			line: `{"id":"r1","sessionId":"rpc-1","type":"response","command":"get_state","success":true,"data":{"messageCount":3}}`,
			check: func(t *testing.T, in *Inbound) {
				r := in.Response
				if r == nil || in.Event != nil {
					t.Fatalf("want Response, got %+v", in)
				}
				if r.ID != "r1" || r.SessionID != "rpc-1" || r.Command != "get_state" || !r.Success {
					t.Fatalf("response fields: %+v", r)
				}
				if string(r.Data) != `{"messageCount":3}` {
					t.Fatalf("data: %s", r.Data)
				}
				if r.Error != "" {
					t.Fatalf("unexpected error field: %q", r.Error)
				}
			},
		},
		{
			name: "response_failure",
			line: `{"id":"r2","type":"response","command":"open_session","success":false,"error":"unknown_session"}`,
			check: func(t *testing.T, in *Inbound) {
				r := in.Response
				if r == nil {
					t.Fatalf("want Response, got %+v", in)
				}
				if r.Success || r.Error != "unknown_session" {
					t.Fatalf("failure fields: %+v", r)
				}
			},
		},
		{
			name: "known_event",
			line: `{"type":"agent_idle","sessionId":"rpc-1","extra":7}`,
			check: func(t *testing.T, in *Inbound) {
				ev := in.Event
				if ev == nil || in.Response != nil {
					t.Fatalf("want Event, got %+v", in)
				}
				if ev.Type != "agent_idle" || ev.SessionID != "rpc-1" {
					t.Fatalf("event fields: %+v", ev)
				}
				if !bytes.Equal(ev.Raw, []byte(`{"type":"agent_idle","sessionId":"rpc-1","extra":7}`)) {
					t.Fatalf("raw not preserved: %s", ev.Raw)
				}
			},
		},
		{
			name: "unknown_event_type_preserved",
			line: `{"type":"hologram_event","sessionId":"rpc-2","x":true}`,
			check: func(t *testing.T, in *Inbound) {
				ev := in.Event
				if ev == nil {
					t.Fatalf("want Event, got %+v", in)
				}
				if ev.Type != "hologram_event" {
					t.Fatalf("unknown event type must be preserved verbatim, got %q", ev.Type)
				}
				ue := AsUnknownEvent(ev)
				if ue.Type != UnknownEventType || ue.EventType != "hologram_event" {
					t.Fatalf("normalization: %+v", ue)
				}
				if !bytes.Contains(ue.Payload, []byte(`"x":true`)) {
					t.Fatalf("payload not preserved: %s", ue.Payload)
				}
			},
		},
		{
			name:    "crlf_tolerated",
			line:    "{\"type\":\"agent_end\",\"sessionId\":\"rpc-1\"}\r",
			wantErr: false,
			check: func(t *testing.T, in *Inbound) {
				if in.Event == nil || in.Event.Type != "agent_end" {
					t.Fatalf("crlf line must decode, got %+v", in)
				}
			},
		},
		{
			name:    "invalid_json",
			line:    `{not json`,
			wantErr: true,
		},
		{
			name:    "empty_line",
			line:    ``,
			wantErr: true,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			in, err := DecodeLine([]byte(tc.line))
			if tc.wantErr {
				if err == nil {
					t.Fatalf("want error, got %+v", in)
				}
				return
			}
			if err != nil {
				t.Fatalf("DecodeLine: %v", err)
			}
			tc.check(t, in)
		})
	}
}

// TestProtocolDecodeCommandFieldShapes pins inbound command-field typing:
// event frames accept any JSON shape for "command"; response frames require
// a JSON string (missing/null stay empty).
func TestProtocolDecodeCommandFieldShapes(t *testing.T) {
	t.Run("event_command_object", func(t *testing.T) {
		line := `{"type":"command_invocation","sessionId":"rpc-1","command":{"name":"wish","source":"prompt"}}`
		in, err := DecodeLine([]byte(line))
		if err != nil {
			t.Fatalf("DecodeLine: %v", err)
		}
		if in.Event == nil || in.Response != nil {
			t.Fatalf("want Event, got %+v", in)
		}
		if in.Event.Type != "command_invocation" {
			t.Fatalf("type: %q", in.Event.Type)
		}
		if !bytes.Equal(in.Event.Raw, []byte(line)) {
			t.Fatalf("raw not preserved: %s", in.Event.Raw)
		}
	})
	t.Run("response_command_string", func(t *testing.T) {
		line := `{"id":"r1","type":"response","command":"prompt","success":true}`
		in, err := DecodeLine([]byte(line))
		if err != nil {
			t.Fatalf("DecodeLine: %v", err)
		}
		if in.Response == nil || in.Event != nil {
			t.Fatalf("want Response, got %+v", in)
		}
		if in.Response.Command != "prompt" {
			t.Fatalf("command: %q", in.Response.Command)
		}
	})
	t.Run("event_command_number", func(t *testing.T) {
		line := `{"type":"command_invocation","sessionId":"rpc-1","command":7}`
		in, err := DecodeLine([]byte(line))
		if err != nil {
			t.Fatalf("DecodeLine: %v", err)
		}
		if in.Event == nil || in.Event.Type != "command_invocation" {
			t.Fatalf("want Event, got %+v", in)
		}
	})
	t.Run("response_command_object", func(t *testing.T) {
		line := `{"id":"r1","type":"response","command":{"name":"wish"},"success":true}`
		in, err := DecodeLine([]byte(line))
		if err == nil {
			t.Fatalf("want error, got %+v", in)
		}
		if !strings.HasPrefix(err.Error(), "omorpc: decode frame:") {
			t.Fatalf("error prefix: %v", err)
		}
	})
}

// TestProtocolUnknownEventEnvelope pins the forward-compat envelope wire form.
func TestProtocolUnknownEventEnvelope(t *testing.T) {
	ue := &UnknownEvent{Type: UnknownEventType, EventType: "hologram_event", Payload: json.RawMessage(`{"x":1}`)}
	got, err := EncodeFrame(ue)
	if err != nil {
		t.Fatalf("EncodeFrame: %v", err)
	}
	want := `{"type":"unknown","eventType":"hologram_event","payload":{"x":1}}` + "\n"
	if string(got) != want {
		t.Fatalf("wire mismatch\n got: %s\nwant: %s", got, want)
	}
	in, err := DecodeLine(bytes.TrimRight(got, "\n"))
	if err != nil {
		t.Fatalf("decode own envelope: %v", err)
	}
	if in.Event == nil || in.Event.Type != UnknownEventType {
		t.Fatalf("envelope must decode back as an unknown-type event, got %+v", in)
	}
}

// TestProtocolDecoderFragmented feeds frames one byte at a time: the decoder
// must buffer fragmented reads and tolerate CRLF line endings.
func TestProtocolDecoderFragmented(t *testing.T) {
	stream := "" +
		`{"id":"r1","type":"response","command":"get_protocol_info","success":true,"data":{}}` + "\n" +
		"{\"type\":\"turn_start\",\"sessionId\":\"rpc-1\"}\r\n" +
		`{"id":"r2","type":"response","command":"abort","success":false,"error":"session_closing"}` + "\n"
	dec := NewDecoder(iotest.OneByteReader(strings.NewReader(stream)))

	first, err := dec.Decode()
	if err != nil {
		t.Fatalf("decode 1: %v", err)
	}
	if first.Response == nil || first.Response.Command != "get_protocol_info" {
		t.Fatalf("frame 1: %+v", first)
	}
	second, err := dec.Decode()
	if err != nil {
		t.Fatalf("decode 2 (crlf): %v", err)
	}
	if second.Event == nil || second.Event.Type != "turn_start" {
		t.Fatalf("frame 2: %+v", second)
	}
	third, err := dec.Decode()
	if err != nil {
		t.Fatalf("decode 3: %v", err)
	}
	if third.Response == nil || third.Response.Error != "session_closing" {
		t.Fatalf("frame 3: %+v", third)
	}
	if _, err := dec.Decode(); !errors.Is(err, io.EOF) {
		t.Fatalf("want io.EOF after last frame, got %v", err)
	}
}

// TestProtocolDecoderTrailingLine pins the buffering semantics documented on
// Decoder.Decode: a final line missing its LF is accepted at EOF when it
// parses as a complete JSON object; a truncated record is an error, not a
// silently dropped frame.
func TestProtocolDecoderTrailingLine(t *testing.T) {
	t.Run("complete_record_without_lf_accepted", func(t *testing.T) {
		dec := NewDecoder(strings.NewReader(`{"type":"agent_start","sessionId":"rpc-1"}`))
		in, err := dec.Decode()
		if err != nil {
			t.Fatalf("unterminated complete record must decode: %v", err)
		}
		if in.Event == nil || in.Event.Type != "agent_start" {
			t.Fatalf("frame: %+v", in)
		}
		if _, err := dec.Decode(); !errors.Is(err, io.EOF) {
			t.Fatalf("want io.EOF, got %v", err)
		}
	})
	t.Run("truncated_record_rejected", func(t *testing.T) {
		dec := NewDecoder(strings.NewReader(`{"id":"r1","type":"res`))
		if _, err := dec.Decode(); err == nil || errors.Is(err, io.EOF) {
			t.Fatalf("truncated record must error, got %v", err)
		}
	})
}

// TestProtocolSessionStateDecoding pins the open_session data payload.
func TestProtocolSessionStateDecoding(t *testing.T) {
	line := `{"id":"r1","sessionId":"rpc-3","type":"response","command":"open_session","success":true,` +
		`"data":{"sessionId":"rpc-3","state":{"sessionId":"d0b0-uuid","sessionFile":"/home/.omo/sessions/d0b0-uuid.jsonl",` +
		`"model":{"id":"claude-x"},"thinkingLevel":"medium","sessionName":"Established name","entries":[],"messageCount":0}}}`
	in, err := DecodeLine([]byte(line))
	if err != nil {
		t.Fatalf("DecodeLine: %v", err)
	}
	if in.Response == nil {
		t.Fatalf("want Response, got %+v", in)
	}
	var data OpenSessionData
	if err := json.Unmarshal(in.Response.Data, &data); err != nil {
		t.Fatalf("unmarshal OpenSessionData: %v", err)
	}
	if in.Response.SessionID != "rpc-3" {
		t.Fatalf("handle sessionId (response envelope): %q", in.Response.SessionID)
	}
	if data.State.SessionID != "d0b0-uuid" || data.State.SessionFile != "/home/.omo/sessions/d0b0-uuid.jsonl" ||
		data.State.ThinkingLevel != "medium" || data.State.SessionName != "Established name" || data.State.MessageCount != 0 {
		t.Fatalf("state: %+v", data.State)
	}
}

// TestProtocolProtocolInfoDecoding pins the get_protocol_info data payload.
func TestProtocolProtocolInfoDecoding(t *testing.T) {
	line := `{"id":"r1","type":"response","command":"get_protocol_info","success":true,` +
		`"data":{"protocolVersion":1,"serverVersion":"1.2.3","capabilities":["multi_session","extension_events","custom_unsupported"],"mode":"multi"}}`
	in, err := DecodeLine([]byte(line))
	if err != nil {
		t.Fatalf("DecodeLine: %v", err)
	}
	var info ProtocolInfo
	if err := json.Unmarshal(in.Response.Data, &info); err != nil {
		t.Fatalf("unmarshal ProtocolInfo: %v", err)
	}
	if info.ProtocolVersion != 1 || info.ServerVersion != "1.2.3" || info.Mode != "multi" ||
		len(info.Capabilities) != 3 || info.Capabilities[0] != "multi_session" {
		t.Fatalf("info: %+v", info)
	}
}

func TestProtocolStableErrors(t *testing.T) {
	cases := []struct {
		wire   string
		code   string
		detail string
		stable bool
	}{
		{wire: "unknown_session", code: ErrCodeUnknownSession, stable: true},
		{wire: "session_closing", code: ErrCodeSessionClosing, stable: true},
		{wire: "session_path_in_use", code: ErrCodeSessionPathInUse, stable: true},
		{wire: "missing_session_id", code: ErrCodeMissingSessionID, stable: true},
		{wire: "multi_session_disabled", code: ErrCodeMultiSessionDisabled, stable: true},
		{wire: "invalid_path", code: ErrCodeInvalidPath, stable: true},
		{wire: "too_many_sessions", code: ErrCodeTooManySessions, stable: true},
		{wire: "open_failed: no such directory", code: ErrCodeOpenFailed, detail: "no such directory", stable: true},
		{wire: "provider exploded", stable: false},
		{wire: "unknown_session_extra", stable: false},
	}
	for _, tc := range cases {
		se, ok := ParseStableError(tc.wire)
		if ok != tc.stable {
			t.Errorf("ParseStableError(%q) stable=%v, want %v", tc.wire, ok, tc.stable)
			continue
		}
		if !tc.stable {
			continue
		}
		if se.Code != tc.code || se.Detail != tc.detail {
			t.Errorf("ParseStableError(%q) = %+v, want code=%q detail=%q", tc.wire, se, tc.code, tc.detail)
		}
		if se.Error() != tc.wire {
			t.Errorf("Error() roundtrip: got %q, want %q", se.Error(), tc.wire)
		}
	}
}

func TestProtocolErrorFromResponse(t *testing.T) {
	if err := ErrorFromResponse(&Response{Success: true}); err != nil {
		t.Fatalf("success response must map to nil, got %v", err)
	}

	resp := &Response{Success: false, Error: "open_failed: permission denied"}
	err := ErrorFromResponse(resp)
	var se *StableError
	if !errors.As(err, &se) {
		t.Fatalf("want *StableError, got %T (%v)", err, err)
	}
	if se.Code != ErrCodeOpenFailed || se.Detail != "permission denied" {
		t.Fatalf("open_failed parse: %+v", se)
	}

	resp = &Response{Success: false, Error: "unknown_session"}
	err = ErrorFromResponse(resp)
	if !errors.As(err, &se) || se.Code != ErrCodeUnknownSession || se.Detail != "" {
		t.Fatalf("unknown_session parse: %v", err)
	}

	resp = &Response{Success: false, Error: "something transient"}
	err = ErrorFromResponse(resp)
	if err == nil || errors.As(err, &se) {
		t.Fatalf("non-stable error must not be *StableError, got %T (%v)", err, err)
	}
}
