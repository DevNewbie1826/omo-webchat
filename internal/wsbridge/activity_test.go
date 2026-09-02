package wsbridge

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lxzan/gws"

	"github.com/DevNewbie1826/omo-webchat/internal/cursorstore"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc/omorpctest"
	"github.com/DevNewbie1826/omo-webchat/internal/session"
	"github.com/DevNewbie1826/omo-webchat/internal/wscontract"
)

type testActivitySubscription struct {
	publish func(session.Summary, bool)
	allLive bool
	ids     map[string]struct{}
}

type testActivitySource struct {
	mu           sync.Mutex
	next         int
	subs         map[int]testActivitySubscription
	initial      []session.Summary
	onSubscribe  func(func(session.Summary, bool))
	subscribed   chan struct{}
	unsubscribed chan struct{}
}

func newTestActivitySource() *testActivitySource {
	return &testActivitySource{
		subs: make(map[int]testActivitySubscription), subscribed: make(chan struct{}, 8), unsubscribed: make(chan struct{}, 8),
	}
}

func (s *testActivitySource) SubscribeActivity(allLive bool, sessionIDs []string, publish func(session.Summary, bool)) ([]session.Summary, func()) {
	s.mu.Lock()
	id := s.next
	s.next++
	ids := make(map[string]struct{}, len(sessionIDs))
	for _, sessionID := range sessionIDs {
		ids[sessionID] = struct{}{}
	}
	s.subs[id] = testActivitySubscription{publish: publish, allLive: allLive, ids: ids}
	initial := make([]session.Summary, 0, len(s.initial))
	for _, summary := range s.initial {
		if _, selected := ids[summary.ChatID]; allLive || selected {
			initial = append(initial, summary)
		}
	}
	onSubscribe := s.onSubscribe
	s.mu.Unlock()
	if onSubscribe != nil {
		onSubscribe(publish)
	}
	s.subscribed <- struct{}{}
	var once sync.Once
	return initial, func() {
		once.Do(func() {
			s.mu.Lock()
			delete(s.subs, id)
			s.mu.Unlock()
			s.unsubscribed <- struct{}{}
		})
	}
}

func (s *testActivitySource) publish(summary session.Summary) {
	s.publishOverflow(summary, false)
}

func (s *testActivitySource) publishOverflow(summary session.Summary, overflow bool) {
	s.mu.Lock()
	callbacks := make([]func(session.Summary, bool), 0, len(s.subs))
	for _, sub := range s.subs {
		if _, selected := sub.ids[summary.ChatID]; sub.allLive || selected {
			callbacks = append(callbacks, sub.publish)
		}
	}
	s.mu.Unlock()
	for _, callback := range callbacks {
		callback(summary, overflow)
	}
}

func (s *testActivitySource) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.subs)
}

func connectActivityBridge(t *testing.T, source ActivitySource) (*gws.Conn, *collector, *session.Manager) {
	t.Helper()
	store, err := cursorstore.Open(filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	manager := session.NewManager(session.Config{})
	t.Cleanup(func() { _ = manager.CloseAll(context.Background()) })
	server := httptest.NewServer(New(Config{Manager: manager, Store: store, ActivitySource: source}))
	t.Cleanup(server.Close)
	frames := &collector{notify: make(chan struct{}, 128)}
	conn, _, err := gws.NewClient(frames, &gws.ClientOption{Addr: "ws" + strings.TrimPrefix(server.URL, "http")})
	if err != nil {
		t.Fatal(err)
	}
	go conn.ReadLoop()
	frames.next(t, "hello")
	writeClient(t, conn, map[string]any{"type": "hello", "version": 2})
	t.Cleanup(func() { _ = conn.WriteClose(1000, nil) })
	return conn, frames, manager
}

func activitySummary(id string) session.Summary {
	return session.Summary{
		ChatID: id, DurableSessionID: id,
		ActivityPair: session.ActivityPair{
			Task: json.RawMessage(`{"parent_session_id":"child-1","tasks":[{"task_id":"t1","status":"running","updated_at":"2026-09-03T00:00:00Z"}],"truncated_tasks":false}`),
			Dag:  json.RawMessage(`{"runs":[{"run_id":"r1","status":"running","nodes":[{"task_id":"t1","state":"running"}]}],"truncated_runs":false}`),
		},
		TaskDigest: &session.TaskDigest{Tasks: []session.TaskDigestEntry{{TaskID: "t1", Status: "running", UpdatedAt: "2026-09-03T00:00:00Z"}}, ReceivedAt: "2026-09-03T00:00:00Z"},
		DagDigest:  &session.DagDigest{Runs: []session.RunDigestEntry{{RunID: "r1", Status: "running", RunningTaskIDs: []string{"t1"}}}, ReceivedAt: "2026-09-03T00:00:00Z"},
	}
}

func awaitSignal(t *testing.T, signal <-chan struct{}, name string) {
	t.Helper()
	select {
	case <-signal:
	case <-time.After(5 * time.Second):
		t.Fatalf("timed out waiting for %s", name)
	}
}

func activityFrameCount(c *collector) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	count := 0
	for _, raw := range c.frames {
		var frame struct {
			Type string `json:"type"`
		}
		_ = json.Unmarshal(raw, &frame)
		if frame.Type == "sessions.activity" {
			count++
		}
	}
	return count
}

func TestManagerCachePublishesUnboundActivityToSubscribedSocket(t *testing.T) {
	// Darwin's unix socket path limit is shorter than t.TempDir paths derived
	// from this test name.
	dir, err := os.MkdirTemp("", "wsactivity-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	daemon := omorpctest.New(dir)
	if err := daemon.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(daemon.Stop)
	client, err := omorpc.Dial(t.Context(), daemon.SocketPath())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close() })
	store, err := cursorstore.Open(filepath.Join(dir, "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	manager := session.NewManager(session.Config{Client: client, Store: (*CursorStore)(store)})
	t.Cleanup(func() { _ = manager.CloseAll(context.Background()) })
	server := httptest.NewServer(New(Config{Manager: manager, Store: store}))
	t.Cleanup(server.Close)
	frames := &collector{notify: make(chan struct{}, 64)}
	conn, _, err := gws.NewClient(frames, &gws.ClientOption{Addr: "ws" + strings.TrimPrefix(server.URL, "http")})
	if err != nil {
		t.Fatal(err)
	}
	go conn.ReadLoop()
	t.Cleanup(func() { _ = conn.WriteClose(1000, nil) })
	frames.next(t, "hello")
	writeClient(t, conn, map[string]any{"type": "hello", "version": 2})
	writeClient(t, conn, map[string]any{"type": "sessions.subscribe", "mode": "explicit", "sessionIds": []string{"child-real"}})
	frames.next(t, "ack")

	daemon.Emit(map[string]any{
		"type": "extension_event", "sessionId": "child-real", "name": "omo.task.updated",
		"data": map[string]any{"parent_session_id": "child-real", "tasks": []any{map[string]any{"task_id": "real-task", "status": "running"}}},
	})
	got := frames.next(t, "sessions.activity")
	if got["sessionId"] != "child-real" {
		t.Fatalf("manager activity frame = %v", got)
	}
	if summaries := manager.LiveSummaries(); len(summaries) != 1 || summaries[0].ChatID != "child-real" {
		t.Fatalf("manager overview cache = %+v", summaries)
	}
}

func TestSubscribeWithoutAttachReceivesActivityAndUnsubscribeStops(t *testing.T) {
	source := newTestActivitySource()
	conn, frames, manager := connectActivityBridge(t, source)
	writeClient(t, conn, map[string]any{"type": "sessions.subscribe", "mode": "explicit", "sessionIds": []string{"child-1"}})
	awaitSignal(t, source.subscribed, "activity subscription")
	if ack := frames.next(t, "ack"); ack["command"] != "sessions.subscribe" {
		t.Fatalf("subscribe ack = %v", ack)
	}
	if summaries := manager.LiveSummaries(); len(summaries) != 0 {
		t.Fatalf("activity subscription attached a chat: %+v", summaries)
	}

	source.publish(activitySummary("other"))
	source.publish(activitySummary("child-1"))
	got := frames.next(t, "sessions.activity")
	if got["sessionId"] != "child-1" || got["durableSessionId"] != "child-1" || got["overflow"] != false {
		t.Fatalf("activity envelope = %v", got)
	}
	snapshots, ok := got["snapshots"].([]any)
	if !ok || len(snapshots) != 2 || snapshots[0].(map[string]any)["name"] != "omo.task.updated" || snapshots[1].(map[string]any)["name"] != "omo.dag.updated" {
		t.Fatalf("activity snapshot order = %v", got["snapshots"])
	}
	if got["taskDigest"] == nil || got["dagDigest"] == nil {
		t.Fatalf("activity digests absent: %v", got)
	}
	raw, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := wscontract.ParseServerFrame(raw); err != nil {
		t.Fatalf("bridge emitted frame outside closed contract: %v", err)
	}

	writeClient(t, conn, map[string]any{"type": "sessions.subscribe", "mode": "none"})
	awaitSignal(t, source.unsubscribed, "activity unsubscribe")
	frames.next(t, "ack")
	before := activityFrameCount(frames)
	source.publish(activitySummary("child-1"))
	if after := activityFrameCount(frames); after != before {
		t.Fatalf("unsubscribe delivered activity: before=%d after=%d", before, after)
	}
}

func TestActivityFrameCarriesExplicitRemapIdentity(t *testing.T) {
	frame := activityFrame(session.Summary{
		ChatID: "chat-stable", DurableSessionID: "durable-provisional", ReplacesSessionID: "durable-provisional",
	}, false)
	raw, err := json.Marshal(frame)
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatal(err)
	}
	if got["sessionId"] != "chat-stable" || got["durableSessionId"] != "durable-provisional" || got["replacesSessionId"] != "durable-provisional" {
		t.Fatalf("remap wire identity = %v", got)
	}
	if _, err := wscontract.ParseServerFrame(raw); err != nil {
		t.Fatalf("remap frame outside contract: %v", err)
	}
}

func TestActivitySubscriptionSocketCloseCleansUpAndRESTOnlySocketIsUnaffected(t *testing.T) {
	source := newTestActivitySource()
	conn, frames, _ := connectActivityBridge(t, source)
	writeClient(t, conn, map[string]any{"type": "sessions.subscribe", "mode": "all_live"})
	awaitSignal(t, source.subscribed, "all-live subscription")
	frames.next(t, "ack")
	if err := conn.WriteClose(1000, nil); err != nil {
		t.Fatal(err)
	}
	awaitSignal(t, source.unsubscribed, "socket-close unsubscribe")
	if count := source.count(); count != 0 {
		t.Fatalf("subscriptions after close = %d", count)
	}

	restOnly, restFrames, _ := connectActivityBridge(t, source)
	source.publish(activitySummary("child-1"))
	writeClient(t, restOnly, map[string]any{"type": "ping"})
	restFrames.next(t, "pong")
	if got := activityFrameCount(restFrames); got != 0 {
		t.Fatalf("unsubscribed socket received %d activity frames", got)
	}
}

func TestActivitySubscribeBootstrapPrecedesConcurrentUpdate(t *testing.T) {
	source := newTestActivitySource()
	initial := activitySummary("child-1")
	initial.ActivityPair.Task = json.RawMessage(`{"version":"initial"}`)
	source.initial = []session.Summary{initial}
	source.onSubscribe = func(publish func(session.Summary, bool)) {
		updated := activitySummary("child-1")
		updated.ActivityPair.Task = json.RawMessage(`{"version":"updated"}`)
		publish(updated, false)
	}
	conn, frames, _ := connectActivityBridge(t, source)
	writeClient(t, conn, map[string]any{"type": "sessions.subscribe", "mode": "explicit", "sessionIds": []string{"child-1"}})
	frames.next(t, "ack")

	first := frames.next(t, "sessions.activity")
	second := frames.next(t, "sessions.activity")
	version := func(frame map[string]any) string {
		snapshots := frame["snapshots"].([]any)
		return snapshots[0].(map[string]any)["data"].(map[string]any)["version"].(string)
	}
	if got := []string{version(first), version(second)}; got[0] != "initial" || got[1] != "updated" {
		t.Fatalf("bootstrap order = %v, want [initial updated]", got)
	}
}

func TestActivityOverflowPropagatesThroughSourceAndBridgeQueues(t *testing.T) {
	source := newTestActivitySource()
	source.onSubscribe = func(publish func(session.Summary, bool)) {
		for i := 0; i <= activityQueueSize; i++ {
			publish(session.Summary{ChatID: "child-1", Title: fmt.Sprintf("update-%d", i)}, i == activityQueueSize)
		}
	}
	conn, frames, _ := connectActivityBridge(t, source)
	writeClient(t, conn, map[string]any{"type": "sessions.subscribe", "mode": "explicit", "sessionIds": []string{"child-1"}})
	frames.next(t, "ack")
	for i := 0; i < activityQueueSize; i++ {
		frame := frames.next(t, "sessions.activity")
		if frame["overflow"] == true {
			return
		}
	}
	t.Fatal("source or bridge overflow was not propagated")
}

func TestActivityPumpDropsOldestAndFlagsOverflow(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	pump := newActivityPump(&connection{ctx: ctx})
	defer pump.cancel()
	for i := 0; i <= activityQueueSize; i++ {
		pump.enqueue(session.Summary{ChatID: string(rune('a' + i))}, false)
	}
	pump.mu.Lock()
	defer pump.mu.Unlock()
	if len(pump.queue) != activityQueueSize {
		t.Fatalf("activity queue length = %d, want %d", len(pump.queue), activityQueueSize)
	}
	if pump.queue[0].summary.ChatID == "a" {
		t.Fatal("activity queue did not drop its oldest frame")
	}
	if !pump.queue[len(pump.queue)-1].overflow {
		t.Fatal("replacement frame did not report overflow")
	}
}

var _ ActivitySource = (*testActivitySource)(nil)
