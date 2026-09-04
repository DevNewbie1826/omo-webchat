package omorpc

// Queue-contract protocol tests: the engine's public RPC surface for
// observing and clearing the per-session queue, as observed engine
// behavior. These pin the wire names, the typed state/event payloads, and
// the response data shapes.

import (
	"encoding/json"
	"strings"
	"testing"
)

// TestProtocolQueueCommandNames pins the queue commands' wire names and
// exact encoded request records.
func TestProtocolQueueCommandNames(t *testing.T) {
	if CmdGetFollowUpMessages != "get_follow_up_messages" {
		t.Fatalf("CmdGetFollowUpMessages = %q, want %q", CmdGetFollowUpMessages, "get_follow_up_messages")
	}
	if CmdClearQueue != "clear_queue" {
		t.Fatalf("CmdClearQueue = %q, want %q", CmdClearQueue, "clear_queue")
	}
	if EventQueueUpdate != "queue_update" {
		t.Fatalf("EventQueueUpdate = %q, want %q", EventQueueUpdate, "queue_update")
	}

	cases := []struct {
		name string
		cmd  Command
		want string
	}{
		{"get_follow_up_messages", GetFollowUpMessages{SessionID: "rpc-1"}, `{"id":"r1","sessionId":"rpc-1","type":"get_follow_up_messages"}`},
		{"clear_queue", ClearQueue{SessionID: "rpc-1"}, `{"id":"r1","sessionId":"rpc-1","type":"clear_queue"}`},
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

// TestProtocolQueueResponseDataDecoding pins the response data payloads of
// the queue commands.
func TestProtocolQueueResponseDataDecoding(t *testing.T) {
	t.Run("get_follow_up_messages", func(t *testing.T) {
		var data GetFollowUpMessagesData
		if err := json.Unmarshal([]byte(`{"messages":["first","second"]}`), &data); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		if len(data.Messages) != 2 || data.Messages[0] != "first" || data.Messages[1] != "second" {
			t.Fatalf("messages: %+v", data.Messages)
		}
	})
	t.Run("clear_queue", func(t *testing.T) {
		var data ClearQueueData
		if err := json.Unmarshal([]byte(`{"steering":["s1"],"followUp":["f1","f2"]}`), &data); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		if len(data.Steering) != 1 || data.Steering[0] != "s1" {
			t.Fatalf("steering: %+v", data.Steering)
		}
		if len(data.FollowUp) != 2 || data.FollowUp[0] != "f1" || data.FollowUp[1] != "f2" {
			t.Fatalf("followUp: %+v", data.FollowUp)
		}
	})
}

// TestProtocolSessionStateQueueFields pins the queue fields the engine's
// public state carries (get_state data payload decodes directly as a
// SessionState): followUp string list, ordered queue entries with delivery
// mode and enqueue order, and the total pending count.
func TestProtocolSessionStateQueueFields(t *testing.T) {
	line := `{"id":"r1","sessionId":"rpc-5","type":"response","command":"get_state","success":true,"data":{` +
		`"sessionId":"dur-1","sessionFile":"/s/dur-1.jsonl","thinkingLevel":"off","messageCount":1,` +
		`"followUp":["n2","n3"],` +
		`"ordered":[{"text":"s1","mode":"steer","enqueueOrder":1},{"text":"n2","mode":"followUp","enqueueOrder":2},{"text":"n3","mode":"followUp","enqueueOrder":3}],` +
		`"pendingMessageCount":3}}`
	in, err := DecodeLine([]byte(line))
	if err != nil {
		t.Fatalf("DecodeLine: %v", err)
	}
	if in.Response == nil {
		t.Fatalf("want Response, got %+v", in)
	}
	var state SessionState
	if err := json.Unmarshal(in.Response.Data, &state); err != nil {
		t.Fatalf("unmarshal SessionState: %v", err)
	}
	if len(state.FollowUp) != 2 || state.FollowUp[0] != "n2" || state.FollowUp[1] != "n3" {
		t.Fatalf("followUp: %+v", state.FollowUp)
	}
	wantOrdered := []QueuedMessage{
		{Text: "s1", Mode: "steer", EnqueueOrder: 1},
		{Text: "n2", Mode: "followUp", EnqueueOrder: 2},
		{Text: "n3", Mode: "followUp", EnqueueOrder: 3},
	}
	if len(state.Ordered) != len(wantOrdered) {
		t.Fatalf("ordered: %+v", state.Ordered)
	}
	for i, want := range wantOrdered {
		if state.Ordered[i] != want {
			t.Fatalf("ordered[%d] = %+v, want %+v", i, state.Ordered[i], want)
		}
	}
	if state.PendingMessageCount != 3 {
		t.Fatalf("pendingMessageCount = %d, want 3", state.PendingMessageCount)
	}
}

// TestProtocolSessionStateQueueFieldsOmitEmpty: an idle queue must not add
// queue keys to the encoded state.
func TestProtocolSessionStateQueueFieldsOmitEmpty(t *testing.T) {
	b, err := json.Marshal(SessionState{SessionID: "dur-1"})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	for _, key := range []string{"followUp", "ordered", "pendingMessageCount"} {
		if strings.Contains(string(b), key) {
			t.Fatalf("empty queue must omit %q, got %s", key, b)
		}
	}
}

// TestProtocolQueueUpdateEventParsing pins the typed payload parser for the
// queue_update event.
func TestProtocolQueueUpdateEventParsing(t *testing.T) {
	line := `{"type":"queue_update","sessionId":"rpc-2",` +
		`"followUp":["n1"],` +
		`"ordered":[{"text":"s1","mode":"steer","enqueueOrder":1},{"text":"n1","mode":"followUp","enqueueOrder":2}],` +
		`"pendingMessageCount":2}`
	in, err := DecodeLine([]byte(line))
	if err != nil {
		t.Fatalf("DecodeLine: %v", err)
	}
	if in.Event == nil || in.Event.Type != EventQueueUpdate {
		t.Fatalf("want queue_update event, got %+v", in)
	}
	qu, err := ParseQueueUpdate(in.Event)
	if err != nil {
		t.Fatalf("ParseQueueUpdate: %v", err)
	}
	if len(qu.FollowUp) != 1 || qu.FollowUp[0] != "n1" {
		t.Fatalf("followUp: %+v", qu.FollowUp)
	}
	wantOrdered := []QueuedMessage{
		{Text: "s1", Mode: "steer", EnqueueOrder: 1},
		{Text: "n1", Mode: "followUp", EnqueueOrder: 2},
	}
	if len(qu.Ordered) != len(wantOrdered) {
		t.Fatalf("ordered: %+v", qu.Ordered)
	}
	for i, want := range wantOrdered {
		if qu.Ordered[i] != want {
			t.Fatalf("ordered[%d] = %+v, want %+v", i, qu.Ordered[i], want)
		}
	}
	if qu.PendingMessageCount != 2 {
		t.Fatalf("pendingMessageCount = %d, want 2", qu.PendingMessageCount)
	}

	t.Run("empty_queue_payload", func(t *testing.T) {
		in, err := DecodeLine([]byte(`{"type":"queue_update","sessionId":"rpc-2","followUp":[],"ordered":[],"pendingMessageCount":0}`))
		if err != nil {
			t.Fatalf("DecodeLine: %v", err)
		}
		qu, err := ParseQueueUpdate(in.Event)
		if err != nil {
			t.Fatalf("ParseQueueUpdate: %v", err)
		}
		if len(qu.FollowUp) != 0 || len(qu.Ordered) != 0 || qu.PendingMessageCount != 0 {
			t.Fatalf("payload: %+v", qu)
		}
	})

	t.Run("nil_event_rejected", func(t *testing.T) {
		if _, err := ParseQueueUpdate(nil); err == nil {
			t.Fatal("nil event must error")
		}
	})

	t.Run("malformed_payload_rejected", func(t *testing.T) {
		in, err := DecodeLine([]byte(`{"type":"queue_update","sessionId":"rpc-2","followUp":"not-an-array"}`))
		if err != nil {
			t.Fatalf("DecodeLine: %v", err)
		}
		if _, err := ParseQueueUpdate(in.Event); err == nil {
			t.Fatal("malformed payload must error")
		}
	})
}
