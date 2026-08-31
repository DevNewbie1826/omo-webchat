package chat

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"
)

func countFramesOfType(frames [][]byte, typ string) int {
	count := 0
	for _, frame := range frames {
		var envelope struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(frame, &envelope) == nil && envelope.Type == typ {
			count++
		}
	}
	return count
}

func TestSessionRunDoneProviderCompletionEvents(t *testing.T) {
	t.Run("omo waits for agent_settled", func(t *testing.T) {
		writer := newCollectWriter()
		session := func() *Session {
			s := func() *Session { s := newTestSession("chat-omo", writer); s.promptInFlight = true; return s }()
			s.provider = "omo"
			return s
		}()

		session.dispatch(Event{Type: "agent_end", Raw: json.RawMessage(`{"type":"agent_end"}`)})
		if got := countFramesOfType(writer.snapshot(), "run.done"); got != 0 {
			t.Fatalf("run.done count after agent_end = %d, want 0", got)
		}
		session.dispatch(Event{Type: "agent_settled", Raw: json.RawMessage(`{"type":"agent_settled"}`)})
		session.dispatch(Event{Type: "agent_settled", Raw: json.RawMessage(`{"type":"agent_settled"}`)})
		if got := countFramesOfType(writer.snapshot(), "run.done"); got != 1 {
			t.Fatalf("run.done count = %d, want 1; frames: %s", got, writer.typesString())
		}
	})
}

func TestSessionFailedProviderResponsesEmitExactError(t *testing.T) {
	for _, command := range []string{"prompt", "get_state", "get_available_models", "get_commands", "get_entries", "get_session_stats"} {
		t.Run(command, func(t *testing.T) {
			writer := newCollectWriter()
			session := func() *Session {
				s := func() *Session { s := newTestSession("chat-1", writer); s.promptInFlight = true; return s }()
				s.promptInFlight = true
				return s
			}()
			session.forwardResponse([]byte(`{"type":"response","command":"` + command + `","success":false,"error":"provider rejected request"}`))

			var got ErrorFrame
			_ = json.Unmarshal(writer.snapshot()[0], &got)
			want := ErrorFrame{Type: "error", SessionID: "chat-1", Code: "provider_error", Message: "provider rejected request", Command: command}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("error frame = %+v, want %+v", got, want)
			}
			session.mu.Lock()
			inFlight := session.promptInFlight
			session.mu.Unlock()
			if inFlight != (command != "prompt") {
				t.Fatalf("promptInFlight = %v after %s failure", inFlight, command)
			}
		})
	}
}

func TestSessionControlResultsAreTypedAndCorrelated(t *testing.T) {
	tests := []struct {
		name string
		raw  string
		want ControlResultFrame
	}{
		{
			name: "set_model success",
			raw:  `{"type":"response","command":"set_model","success":true,"id":"req-1","data":{"id":"m2"}}`,
			want: ControlResultFrame{Type: "control.result", SessionID: "chat-1", Command: "set_model", RequestID: "req-1", Success: true},
		},
		{
			name: "set_thinking_level failure",
			raw:  `{"type":"response","command":"set_thinking_level","success":false,"id":"req-2","error":"level rejected"}`,
			want: ControlResultFrame{Type: "control.result", SessionID: "chat-1", Command: "set_thinking_level", RequestID: "req-2", Success: false, Message: "level rejected"},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			writer := newCollectWriter()
			session := func() *Session { s := newTestSession("chat-1", writer); s.promptInFlight = true; return s }()
			session.forwardResponse([]byte(test.raw))

			frames := writer.snapshot()
			if len(frames) != 1 {
				t.Fatalf("frame count = %d, want 1; frames: %s", len(frames), writer.typesString())
			}
			var got ControlResultFrame
			_ = json.Unmarshal(frames[0], &got)
			if !reflect.DeepEqual(got, test.want) {
				t.Fatalf("control result = %+v, want %+v", got, test.want)
			}
		})
	}
}

func TestSessionHistoryProviderNormalization(t *testing.T) {
	t.Run("omo entries stay unchanged", func(t *testing.T) {
		writer := newCollectWriter()
		session := func() *Session {
			s := func() *Session { s := newTestSession("chat-omo", writer); s.promptInFlight = true; return s }()
			s.provider = "omo"
			return s
		}()
		session.forwardResponse([]byte(`{"type":"response","command":"get_entries","success":true,"data":{"entries":[{"type":"message","message":{"role":"user","content":"hi"}}]}}`))

		var frame EntriesFrame
		for _, raw := range writer.snapshot() {
			_ = json.Unmarshal(raw, &frame)
		}
		want := `[{"type":"message","message":{"role":"user","content":"hi"}}]`
		if string(frame.Entries) != want {
			t.Fatalf("entries = %s, want %s", frame.Entries, want)
		}
	})
}

func TestSessionCapturesProviderResumeIdentity(t *testing.T) {
	tests := []struct {
		name     string
		provider string
		raw      string
		want     string
	}{
		{name: "omo state session file beats session id", provider: "omo", raw: `{"type":"response","command":"get_state","success":true,"data":{"sessionFile":"/tmp/omo-1.jsonl","sessionId":"dummy-uuid"}}`, want: "/tmp/omo-1.jsonl"},
		{name: "omo state session path beats session id", provider: "omo", raw: `{"type":"response","command":"get_state","success":true,"data":{"sessionPath":"/tmp/omo-2.jsonl","sessionId":"dummy-uuid"}}`, want: "/tmp/omo-2.jsonl"},
		{name: "omo state path beats session id", provider: "omo", raw: `{"type":"response","command":"get_state","success":true,"data":{"path":"/tmp/omo-3.jsonl","sessionId":"dummy-uuid"}}`, want: "/tmp/omo-3.jsonl"},
		{name: "omo legacy session id fallback", provider: "omo", raw: `{"type":"response","command":"get_state","success":true,"data":{"sessionId":"omo-legacy-1"}}`, want: "omo-legacy-1"},
		{name: "omo new session id", provider: "omo", raw: `{"type":"response","command":"new_session","success":true,"data":{"sessionId":"omo-2"}}`, want: "omo-2"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			session := func() *Session { s := newTestSession("chat-1", nil); s.provider = test.provider; return s }()
			session.forwardResponse([]byte(test.raw))
			if got := session.PiSessionID(); got != test.want {
				t.Fatalf("resume identity = %q, want %q", got, test.want)
			}
		})
	}
}

func TestSessionModelNormalization(t *testing.T) {
	writer := newCollectWriter()
	session := func() *Session {
		s := func() *Session { s := newTestSession("chat-1", writer); s.promptInFlight = true; return s }()
		s.provider = "omo"
		return s
	}()

	session.forwardResponse([]byte(`{"type":"response","command":"get_state","success":true,"data":{"model":{"provider":"alpha","id":"shared","name":"Alpha","contextWindow":100}}}`))
	session.forwardResponse([]byte(`{"type":"response","command":"get_available_models","success":true,"data":{"models":[{"provider":"alpha","id":"shared","name":"Alpha"},{"provider":"beta","modelId":"shared","name":"Beta"}]}}`))

	var state map[string]any
	var models ModelsFrame
	for _, raw := range writer.snapshot() {
		var envelope struct {
			Type string `json:"type"`
		}
		_ = json.Unmarshal(raw, &envelope)
		switch envelope.Type {
		case "state":
			_ = json.Unmarshal(raw, &state)
		case "models":
			_ = json.Unmarshal(raw, &models)
		}
	}
	wantStateModel := map[string]any{"provider": "alpha", "modelId": "shared", "name": "Alpha"}
	if !reflect.DeepEqual(state["model"], wantStateModel) {
		t.Fatalf("state model = %#v, want %#v", state["model"], wantStateModel)
	}
	wantModels := []ModelOption{
		{Provider: "alpha", ModelID: "shared", Name: "Alpha"},
		{Provider: "beta", ModelID: "shared", Name: "Beta"},
	}
	if !reflect.DeepEqual(models.Models, wantModels) {
		t.Fatalf("models = %#v, want %#v", models.Models, wantModels)
	}
}

type discardFrameWriter struct{}

func (discardFrameWriter) WriteJSON([]byte) error { return nil }

func TestManagerAcquireReusesLiveSession(t *testing.T) {
	manager := NewManager()
	t.Cleanup(manager.CloseAll)
	opts := managedMockOptions(t, "chat-1")
	oldSession, _, err := manager.Acquire(context.Background(), opts)
	if err != nil {
		t.Fatalf("start old session: %v", err)
	}
	newSession, _, err := manager.Acquire(context.Background(), opts)
	if err != nil {
		t.Fatalf("start new session: %v", err)
	}
	if newSession != oldSession {
		t.Fatalf("acquire returned replacement %p, want live session %p", newSession, oldSession)
	}
	if got := manager.Get(opts.ID); got != oldSession {
		t.Fatalf("current session = %p, want %p", got, oldSession)
	}
	if err := oldSession.QueryState(); err != nil {
		t.Fatalf("live session no longer accepts commands: %v", err)
	}
}

func TestSessionForwardsLiveCustomMessageType(t *testing.T) {
	writer := newCollectWriter()
	session := func() *Session { s := newTestSession("chat-custom", writer); s.promptInFlight = true; return s }()

	session.forwardMessage(json.RawMessage(`{
		"type": "message_end",
		"message": {
			"role": "custom",
			"customType": "senpi-task.usage",
			"content": "<omo-senpi-task>hook</omo-senpi-task>",
			"timestamp": 42
		}
	}`))

	frames := writer.snapshot()
	if len(frames) != 1 {
		t.Fatalf("frames = %d, want 1", len(frames))
	}
	var frame struct {
		Message struct {
			Role       string `json:"role"`
			CustomType string `json:"customType"`
		} `json:"message"`
	}
	if err := json.Unmarshal(frames[0], &frame); err != nil {
		t.Fatalf("unmarshal message frame: %v", err)
	}
	if frame.Message.Role != "custom" {
		t.Fatalf("role = %q, want custom", frame.Message.Role)
	}
	if frame.Message.CustomType != "senpi-task.usage" {
		t.Fatalf("customType = %q, want senpi-task.usage", frame.Message.CustomType)
	}
}
