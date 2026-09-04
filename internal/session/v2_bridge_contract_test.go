package session

import (
	"context"
	"encoding/json"
	"testing"

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
	if snapshot := s.RunSnapshot(); snapshot.Streaming || snapshot.Compacting {
		t.Fatalf("settled snapshot = %+v", snapshot)
	}
}
