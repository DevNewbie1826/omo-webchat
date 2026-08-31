package api

import (
	"encoding/json"
	"testing"
	"time"
)

type ackFrame struct {
	Type      string `json:"type"`
	SessionID string `json:"sessionId"`
	Command   string `json:"command"`
	ID        string `json:"id"`
	RequestID string `json:"requestId"`
}

// waitForAck blocks until an ack frame for the given command arrives and
// returns its position in the collected frame stream so callers can assert
// ordering against later frames.
func waitForAck(t *testing.T, frames *frameCollector, command string, timeout time.Duration) int {
	t.Helper()
	deadline := time.After(timeout)
	for {
		for index, raw := range frames.snapshot() {
			var frame ackFrame
			if json.Unmarshal(raw, &frame) == nil && frame.Type == "ack" && frame.Command == command {
				return index
			}
		}
		select {
		case <-frames.notify:
		case <-deadline:
			t.Fatalf("timed out waiting for ack %q; have: %s", command, frames.types())
		}
	}
}

func frameIndexOfType(t *testing.T, frames *frameCollector, typ string) int {
	t.Helper()
	for index, raw := range frames.snapshot() {
		var envelope struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(raw, &envelope) == nil && envelope.Type == typ {
			return index
		}
	}
	return -1
}

func TestWebSocketControlAcksFollowAcceptedSets(t *testing.T) {
	harness := newProviderWSHarness(t, "omo", "", nil)
	harness.create(t)
	harness.frames.waitFor(t, "state", 3*time.Second)

	writeFrame(t, harness.client, map[string]any{
		"type":      "chat.set",
		"sessionId": harness.chat.ID,
		"model":     map[string]any{"provider": "mock", "modelId": "mock-model"},
	})
	modelAck := waitForAck(t, harness.frames, "set_model", 3*time.Second)

	writeFrame(t, harness.client, map[string]any{
		"type":          "chat.set",
		"sessionId":     harness.chat.ID,
		"thinkingLevel": "high",
	})
	thinkingAck := waitForAck(t, harness.frames, "set_thinking_level", 3*time.Second)

	if modelAck >= thinkingAck {
		t.Fatalf("ack order model=%d thinking=%d, want model first", modelAck, thinkingAck)
	}
	for _, raw := range harness.frames.snapshot() {
		var envelope struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(raw, &envelope) == nil && envelope.Type == "error" {
			t.Fatalf("unexpected error frame: %s", raw)
		}
	}
}

func TestWebSocketApprovalAckOrderedBeforeResumedStream(t *testing.T) {
	harness := newProviderWSHarness(t, "omo", "", map[string]string{"MOCK_PI_APPROVE": "1"})
	harness.create(t)
	harness.frames.waitFor(t, "state", 3*time.Second)

	writeFrame(t, harness.client, map[string]any{
		"type":      "chat.send",
		"sessionId": harness.chat.ID,
		"run":       map[string]any{"kind": "prompt", "message": "needs approval"},
	})
	harness.frames.waitFor(t, "approval", 3*time.Second)
	var approvalID string
	for _, raw := range harness.frames.snapshot() {
		var frame struct {
			Type string `json:"type"`
			ID   string `json:"id"`
		}
		if json.Unmarshal(raw, &frame) == nil && frame.Type == "approval" {
			approvalID = frame.ID
		}
	}
	if approvalID == "" {
		t.Fatal("approval frame carried no id")
	}

	writeFrame(t, harness.client, map[string]any{
		"type":      "approval.respond",
		"sessionId": harness.chat.ID,
		"id":        approvalID,
		"confirmed": true,
	})
	ackIndex := waitForAck(t, harness.frames, "extension_ui_response", 3*time.Second)
	harness.frames.waitFor(t, "run.done", 5*time.Second)

	var ack ackFrame
	for _, raw := range harness.frames.snapshot() {
		var candidate ackFrame
		if json.Unmarshal(raw, &candidate) == nil && candidate.Type == "ack" && candidate.Command == "extension_ui_response" {
			ack = candidate
		}
	}
	if ack.ID != approvalID {
		t.Fatalf("ack id = %q, want approval id %q", ack.ID, approvalID)
	}
	if doneIndex := frameIndexOfType(t, harness.frames, "run.done"); ackIndex >= doneIndex {
		t.Fatalf("ack index %d must precede run.done index %d", ackIndex, doneIndex)
	}
}

func TestWebSocketControlBeforeSessionErrorsWithoutAck(t *testing.T) {
	harness := newProviderWSHarness(t, "omo", "", nil)

	writeFrame(t, harness.client, map[string]any{
		"type":          "chat.set",
		"sessionId":     harness.chat.ID,
		"thinkingLevel": "high",
	})
	harness.frames.waitFor(t, "error", 3*time.Second)

	if index := frameIndexOfType(t, harness.frames, "ack"); index >= 0 {
		t.Fatalf("unexpected ack frame at %d for sessionless control", index)
	}
}

type controlResultFrame struct {
	Type      string `json:"type"`
	SessionID string `json:"sessionId"`
	Command   string `json:"command"`
	RequestID string `json:"requestId"`
	Success   bool   `json:"success"`
	Message   string `json:"message"`
}

func TestWebSocketSetModelAckCarriesRequestIDAndPrecedesResult(t *testing.T) {
	harness := newProviderWSHarness(t, "omo", "", nil)
	harness.create(t)
	harness.frames.waitFor(t, "state", 3*time.Second)

	writeFrame(t, harness.client, map[string]any{
		"type":      "chat.set",
		"sessionId": harness.chat.ID,
		"requestId": "req-model-1",
		"model":     map[string]any{"provider": "mock", "modelId": "mock-model"},
	})
	ackIndex := waitForAck(t, harness.frames, "set_model", 3*time.Second)
	harness.frames.waitFor(t, "control.result", 3*time.Second)

	var ack ackFrame
	for _, raw := range harness.frames.snapshot() {
		var candidate ackFrame
		if json.Unmarshal(raw, &candidate) == nil && candidate.Type == "ack" && candidate.Command == "set_model" {
			ack = candidate
		}
	}
	if ack.RequestID != "req-model-1" {
		t.Fatalf("ack requestId = %q, want req-model-1", ack.RequestID)
	}

	resultIndex := -1
	var result controlResultFrame
	for index, raw := range harness.frames.snapshot() {
		var candidate controlResultFrame
		if json.Unmarshal(raw, &candidate) == nil && candidate.Type == "control.result" && candidate.Command == "set_model" {
			result = candidate
			resultIndex = index
		}
	}
	if resultIndex < 0 {
		t.Fatalf("missing control.result for set_model; have: %s", harness.frames.types())
	}
	if !result.Success || result.RequestID != "req-model-1" {
		t.Fatalf("control.result = %+v, want success correlated with req-model-1", result)
	}
	if ackIndex >= resultIndex {
		t.Fatalf("ack index %d must precede control.result index %d", ackIndex, resultIndex)
	}
}

func TestWebSocketSessionMismatchIsRejectedWithoutSideEffect(t *testing.T) {
	harness := newProviderWSHarness(t, "omo", "", nil)
	harness.create(t)
	harness.frames.waitFor(t, "state", 3*time.Second)

	writeFrame(t, harness.client, map[string]any{
		"type":          "chat.set",
		"sessionId":     "some-other-chat",
		"requestId":     "req-x",
		"thinkingLevel": "high",
	})
	got := harness.frames.waitForErrorCode(t, "session_mismatch")
	if got.SessionID != harness.chat.ID {
		t.Fatalf("mismatch error sessionId = %q, want bound chat %q", got.SessionID, harness.chat.ID)
	}
	if index := frameIndexOfType(t, harness.frames, "ack"); index >= 0 {
		t.Fatalf("unexpected ack for mismatched frame at %d", index)
	}
}
