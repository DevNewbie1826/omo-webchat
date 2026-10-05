package rpcwatch

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

type testCaller struct {
	state   map[string]any
	present bool
	listErr error
	code    string
}

func (c *testCaller) CallInEpoch(ctx context.Context, cmd omorpc.Command) (*omorpc.Response, omorpc.EpochToken, error) {
	if _, ok := ctx.Deadline(); !ok {
		return nil, omorpc.EpochToken{}, errors.New("RPC must have deadline")
	}
	var data any
	switch cmd.(type) {
	case omorpc.ListSessions:
		if c.listErr != nil {
			return nil, omorpc.EpochToken{}, c.listErr
		}
		list := []Session{}
		if c.present {
			list = append(list, Session{SessionID: "rpc-1", Cwd: "/workspace", SessionPath: "/session.jsonl"})
		}
		data = map[string]any{"sessions": list}
	case omorpc.GetState:
		if c.code != "" {
			return &omorpc.Response{Error: c.code}, omorpc.EpochToken{}, nil
		}
		data = c.state
	default:
		return nil, omorpc.EpochToken{}, errors.New("mutating watcher command")
	}
	raw, err := json.Marshal(data)
	return &omorpc.Response{Success: true, Data: raw}, omorpc.EpochToken{}, err
}

func TestWatcherTransitions(t *testing.T) {
	for _, tc := range []struct {
		name   string
		states []map[string]any
		want   []string
	}{
		{"initial idle", []map[string]any{{}}, []string{"idle"}},
		{"working done", []map[string]any{{"isStreaming": true}, {}, {}}, []string{"working", "done", "done"}},
		{"compacting done", []map[string]any{{"isCompacting": true}, {}}, []string{"working", "done"}},
		{"blocked priority", []map[string]any{{"isStreaming": true, "pendingQuestions": []any{map[string]any{}}}}, []string{"blocked"}},
		{"count increased", []map[string]any{{"messageCount": 1}, {"messageCount": 2}}, []string{"idle", "done"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := &testCaller{present: true}
			w := New(c, WithClock(func() time.Time { return time.UnixMilli(1234) }))
			for i, state := range tc.states {
				c.state = state
				w.Tick(t.Context())
				got, ok := w.Lookup("rpc-1")
				if !ok || got.Status != tc.want[i] || got.UpdatedAt != 1234 {
					t.Fatalf("step %d = %+v, present %v; want %s", i, got, ok, tc.want[i])
				}
			}
		})
	}
}

func TestWatcherDropsEndedAndUnknownButPreservesTransientFailure(t *testing.T) {
	c := &testCaller{present: true, state: map[string]any{"sessionId": "durable"}}
	w := New(c)
	w.Tick(t.Context())
	before := w.Sessions()
	c.listErr = errors.New("offline")
	w.Tick(t.Context())
	if !reflect.DeepEqual(before, w.Sessions()) {
		t.Fatal("failed list changed snapshot")
	}
	c.listErr, c.code = nil, "internal_error"
	w.Tick(t.Context())
	if !reflect.DeepEqual(before, w.Sessions()) {
		t.Fatal("transient state failure changed snapshot")
	}
	c.code = omorpc.ErrCodeUnknownSession
	w.Tick(t.Context())
	if len(w.Sessions()) != 0 {
		t.Fatal("unknown session retained")
	}
	c.code = ""
	w.Tick(t.Context())
	c.present = false
	w.Tick(t.Context())
	if len(w.Sessions()) != 0 {
		t.Fatal("ended session retained")
	}
}

func TestWatcherCopiesQuestionsAndSupportsConcurrentReaders(t *testing.T) {
	c := &testCaller{present: true, state: map[string]any{
		"sessionId": "durable", "sessionFile": "/original.jsonl", "sessionName": "Name",
		"pendingQuestions": []any{map[string]any{"questions": []any{map[string]any{"question": "Choose"}}}},
	}}
	w := New(c)
	w.Tick(t.Context())
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Go(func() {
			for j := 0; j < 25; j++ {
				w.Tick(t.Context())
				s, ok := w.Lookup("rpc-1")
				if !ok || s.DurableSessionID != "durable" || s.SessionPath != "/original.jsonl" || s.Questions[0] != "Choose" {
					t.Errorf("snapshot = %+v", s)
					return
				}
				s.Questions[0] = "local change"
				rows := w.Sessions()
				rows[0].Questions[0] = "local change"
			}
		})
	}
	wg.Wait()
}

func TestWatcherRunImmediateSnapshotAndCancellation(t *testing.T) {
	c := &testCaller{present: true, state: map[string]any{}}
	observed := make(chan []Session, 1)
	w := New(c, WithInterval(time.Hour), WithSnapshot(func(s []Session) { observed <- s }))
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	done := make(chan struct{})
	go func() { defer close(done); w.Run(ctx) }()
	select {
	case rows := <-observed:
		if len(rows) != 1 {
			t.Fatalf("immediate snapshot = %+v", rows)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("no immediate poll")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("watcher failed to stop")
	}
}
