package api

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/chat"
)

func (f *frameCollector) waitForErrorCode(t *testing.T, code string) chat.ErrorFrame {
	t.Helper()
	timer := time.NewTimer(3 * time.Second)
	defer timer.Stop()
	for {
		for _, raw := range f.snapshot() {
			var frame chat.ErrorFrame
			if json.Unmarshal(raw, &frame) == nil && frame.Type == "error" && frame.Code == code {
				return frame
			}
		}
		select {
		case <-f.notify:
		case <-timer.C:
			t.Fatalf("timed out waiting for error code %q; have: %s", code, f.types())
		}
	}
}

func TestWebSocketRoutingReportsSessionCommandFailures(t *testing.T) {
	harness := newProviderWSHarness(t, "omo", "", nil)
	harness.create(t)
	harness.frames.waitFor(t, "ready", 3*time.Second)
	session := harness.server.chats.Get(harness.chat.ID)
	if session == nil {
		t.Fatal("missing active session")
	}
	if err := session.Close(); err != nil {
		t.Fatalf("close provider session: %v", err)
	}

	tests := []struct {
		name        string
		frame       map[string]any
		wantCode    string
		wantCommand string
	}{
		{
			name:        "model",
			frame:       map[string]any{"type": "chat.set", "model": map[string]string{"provider": "openai", "modelId": "gpt-5"}},
			wantCode:    "set_model_failed",
			wantCommand: "set_model",
		},
		{
			name:        "thinking",
			frame:       map[string]any{"type": "chat.set", "thinkingLevel": "high"},
			wantCode:    "set_thinking_failed",
			wantCommand: "set_thinking_level",
		},
		{
			name:        "approval",
			frame:       map[string]any{"type": "approval.respond", "id": "approval-1", "confirmed": true},
			wantCode:    "approval_failed",
			wantCommand: "extension_ui_response",
		},
		{
			name:        "resume",
			frame:       map[string]any{"type": "chat.resume", "since": "entry-1"},
			wantCode:    "resume_failed",
			wantCommand: "query",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			test.frame["sessionId"] = harness.chat.ID
			writeFrame(t, harness.client, test.frame)
			got := harness.frames.waitForErrorCode(t, test.wantCode)
			if got.Command != test.wantCommand {
				t.Fatalf("command = %q, want %q; frame: %+v", got.Command, test.wantCommand, got)
			}
		})
	}
}

func TestWebSocketRoutingRejectsMalformedResume(t *testing.T) {
	harness := newProviderWSHarness(t, "omo", "", nil)
	writeFrame(t, harness.client, map[string]any{"type": "chat.resume", "since": map[string]string{"invalid": "shape"}})
	got := harness.frames.waitForErrorCode(t, "bad_resume")
	if got.Message != "invalid chat.resume" {
		t.Fatalf("message = %q, want invalid chat.resume", got.Message)
	}
}
