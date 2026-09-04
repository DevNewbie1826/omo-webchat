package session

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc/omorpctest"
)

func TestStructuredStatsPreserveProviderShape(t *testing.T) {
	var got Stats
	if err := json.Unmarshal([]byte(`{
		"tokens":{"input":100,"output":50,"cacheRead":7,"total":157},
		"cost":0.001,
		"contextUsage":{"used":150,"total":200000,"percent":0.075}
	}`), &got); err != nil {
		t.Fatal(err)
	}
	if string(got.Tokens) != `{"input":100,"output":50,"cacheRead":7,"total":157}` || got.Cost != 0.001 || string(got.ContextUsage) != `{"used":150,"total":200000,"percent":0.075}` {
		t.Fatalf("preserved stats = %+v", got)
	}
}

func TestDelayedBusyPromptDoesNotSteerIntoNewerRun(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	mgr := testManager(t, client, newMemStore(), 64)
	sub := newRecorder(32)
	s, _, _ := acquire(t, mgr, testChat{id: "busy-owner", cwd: t.TempDir()}, sub)
	sub.next(t)

	releasePrompts := d.BlockHandler(omorpc.CmdPrompt)
	d.FailNext(omorpc.CmdPrompt, busyAgentErrorPrefix)
	aDone := make(chan error, 1)
	go func() { aDone <- s.SendPrompt(context.Background(), "A", nil) }()
	if !d.AwaitRequestCount(omorpc.CmdPrompt, 1, testTimeout) {
		t.Fatal("A prompt was not forwarded")
	}

	d.EmitSession(s.SessionFile(), map[string]any{"type": omorpctest.EventAgentStart})
	d.EmitSession(s.SessionFile(), map[string]any{"type": omorpctest.EventAgentSettled, "reason": "end_turn"})
	sub.await(t, FrameRunDone)

	if err := s.SendPromptDetached(context.Background(), "B", nil); err != nil {
		t.Fatalf("B prompt admission: %v", err)
	}
	if !d.AwaitRequestCount(omorpc.CmdPrompt, 2, testTimeout) {
		t.Fatal("B prompt was not forwarded")
	}
	releasePrompts()

	select {
	case err := <-aDone:
		if err == nil || !strings.HasPrefix(err.Error(), busyAgentErrorPrefix) {
			t.Fatalf("A completion = %v, want original busy failure", err)
		}
	case <-time.After(testTimeout):
		t.Fatal("A response did not complete")
	}
	if got := d.RequestCount(omorpc.CmdSteer); got != 0 {
		t.Fatalf("delayed A response injected %d steer requests into B", got)
	}
	if snapshot := s.RunSnapshot(); !snapshot.Streaming {
		t.Fatalf("newer B run lost ownership: %+v", snapshot)
	}
}

func TestAbortBypassesFullDetachedMutationLimit(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	mgr := testManager(t, client, newMemStore(), 64)
	sub := newRecorder(32)
	s, _, _ := acquire(t, mgr, testChat{id: "abort-capacity", cwd: t.TempDir()}, sub)
	sub.next(t)

	d.EmitSession(s.SessionFile(), map[string]any{"type": omorpctest.EventAgentStart})
	sub.await(t, FrameRunStarted)
	release := d.BlockHandler(omorpc.CmdFollowUp)
	defer release()
	for i := 0; i < DetachedMutationLimit; i++ {
		if err := s.SendFollowUpDetached(context.Background(), "queued", nil); err != nil {
			t.Fatalf("detached mutation %d: %v", i, err)
		}
	}
	if err := s.Abort(context.Background()); err != nil {
		t.Fatalf("abort at full send capacity: %v", err)
	}
	if !d.AwaitRequestCount(omorpc.CmdAbort, 1, testTimeout) {
		t.Fatal("abort did not reach provider at full send capacity")
	}
}

func TestAbortAsynchronousFailurePublishesWithoutRequestID(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	mgr := testManager(t, client, newMemStore(), 64)
	sub := newRecorder(8)
	s, _, _ := acquire(t, mgr, testChat{id: "abort-async-failure", cwd: t.TempDir()}, sub)
	sub.next(t)

	d.FailNext(omorpc.CmdAbort, omorpc.ErrCodeUnknownSession)
	if err := s.Abort(context.Background()); err != nil {
		t.Fatalf("abort admission: %v", err)
	}
	_, frame := sub.awaitError(t, "provider_error")
	if frame.Command != "chat.abort" || frame.RequestID != "" {
		t.Fatalf("uncorrelated abort failure = %+v", frame)
	}
}

func TestDetachedMutationLimitReturnsBackpressure(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	mgr := testManager(t, client, newMemStore(), 64)
	sub := newRecorder(32)
	s, _, _ := acquire(t, mgr, testChat{id: "mutation-limit", cwd: t.TempDir()}, sub)
	sub.next(t)

	d.EmitSession(s.SessionFile(), map[string]any{"type": omorpctest.EventAgentStart})
	sub.await(t, FrameRunStarted)
	release := d.BlockHandler(omorpc.CmdFollowUp)
	defer release()
	for i := 0; i < DetachedMutationLimit; i++ {
		if err := s.SendFollowUpDetached(context.Background(), "queued", nil); err != nil {
			t.Fatalf("detached mutation %d: %v", i, err)
		}
	}
	if err := s.SendFollowUpDetached(context.Background(), "overflow", nil); !errors.Is(err, ErrSendBackpressure) {
		t.Fatalf("overflow error = %v, want ErrSendBackpressure", err)
	}
}

func TestSteerAndFollowUpDispatchDuringActiveRun(t *testing.T) {
	d := newDaemon(t)
	client := dial(t, d)
	mgr := testManager(t, client, newMemStore(), 64)
	sub := newRecorder(32)
	s, _, _ := acquire(t, mgr, testChat{id: "run-kinds", cwd: t.TempDir()}, sub)
	sub.next(t)

	d.SetPromptScript(s.SessionFile(),
		map[string]any{"type": omorpctest.EventAgentStart},
		map[string]any{"type": omorpctest.EventAgentSettled, "reason": "end_turn"},
	)
	release := d.HoldPrompt(s.SessionFile())
	defer release()
	if err := s.SendPrompt(context.Background(), "start", nil); err != nil {
		t.Fatal(err)
	}
	if snapshot := s.RunSnapshot(); !snapshot.Streaming || snapshot.Compacting {
		t.Fatalf("active snapshot = %+v", snapshot)
	}
	if err := s.SendSteer(context.Background(), "left"); err != nil {
		t.Fatal(err)
	}
	if err := s.SendFollowUp(context.Background(), "next", nil); err != nil {
		t.Fatal(err)
	}
	if !d.AwaitRequestCount(omorpc.CmdSteer, 1, testTimeout) || !d.AwaitRequestCount(omorpc.CmdFollowUp, 1, testTimeout) {
		t.Fatalf("run kind requests: steer=%d follow_up=%d", d.RequestCount(omorpc.CmdSteer), d.RequestCount(omorpc.CmdFollowUp))
	}
	release()
	sub.await(t, FrameRunDone)
}
