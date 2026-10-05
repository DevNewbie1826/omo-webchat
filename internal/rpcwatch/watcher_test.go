package rpcwatch

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

type testCaller struct {
	mu      sync.Mutex
	list    []map[string]any
	states  map[string]map[string]any
	listErr error
	codes   map[string]string
	calls   chan string
}

func newTestCaller() *testCaller {
	return &testCaller{
		list:   []map[string]any{{"sessionId": "rpc-1", "sessionPath": "/s", "cwd": "/w", "name": "Session"}},
		states: map[string]map[string]any{"rpc-1": {"messageCount": 1}},
		codes:  map[string]string{},
	}
}

func (c *testCaller) CallInEpoch(ctx context.Context, cmd omorpc.Command) (*omorpc.Response, omorpc.EpochToken, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	var data any
	var name string
	switch cmd := cmd.(type) {
	case omorpc.ListSessions:
		name = "list"
		if c.listErr != nil {
			return nil, omorpc.EpochToken{}, c.listErr
		}
		data = map[string]any{"sessions": c.list}
	case omorpc.GetState:
		name = "state"
		deadline, ok := ctx.Deadline()
		if !ok || time.Until(deadline) > 3*time.Second {
			return nil, omorpc.EpochToken{}, errors.New("state lacks 3s timeout")
		}
		if code := c.codes[cmd.SessionID]; code != "" {
			return &omorpc.Response{Error: code}, omorpc.EpochToken{}, nil
		}
		data = c.states[cmd.SessionID]
	default:
		return nil, omorpc.EpochToken{}, errors.New("watcher attempted mutating command")
	}
	raw, err := json.Marshal(data)
	if err != nil {
		return nil, omorpc.EpochToken{}, err
	}
	if c.calls != nil {
		c.calls <- name
	}
	return &omorpc.Response{Success: true, Data: raw}, omorpc.EpochToken{}, nil
}

func TestTransitions(t *testing.T) {
	idle := map[string]any{"messageCount": 4}
	working := map[string]any{"messageCount": 4, "isStreaming": true}
	blocked := map[string]any{"messageCount": 4, "pendingQuestions": []any{map[string]any{"questions": []any{map[string]any{"question": "Choose"}}}}}
	for _, tc := range []struct {
		name   string
		states []map[string]any
		want   []string
	}{
		{"first idle never done", []map[string]any{idle}, []string{"idle"}},
		{"first blocked never done", []map[string]any{blocked}, []string{"blocked"}},
		{"working idle done persists", []map[string]any{working, idle, idle}, []string{"working", "done", "done"}},
		{"working blocked idle same count", []map[string]any{working, blocked, idle}, []string{"working", "blocked", "done"}},
		{"compacting idle", []map[string]any{{"isCompacting": true, "messageCount": 4}, idle}, []string{"working", "done"}},
		{"idle count increase", []map[string]any{idle, {"messageCount": 5}}, []string{"idle", "done"}},
		{"blocked count increase", []map[string]any{blocked, {"messageCount": 5}}, []string{"blocked", "done"}},
		{"done cleared by blocked", []map[string]any{working, idle, blocked, idle}, []string{"working", "done", "blocked", "idle"}},
		{"blocked takes precedence", []map[string]any{{"isStreaming": true, "pendingQuestions": []any{map[string]any{}}}}, []string{"blocked"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := newTestCaller()
			w := New(c, WithClock(func() time.Time { return time.UnixMilli(1234) }))
			for i, state := range tc.states {
				c.states["rpc-1"] = state
				w.Tick(t.Context())
				got, ok := w.Lookup("rpc-1")
				if !ok || got.Status != tc.want[i] || got.UpdatedAt != 1234 {
					t.Fatalf("step %d: %+v, present %v; want %s", i, got, ok, tc.want[i])
				}
			}
		})
	}
}

func TestBlockedQuestionsAndSnapshotCopies(t *testing.T) {
	c := newTestCaller()
	c.states["rpc-1"] = map[string]any{
		"pendingQuestions": []any{map[string]any{"questions": []any{
			map[string]any{"question": strings.Repeat("한", 201), "header": "unused"},
			map[string]any{"question": "", "header": "Fallback"},
		}}},
		"sessionId": "durable-1", "sessionFile": "/state/path",
	}
	w := New(c)
	w.Tick(t.Context())
	s, ok := w.Lookup("rpc-1")
	want := []string{strings.Repeat("한", 200), "Fallback"}
	if !ok || !reflect.DeepEqual(s.Questions, want) || s.DurableSessionID != "durable-1" || s.SessionPath != "/state/path" {
		t.Fatalf("snapshot: %+v", s)
	}
	s.Questions[0] = "mutated"
	all := w.Sessions()
	all[0].Questions[1] = "mutated"
	again, _ := w.Lookup("rpc-1")
	if !reflect.DeepEqual(again.Questions, want) {
		t.Fatalf("snapshot leaked mutation: %+v", again)
	}
}

func TestListFailureKeepsSnapshotAndAbsentRoutesDrop(t *testing.T) {
	for _, reason := range []string{"missing list", "unknown session"} {
		t.Run(reason, func(t *testing.T) {
			c := newTestCaller()
			w := New(c)
			w.Tick(t.Context())
			before := w.Sessions()
			c.listErr = errors.New("offline")
			w.Tick(t.Context())
			if !reflect.DeepEqual(before, w.Sessions()) {
				t.Fatal("list error replaced snapshot")
			}
			c.listErr = nil
			if reason == "missing list" {
				c.list = nil
			} else {
				c.codes["rpc-1"] = omorpc.ErrCodeUnknownSession
			}
			w.Tick(t.Context())
			if _, ok := w.Lookup("rpc-1"); ok || len(w.Sessions()) != 0 {
				t.Fatal("absent route retained")
			}
			c.codes = map[string]string{}
			c.list = beforeList()
			w.Tick(t.Context())
			if s, ok := w.Lookup("rpc-1"); !ok || s.Status != "idle" {
				t.Fatalf("reappearing route is not a first observation: %+v", s)
			}
		})
	}
}

func beforeList() []map[string]any {
	return []map[string]any{{"sessionId": "rpc-1", "cwd": "/w"}}
}

func TestStateFailureKeepsPreviousRow(t *testing.T) {
	c := newTestCaller()
	w := New(c)
	w.Tick(t.Context())
	before := w.Sessions()
	c.codes["rpc-1"] = "internal_error"
	w.Tick(t.Context())
	if !reflect.DeepEqual(before, w.Sessions()) {
		t.Fatal("transient state failure changed prior row")
	}
}

func TestConcurrentReadersAndTicks(t *testing.T) {
	c := newTestCaller()
	c.list = append(c.list, map[string]any{"sessionId": "rpc-2", "cwd": "/a"})
	c.states["rpc-2"] = map[string]any{}
	w := New(c)
	var wg sync.WaitGroup
	for i := 0; i < 6; i++ {
		wg.Go(func() {
			for j := 0; j < 50; j++ {
				w.Tick(t.Context())
				sessions := w.Sessions()
				if len(sessions) != 2 || sessions[0].SessionID != "rpc-2" {
					t.Errorf("unsorted/incomplete snapshot: %+v", sessions)
					return
				}
				w.Lookup("rpc-1")
			}
		})
	}
	wg.Wait()
}

func TestRunImmediateTickAndCancellation(t *testing.T) {
	c := newTestCaller()
	c.calls = make(chan string, 8)
	w := New(c, WithInterval(time.Hour))
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	done := make(chan struct{})
	go func() { w.Run(ctx); close(done) }()
	for _, want := range []string{"list", "state"} {
		select {
		case got := <-c.calls:
			if got != want {
				t.Fatalf("call %q, want %q", got, want)
			}
		case <-time.After(2 * time.Second):
			t.Fatal("no immediate tick")
		}
	}
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Run did not stop")
	}
}

func TestDisabledWatcher(t *testing.T) {
	w := New(nil)
	w.Tick(t.Context())
	if len(w.Sessions()) != 0 {
		t.Fatal("disabled watcher not empty")
	}
}
