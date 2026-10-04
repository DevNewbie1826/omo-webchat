package rpcwatch_test

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
	"github.com/DevNewbie1826/omo-webchat/internal/rpcwatch"
)

type fakeCaller struct {
	t        *testing.T
	list     string
	states   map[string]string
	listErr  error
	stateErr error
}

func (f *fakeCaller) CallInEpoch(ctx context.Context, cmd omorpc.Command) (*omorpc.Response, omorpc.EpochToken, error) {
	f.t.Helper()
	deadline, ok := ctx.Deadline()
	if !ok || time.Until(deadline) > 3*time.Second {
		f.t.Error("each RPC call must have a deadline no later than three seconds")
	}
	resp := &omorpc.Response{Success: true}
	var err error
	switch c := cmd.(type) {
	case omorpc.ListSessions:
		resp.Data, err = json.RawMessage(f.list), f.listErr
	case omorpc.GetState:
		resp.Data, err = json.RawMessage(f.states[c.SessionID]), f.stateErr
	default:
		f.t.Fatalf("watcher issued mutating/unexpected command %T", cmd)
	}
	return resp, omorpc.EpochToken{}, err
}

const oneSession = `{"sessions":[{"sessionId":"rpc-5","durableSessionId":"durable-5","sessionPath":"/ws/s.jsonl","cwd":"/ws","name":"title"}]}`
const idle = `{"messageCount":3}`
const working = `{"messageCount":3,"isStreaming":true}`
const blocked = `{"messageCount":3,"pendingQuestions":[{"questions":[{"question":"Continue?","header":"fallback"}]}]}`

func newFake(t *testing.T) *fakeCaller {
	return &fakeCaller{t: t, list: oneSession, states: map[string]string{"rpc-5": idle}}
}

func lookup(t *testing.T, w *rpcwatch.Watcher) rpcwatch.Session {
	t.Helper()
	s, ok := w.Lookup("rpc-5")
	if !ok {
		t.Fatal("rpc-5 missing")
	}
	return s
}

func TestWatcherStatusTransitions(t *testing.T) {
	for _, tc := range []struct {
		name   string
		states []string
		want   []string
	}{
		{"first_idle_never_done", []string{idle}, []string{"idle"}},
		{"first_working_never_done", []string{working}, []string{"working"}},
		{"first_blocked_never_done", []string{blocked}, []string{"blocked"}},
		{"working_idle_sticky_done", []string{working, idle, idle}, []string{"working", "done", "done"}},
		{"working_blocked_idle_unchanged_count", []string{working, blocked, idle}, []string{"working", "blocked", "done"}},
		{"idle_count_increase", []string{idle, `{"messageCount":4}`}, []string{"idle", "done"}},
		{"blocked_count_increase", []string{blocked, `{"messageCount":4}`}, []string{"blocked", "done"}},
		{"blocked_no_increase", []string{blocked, idle}, []string{"blocked", "idle"}},
		{"done_cleared_by_blocked", []string{working, idle, blocked, idle}, []string{"working", "done", "blocked", "idle"}},
		{"done_cleared_by_working", []string{working, idle, working, idle}, []string{"working", "done", "working", "done"}},
		{"compacting_is_working", []string{`{"isCompacting":true}`, idle}, []string{"working", "done"}},
		{"questions_override_streaming", []string{`{"isStreaming":true,"pendingQuestions":[{}]}`}, []string{"blocked"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newFake(t)
			w := rpcwatch.New(f)
			for i, state := range tc.states {
				f.states["rpc-5"] = state
				w.Tick(t.Context())
				if got := lookup(t, w).Status; got != tc.want[i] {
					t.Fatalf("step %d status = %s, want %s", i, got, tc.want[i])
				}
			}
		})
	}
}

func TestWatcherQuestionsAndMetadata(t *testing.T) {
	f := newFake(t)
	long := strings.Repeat("한", 201)
	f.states["rpc-5"] = `{"messageCount":7,"pendingQuestions":[{"questions":[{"question":"Continue?","header":"ignored"},{"header":"Fallback"},{"question":"` + long + `"}]},{"questions":[{"question":"Second"}]}]}`
	now := time.UnixMilli(1790000000000)
	w := rpcwatch.New(f, rpcwatch.WithClock(func() time.Time { return now }))
	w.Tick(t.Context())
	s := lookup(t, w)
	if s.SessionID != "rpc-5" || s.DurableSessionID != "durable-5" || s.SessionPath != "/ws/s.jsonl" || s.Cwd != "/ws" || s.Name != "title" || s.MessageCount != 7 || s.UpdatedAt != now.UnixMilli() {
		t.Fatalf("metadata lost: %+v", s)
	}
	if want := []string{"Continue?", "Fallback", strings.Repeat("한", 200), "Second"}; !reflect.DeepEqual(s.Questions, want) {
		t.Fatalf("questions = %q, want %q", s.Questions, want)
	}
	f.states["rpc-5"] = idle
	w.Tick(t.Context())
	if len(lookup(t, w).Questions) != 0 {
		t.Fatal("idle retained stale questions")
	}
}

func TestWatcherClosedRetentionAndReappearance(t *testing.T) {
	f := newFake(t)
	now := time.UnixMilli(1790000000000)
	w := rpcwatch.New(f, rpcwatch.WithClock(func() time.Time { return now }))
	w.Tick(t.Context())
	f.list = `{"sessions":[]}`
	now = now.Add(time.Second)
	w.Tick(t.Context())
	closedAt := now.UnixMilli()
	if s := lookup(t, w); s.Status != "closed" || s.ClosedAt != closedAt {
		t.Fatalf("not closed at disappearance: %+v", s)
	}
	now = now.Add(10*time.Minute - time.Millisecond)
	w.Tick(t.Context())
	if lookup(t, w).ClosedAt != closedAt {
		t.Fatal("closed clock reset")
	}
	now = now.Add(time.Millisecond)
	w.Tick(t.Context())
	if _, ok := w.Lookup("rpc-5"); ok {
		t.Fatal("closed retained at ten-minute boundary")
	}
	f.list = oneSession
	w.Tick(t.Context())
	if s := lookup(t, w); s.Status != "idle" || s.ClosedAt != 0 {
		t.Fatalf("reappearance not live: %+v", s)
	}
	f.list = `{"sessions":[]}`
	w.Tick(t.Context())
	f.list = oneSession
	w.Tick(t.Context())
	if s := lookup(t, w); s.Status != "idle" || s.ClosedAt != 0 {
		t.Fatalf("retained closed record not revived: %+v", s)
	}
}

func TestWatcherFailuresPreserveSnapshot(t *testing.T) {
	f := newFake(t)
	w := rpcwatch.New(f)
	w.Tick(t.Context())
	before := w.Sessions()
	f.listErr = errors.New("daemon unavailable")
	w.Tick(t.Context())
	if !reflect.DeepEqual(w.Sessions(), before) {
		t.Fatal("list failure changed snapshot")
	}
	f.listErr = nil
	f.list = `{`
	w.Tick(t.Context())
	if !reflect.DeepEqual(w.Sessions(), before) {
		t.Fatal("malformed list changed snapshot")
	}
	f.list = oneSession
	f.stateErr = errors.New("state unavailable")
	w.Tick(t.Context())
	if !reflect.DeepEqual(w.Sessions(), before) {
		t.Fatal("state failure changed previous record")
	}
	f.stateErr = nil
	f.states["rpc-5"] = `{`
	w.Tick(t.Context())
	if !reflect.DeepEqual(w.Sessions(), before) {
		t.Fatal("malformed state changed previous record")
	}
	f.states["rpc-5"] = working
	w.Tick(t.Context())
	if lookup(t, w).Status != "working" {
		t.Fatal("did not recover after failure")
	}
}

type callerFunc func(context.Context, omorpc.Command) (*omorpc.Response, omorpc.EpochToken, error)

func (f callerFunc) CallInEpoch(ctx context.Context, c omorpc.Command) (*omorpc.Response, omorpc.EpochToken, error) {
	return f(ctx, c)
}

func TestWatcherUnknownSessionRetention(t *testing.T) {
	for _, observed := range []bool{false, true} {
		f := newFake(t)
		unknown := false
		now := time.Unix(1_800_000_000, 0)
		c := callerFunc(func(ctx context.Context, cmd omorpc.Command) (*omorpc.Response, omorpc.EpochToken, error) {
			if _, ok := cmd.(omorpc.GetState); ok && unknown {
				return &omorpc.Response{Error: omorpc.ErrCodeUnknownSession}, omorpc.EpochToken{}, nil
			}
			return f.CallInEpoch(ctx, cmd)
		})
		w := rpcwatch.New(c, rpcwatch.WithClock(func() time.Time { return now }))
		if observed {
			w.Tick(t.Context())
		}
		unknown = true
		w.Tick(t.Context())
		got, ok := w.Lookup("rpc-5")
		if observed {
			if !ok || got.Status != "closed" || got.ClosedAt != now.UnixMilli() {
				t.Fatalf("previously observed unknown session = %+v, found=%v", got, ok)
			}
			now = now.Add(10 * time.Minute)
			w.Tick(t.Context())
			if _, ok := w.Lookup("rpc-5"); ok {
				t.Fatal("closed session retained after 10-minute retention")
			}
		} else if ok {
			t.Fatalf("never-observed unknown session retained: %+v", got)
		}
	}
}

func TestWatcherCopiesSortedSnapshots(t *testing.T) {
	f := newFake(t)
	f.list = `{"sessions":[{"sessionId":"rpc-9","cwd":"/z"},{"sessionId":"rpc-5","cwd":"/a"},{"sessionId":"rpc-1","cwd":"/a"}]}`
	f.states = map[string]string{"rpc-9": idle, "rpc-5": blocked, "rpc-1": idle}
	w := rpcwatch.New(f)
	w.Tick(t.Context())
	list := w.Sessions()
	if got := []string{list[0].SessionID, list[1].SessionID, list[2].SessionID}; !reflect.DeepEqual(got, []string{"rpc-1", "rpc-5", "rpc-9"}) {
		t.Fatalf("sort = %v", got)
	}
	list[1].Questions[0] = "mutated"
	list[1].Name = "mutated"
	s := lookup(t, w)
	s.Questions[0] = "mutated again"
	if s = lookup(t, w); s.Questions[0] != "Continue?" || s.Name != "" {
		t.Fatalf("accessor aliases snapshot: %+v", s)
	}
}

func TestWatcherConcurrentReadersAndTicks(t *testing.T) {
	f := newFake(t)
	w := rpcwatch.New(f)
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Go(func() {
			for j := 0; j < 20; j++ {
				w.Tick(t.Context())
				w.Sessions()
				w.Lookup("rpc-5")
			}
		})
	}
	wg.Wait()
	if lookup(t, w).Status != "idle" {
		t.Fatal("concurrent ticks created false done")
	}
}

func TestWatcherRunImmediateAndCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	calls := 0
	c := callerFunc(func(ctx context.Context, cmd omorpc.Command) (*omorpc.Response, omorpc.EpochToken, error) {
		calls++
		cancel()
		return &omorpc.Response{Success: true, Data: json.RawMessage(oneSession)}, omorpc.EpochToken{}, nil
	})
	w := rpcwatch.New(c, rpcwatch.WithInterval(time.Hour))
	done := make(chan struct{})
	go func() { w.Run(ctx); close(done) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not stop on cancellation")
	}
	if calls != 1 || len(w.Sessions()) != 0 {
		t.Fatalf("Run calls=%d, cancellation published partial snapshot=%v", calls, w.Sessions())
	}
	w.Tick(ctx)
	if calls != 1 {
		t.Fatal("cancelled Tick called daemon")
	}
}
