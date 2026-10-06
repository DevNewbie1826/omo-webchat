package rpcwatch

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

// clockedCaller reads the same clock the watcher uses, so the instant of every
// RPC call is comparable with the snapshot instant the watcher recorded.
type clockedCaller struct {
	now      func() time.Time
	getState []time.Time
}

func (c *clockedCaller) CallInEpoch(_ context.Context, cmd omorpc.Command) (*omorpc.Response, omorpc.EpochToken, error) {
	var data any
	switch cmd.(type) {
	case omorpc.ListSessions:
		data = map[string]any{"sessions": []Session{{SessionID: "rpc-1", Cwd: "/workspace", SessionPath: "/session.jsonl"}}}
	case omorpc.GetState:
		c.getState = append(c.getState, c.now())
		data = map[string]any{"sessionId": "durable", "sessionName": "Daemon title"}
	default:
		return nil, omorpc.EpochToken{}, errors.New("mutating watcher command")
	}
	raw, err := json.Marshal(data)
	return &omorpc.Response{Success: true, Data: raw}, omorpc.EpochToken{}, err
}

// G23: the snapshot instant must be taken no later than the GetState call, so a
// snapshot can never look newer than the state it carries. The shared clock
// advances on every reading, which makes the order of the two readings visible.
func TestWatcherObservesStateNoLaterThanGetState(t *testing.T) {
	base := time.Unix(1_700_000_000, 0)
	var readings int
	clock := func() time.Time {
		readings++
		return base.Add(time.Duration(readings) * time.Second)
	}
	c := &clockedCaller{now: clock}
	w := New(c, WithClock(clock))
	w.Tick(t.Context())

	if len(c.getState) != 1 {
		t.Fatalf("GetState calls = %d, want 1", len(c.getState))
	}
	got, ok := w.Lookup("rpc-1")
	if !ok {
		t.Fatal("session missing from the snapshot")
	}
	if got.ObservedAt.IsZero() {
		t.Fatal("snapshot carries no observation instant")
	}
	if got.ObservedAt.After(c.getState[0]) {
		t.Fatalf("ObservedAt %v is after the GetState call at %v", got.ObservedAt, c.getState[0])
	}
}

func TestSessionSnapshotWireShapeOmitsObservationInstant(t *testing.T) {
	raw, err := json.Marshal(Session{SessionID: "rpc-1", Name: "Daemon title", ObservedAt: time.Unix(1_700_000_000, 0)})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "bservedAt") {
		t.Fatalf("snapshot wire shape carries the observation instant: %s", raw)
	}
}
