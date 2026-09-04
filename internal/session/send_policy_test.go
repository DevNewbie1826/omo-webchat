package session

import (
	"context"
	"errors"
	"testing"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

func TestSendDuringRunPassesThroughCompaction(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	mgr := testManager(t, client, newMemStore(), 64)
	s, _, _ := acquire(t, mgr, testChat{id: "send-during-compaction", cwd: t.TempDir()}, newRecorder(32))

	s.lifecycleMu.Lock()
	s.compactionActive = true
	s.lifecycleMu.Unlock()

	if err := s.SendSteer(context.Background(), "redirect"); err != nil {
		t.Fatalf("steer during compaction: %v", err)
	}
	if err := s.SendFollowUp(context.Background(), "then continue", nil); err != nil {
		t.Fatalf("follow-up during compaction: %v", err)
	}
	if !d.AwaitRequestCount(omorpc.CmdSteer, 1, testTimeout) || !d.AwaitRequestCount(omorpc.CmdFollowUp, 1, testTimeout) {
		t.Fatalf("during-run requests did not reach daemon: steer=%d follow_up=%d", d.RequestCount(omorpc.CmdSteer), d.RequestCount(omorpc.CmdFollowUp))
	}
	if got := d.LastRequest(omorpc.CmdSteer)["message"]; got != "redirect" {
		t.Fatalf("steer message = %#v", got)
	}
	if err := s.SendPrompt(context.Background(), "new prompt", nil); !errors.Is(err, ErrCompactionInFlight) {
		t.Fatalf("prompt during compaction = %v, want ErrCompactionInFlight", err)
	}
}

func TestSendPromptRetriesBusyResponseAsSteer(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	mgr := testManager(t, client, newMemStore(), 64)
	s, _, _ := acquire(t, mgr, testChat{id: "busy-prompt", cwd: t.TempDir()}, newRecorder(32))

	images := []map[string]string{{"data": "aGVsbG8=", "mimeType": "image/png"}}
	d.FailNext(omorpc.CmdPrompt, busyAgentErrorPrefix+": active run")
	if err := s.SendPrompt(context.Background(), "keep going", images); err != nil {
		t.Fatalf("busy prompt fallback: %v", err)
	}
	if got := d.RequestCount(omorpc.CmdPrompt); got != 1 {
		t.Fatalf("prompt requests = %d, want 1", got)
	}
	if got := d.RequestCount(omorpc.CmdSteer); got != 1 {
		t.Fatalf("steer requests = %d, want 1", got)
	}
	steer := d.LastRequest(omorpc.CmdSteer)
	if got := steer["message"]; got != "keep going" {
		t.Fatalf("steer message = %#v", got)
	}
	gotImages, ok := steer["images"].([]any)
	if !ok || len(gotImages) != 1 {
		t.Fatalf("steer images = %#v", steer["images"])
	}
	gotImage, ok := gotImages[0].(map[string]any)
	if !ok || gotImage["data"] != images[0]["data"] || gotImage["mimeType"] != images[0]["mimeType"] {
		t.Fatalf("steer image = %#v", gotImages[0])
	}
}

func TestSendPromptReturnsFailedSteerOutcome(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	mgr := testManager(t, client, newMemStore(), 64)
	s, _, _ := acquire(t, mgr, testChat{id: "busy-prompt-steer-failure", cwd: t.TempDir()}, newRecorder(32))

	d.FailNext(omorpc.CmdPrompt, busyAgentErrorPrefix)
	d.FailNext(omorpc.CmdSteer, omorpc.ErrCodeUnknownSession)
	err := s.SendPrompt(context.Background(), "retry once", nil)
	var stable *omorpc.StableError
	if !errors.As(err, &stable) || stable.Code != omorpc.ErrCodeUnknownSession {
		t.Fatalf("failed steer outcome = %v, want unknown_session", err)
	}
	if got := d.RequestCount(omorpc.CmdSteer); got != 1 {
		t.Fatalf("steer requests = %d, want exactly 1", got)
	}
}

func TestSendPromptDoesNotRetryOtherErrors(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	mgr := testManager(t, client, newMemStore(), 64)
	s, _, _ := acquire(t, mgr, testChat{id: "rejected-prompt", cwd: t.TempDir()}, newRecorder(32))

	d.FailNext(omorpc.CmdPrompt, omorpc.ErrCodeUnknownSession)
	err := s.SendPrompt(context.Background(), "do not retry", nil)
	var stable *omorpc.StableError
	if !errors.As(err, &stable) || stable.Code != omorpc.ErrCodeUnknownSession {
		t.Fatalf("non-busy error = %v, want unknown_session", err)
	}
	if got := d.RequestCount(omorpc.CmdSteer); got != 0 {
		t.Fatalf("non-busy prompt sent %d steer retries", got)
	}
}
