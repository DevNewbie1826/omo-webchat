package wscontract

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestTodoWireBoundary(t *testing.T) {
	if NewServerFrame("chat.todo") == nil {
		t.Error("chat.todo is not registered")
	}
	for _, fx := range loadFixtures(t) {
		if strings.HasPrefix(fx.name, "server-chat.todo") || fx.name == "server-ready-binding.json" {
			frame, err := ParseServerFrame(fx.data)
			assertRoundtrip(t, fx.name, fx.data, frame, err)
			if _, unknown := frame.(UnknownFrame); unknown {
				t.Errorf("%s parsed as unknown", fx.name)
			}
		}
		if strings.HasPrefix(fx.name, "invalid-server-chat.todo") || strings.HasPrefix(fx.name, "invalid-server-ready-binding") {
			if _, err := ParseServerFrame(fx.data); err == nil {
				t.Errorf("%s accepted corrupt frame", fx.name)
			}
		}
	}
}

func TestTodoFieldCombinations(t *testing.T) {
	const valid = `{"type":"chat.todo","sessionId":"chat-1","durableSessionId":"durable-1","bindingId":"binding-1","requestGeneration":1,"status":"ready","source":{"leafId":"leaf","entryId":"entry","entryIndex":0,"kind":"custom"},"phases":[]}`
	cases := []struct{ old, replacement string }{
		{`"requestGeneration":1`, `"requestGeneration":-1`},
		{`"requestGeneration":1`, `"requestGeneration":0.5`},
		{`"requestGeneration":1`, `"requestGeneration":9007199254740992`},
		{`"bindingId":"binding-1"`, `"bindingId":""`},
		{`"durableSessionId":"durable-1"`, `"durableSessionId":""`},
		{`"sessionId":"chat-1"`, `"sessionId":""`},
		{`"phases":[]`, `"phases":null`},
		{`"phases":[]`, `"phases":[{}]`},
		{`"phases":[]`, `"phases":[{"name":"p","tasks":[{"content":"t","status":"future"}]}]`},
		{`"phases":[]`, `"phases":[],"error":"invalid-state"`},
		{`"entryIndex":0`, `"entryIndex":-1`},
		{`"entryIndex":0`, `"entryIndex":9007199254740992`},
		{`"entryId":"entry"`, `"entryId":null`},
		{`"leafId":"leaf"`, `"leafId":null`},
		{`"kind":"custom"`, `"kind":"absent"`},
	}
	for _, tc := range cases {
		raw := strings.Replace(valid, tc.old, tc.replacement, 1)
		if _, err := ParseServerFrame([]byte(raw)); err == nil {
			t.Errorf("accepted %s", raw)
		}
	}
	for _, generation := range []string{"0", "9007199254740991"} {
		raw := []byte(strings.Replace(valid, `"requestGeneration":1`, `"requestGeneration":`+generation, 1))
		frame, err := ParseServerFrame(raw)
		assertRoundtrip(t, generation, raw, frame, err)
	}
	for _, raw := range []string{
		`{"type":"ready","sessionId":"chat-1","piSessionId":"durable-1","resumed":false}`,
		`{"type":"ready","sessionId":"chat-1","piSessionId":null,"resumed":false}`,
	} {
		frame, err := ParseServerFrame([]byte(raw))
		assertRoundtrip(t, "legacy ready", []byte(raw), frame, err)
	}
	for _, raw := range []string{
		`{"type":"ready","sessionId":"chat-1","piSessionId":"durable-1","resumed":false,"bindingId":""}`,
		`{"type":"ready","sessionId":"chat-1","piSessionId":null,"resumed":false,"bindingId":"binding-1"}`,
	} {
		if _, err := ParseServerFrame([]byte(raw)); err == nil {
			t.Errorf("accepted %s", raw)
		}
	}
}

// Parsing alone can hide constructor omission bugs through ExtraFields.
func TestTodoConstructedPhases(t *testing.T) {
	var absent []TodoPhase
	clear := []TodoPhase{}
	namedEmpty := []TodoPhase{{Name: "empty", Tasks: []TodoTask{}}}
	leaf, entry, index := "leaf", "entry", int64(0)
	failure := "invalid-state"
	for _, tc := range []struct {
		name               string
		phases             *[]TodoPhase
		source             *TodoSource
		error              *string
		status, wantPhases string
	}{
		{"unavailable", nil, nil, &failure, "unavailable", ""},
		{"absent", &absent, &TodoSource{Kind: "absent"}, nil, "ready", "null"},
		{"clear", &clear, &TodoSource{LeafID: &leaf, EntryID: &entry, EntryIndex: &index, Kind: "custom"}, nil, "ready", "[]"},
		{"named empty", &namedEmpty, &TodoSource{LeafID: &leaf, EntryID: &entry, EntryIndex: &index, Kind: "legacy-tool"}, nil, "ready", `[{"name":"empty","tasks":[]}]`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			frame := ChatTodoFrame{Type: "chat.todo", SessionID: "chat-1", DurableSessionID: "durable-1", BindingID: "binding-1", RequestGeneration: 1, Status: tc.status, Phases: tc.phases, Source: tc.source, Error: tc.error}
			raw, err := json.Marshal(frame)
			if err != nil {
				t.Fatal(err)
			}
			var fields map[string]json.RawMessage
			if err := json.Unmarshal(raw, &fields); err != nil {
				t.Fatal(err)
			}
			if string(fields["phases"]) != tc.wantPhases {
				t.Fatalf("phases = %s, want %q; wire %s", fields["phases"], tc.wantPhases, raw)
			}
			decoded, err := ParseServerFrame(raw)
			assertRoundtrip(t, tc.name, raw, decoded, err)
		})
	}
}
