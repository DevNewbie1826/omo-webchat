package main

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc/omorpctest"
)

func (f *fixture) drainEvents(client *omorpc.Client) {
	f.t.Helper()
	for {
		select {
		case <-client.Events():
		default:
			return
		}
	}
}

func (f *fixture) subscribeEvents(client *omorpc.Client) <-chan *omorpc.Event {
	f.t.Helper()
	f.drainEvents(client)
	events := client.Events()
	seen := make(chan *omorpc.Event, 8)
	stop := make(chan struct{})
	f.t.Cleanup(func() { close(stop) })
	go func() {
		for {
			select {
			case <-stop:
				return
			case ev, ok := <-events:
				if !ok {
					return
				}
				select {
				case seen <- ev:
				case <-stop:
					return
				}
			}
		}
	}()
	return seen
}

func (f *fixture) recvEvent(ch <-chan *omorpc.Event, what string) *omorpc.Event {
	f.t.Helper()
	timer := time.NewTimer(fixtureAwait)
	defer timer.Stop()
	select {
	case ev := <-ch:
		if ev == nil {
			f.t.Fatalf("%s: nil event", what)
		}
		return ev
	case <-timer.C:
		f.t.Fatalf("%s was not observed", what)
		return nil
	}
}

func TestNoticeEmitsEmptyQueueUpdateAfterLifecycle(t *testing.T) {
	cases := []struct {
		shape   string
		live    bool
		inspect func(*testing.T, *omorpc.Event, string)
	}{
		{
			shape: "session_closed",
			inspect: func(t *testing.T, ev *omorpc.Event, rpc string) {
				if ev.Type != "session_closed" || ev.SessionID != rpc {
					t.Fatalf("lifecycle event: type=%q session=%q want session_closed %q", ev.Type, ev.SessionID, rpc)
				}
			},
		},
		{
			shape: "session_unloaded",
			inspect: func(t *testing.T, ev *omorpc.Event, rpc string) {
				if ev.Type != "session_unloaded" || ev.SessionID != rpc {
					t.Fatalf("lifecycle event: type=%q session=%q want session_unloaded %q", ev.Type, ev.SessionID, rpc)
				}
			},
		},
		{
			shape: "close_session",
			inspect: func(t *testing.T, ev *omorpc.Event, rpc string) {
				assertCloseResponse(t, ev, rpc, true)
			},
		},
		{
			shape: "close_session_negative",
			live:  true,
			inspect: func(t *testing.T, ev *omorpc.Event, rpc string) {
				assertCloseResponse(t, ev, rpc, false)
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.shape, func(t *testing.T) {
			f := startFixture(t)
			opens := f.daemon.OpenCount()
			seen := f.subscribeEvents(f.lead)

			// When: notice is posted after the engine event subscription is live.
			out := f.post("/notice", noticeRequest{Path: f.pathA, Shape: tc.shape})
			if out["completed"] != true || out["shape"] != tc.shape {
				t.Fatalf("notice: %#v", out)
			}

			// Then: the same engine stream carries the faithful lifecycle record,
			// then an ordinary empty queue_update addressed to the same routing id.
			lifecycle := f.recvEvent(seen, "lifecycle record")
			tc.inspect(t, lifecycle, f.rpcA)
			queue := f.recvEvent(seen, "empty queue_update dispatch barrier")
			if queue.Type != omorpc.EventQueueUpdate || queue.SessionID != f.rpcA {
				t.Fatalf("queue_update: type=%q session=%q want %q %q", queue.Type, queue.SessionID, omorpc.EventQueueUpdate, f.rpcA)
			}
			update, err := omorpc.ParseQueueUpdate(queue)
			if err != nil {
				t.Fatalf("parse queue_update: %v", err)
			}
			if update.PendingMessageCount != 0 || len(update.Ordered) != 0 {
				t.Fatalf("queue_update was not empty: %+v", update)
			}
			if f.daemon.OpenCount() != opens {
				t.Fatalf("notice reopened a route: opens=%d->%d", opens, f.daemon.OpenCount())
			}
			got := snapshotByPath(t, f.daemon, f.pathA)
			if got.Live != tc.live || got.RoutingID != f.rpcA {
				t.Fatalf("path A after %s: live=%v routing=%q want live=%v routing=%q", tc.shape, got.Live, got.RoutingID, tc.live, f.rpcA)
			}
			sibling := snapshotByPath(t, f.daemon, f.pathB)
			if !sibling.Live || sibling.RoutingID != f.rpcB {
				t.Fatalf("sibling B changed: live=%v routing=%q", sibling.Live, sibling.RoutingID)
			}
		})
	}
}

func assertCloseResponse(t *testing.T, ev *omorpc.Event, rpc string, success bool) {
	t.Helper()
	if ev.Type != "response" || ev.SessionID != rpc {
		t.Fatalf("close response event: type=%q session=%q want response %q", ev.Type, ev.SessionID, rpc)
	}
	var raw map[string]any
	if err := json.Unmarshal(ev.Raw, &raw); err != nil {
		t.Fatalf("close response raw: %v", err)
	}
	if raw["command"] != omorpc.CmdCloseSession || raw["success"] != success {
		t.Fatalf("close response payload: %#v want success=%v", raw, success)
	}
}

func snapshotByPath(t *testing.T, daemon *omorpctest.Daemon, path string) omorpctest.SessionSnapshot {
	t.Helper()
	for _, snap := range daemon.SessionSnapshots() {
		if snap.Path == path {
			return snap
		}
	}
	t.Fatalf("missing session snapshot for %s", path)
	return omorpctest.SessionSnapshot{}
}
