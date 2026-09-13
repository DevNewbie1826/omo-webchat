package wsbridge

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/DevNewbie1826/omo-webchat/internal/session"
	"github.com/DevNewbie1826/omo-webchat/internal/wscontract"
)

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
	if got["running"] == nil || got["truncated"] == nil {
		t.Fatalf("lean activity absent: %v", got)
	}
	for _, key := range []string{"snapshots", "taskDigest", "dagDigest"} {
		if _, exists := got[key]; exists {
			t.Fatalf("rich activity leaked: %v", got)
		}
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
	initial.Title = "initial"
	source.initial = []session.Summary{initial}
	source.onSubscribe = func(publish func(session.Summary, bool)) {
		updated := activitySummary("child-1")
		updated.Title = "updated"
		publish(updated, false)
	}
	conn, frames, _ := connectActivityBridge(t, source)
	writeClient(t, conn, map[string]any{"type": "sessions.subscribe", "mode": "explicit", "sessionIds": []string{"child-1"}})
	frames.next(t, "ack")

	first := frames.next(t, "sessions.activity")
	second := frames.next(t, "sessions.activity")
	version := func(frame map[string]any) string {
		return frame["title"].(string)
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
