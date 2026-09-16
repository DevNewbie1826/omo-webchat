package session

import (
	"encoding/json"
	"testing"

	"github.com/DevNewbie1826/omo-webchat/internal/wscontract"
)

func TestDispatchApprovalClassifiesAnswerRequirement(t *testing.T) {
	cases := []struct {
		method string
		want   string
	}{
		{method: "setStatus", want: "false"},
		{method: "setWidget", want: "false"},
		{method: "select", want: "true"},
		{method: "confirm", want: "true"},
		{method: "input", want: "true"},
		{method: "editor", want: "true"},
		{method: "question", want: "true"},
		{method: "futureMethod", want: ""},
	}
	for _, tc := range cases {
		t.Run(tc.method, func(t *testing.T) {
			// Given a subscribed session and a request without a requestId.
			s, sub := acquireDrained(t, "classification-"+tc.method)
			event := approvalEvent("approval-1", tc.method)
			// The server, not the incoming payload, owns this classification.
			event["awaitsAnswer"] = "untrusted"

			// When the request is published.
			injectEvent(t, s, event)
			_, frame := sub.await(t, FrameApproval)
			encoded, err := json.Marshal(frame.Data)
			if err != nil {
				t.Fatal(err)
			}
			var payload map[string]json.RawMessage
			if err := json.Unmarshal(encoded, &payload); err != nil {
				t.Fatal(err)
			}

			// Then the published classification distinguishes all three states.
			if got := string(payload["awaitsAnswer"]); got != tc.want {
				t.Fatalf("awaitsAnswer = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestApprovalContractPreservesOptionalAnswerRequirement(t *testing.T) {
	for _, value := range []string{"true", "false", ""} {
		t.Run("value="+value, func(t *testing.T) {
			// Given a known approval with optional classification.
			wire := `{"type":"approval","sessionId":"s","id":"a","method":"select"`
			if value != "" {
				wire += `,"awaitsAnswer":` + value
			}
			wire += `}`

			// When it crosses the generated contract boundary and round-trips.
			frame, err := wscontract.ParseServerFrame([]byte(wire))
			if err != nil {
				t.Fatal(err)
			}
			encoded, err := json.Marshal(frame)
			if err != nil {
				t.Fatal(err)
			}
			var payload map[string]json.RawMessage
			if err := json.Unmarshal(encoded, &payload); err != nil {
				t.Fatal(err)
			}

			// Then false stays explicit and legacy omission stays absent.
			if got := string(payload["awaitsAnswer"]); got != value {
				t.Fatalf("awaitsAnswer = %q, want %q", got, value)
			}
		})
	}
}
