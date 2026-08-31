package api

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/lxzan/gws"

	"github.com/DevNewbie1826/omo-webchat/internal/auth"
	"github.com/DevNewbie1826/omo-webchat/internal/config"
	"github.com/DevNewbie1826/omo-webchat/internal/store"
)

// countType reports how many received frames carry the given type.
func (f *frameCollector) countType(typ string) int {
	count := 0
	for _, b := range f.snapshot() {
		var env struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(b, &env) == nil && env.Type == typ {
			count++
		}
	}
	return count
}

// quiesce drains a collector's in-flight frames and returns the
// end-of-stream index. The second attach's initialize yields exactly one
// stats response and one trailing entries response (its last query), and
// each chat.stats request yields exactly one more stats response queued
// behind them. Delivery is FIFO per subscriber, so once this helper's own
// stats response lands — stats count 2 = initialize + request, entries
// sentinel present — every earlier queued frame has been delivered and
// nothing remains in flight.
func quiesce(t *testing.T, client *gws.Conn, collector *frameCollector, sessionID string) int {
	t.Helper()
	writeFrame(t, client, map[string]any{"type": "chat.stats", "sessionId": sessionID})
	deadline := time.After(3 * time.Second)
	for collector.countType("stats") < 2 || collector.countType("entries") < 1 {
		select {
		case <-collector.notify:
		case <-deadline:
			t.Fatalf("timed out waiting for the quiesce round-trip; have: %s", collector.types())
		}
	}
	return len(collector.snapshot())
}

// End to end: after a mock-pi turn cached the activity snapshots, an
// activity.refresh command replays the cached task and dag frames to the
// REQUESTING websocket only — a second client attached to the same session
// receives nothing, and no provider round-trip is involved.
func TestWebSocketActivityRefreshPullsSnapshotToRequestingClient(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skipf("node not in PATH: %v", err)
	}
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)
	t.Setenv("CHAT_PI_BINARY", "node")
	t.Setenv("CHAT_PI_ARGS", mockPiPath(t))
	t.Setenv("MOCK_PI_EXT_EVENT", "1")

	ctx := context.Background()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	st, err := store.Load(ctx, logger)
	if err != nil {
		t.Fatalf("load store: %v", err)
	}
	ws, err := st.CreateWorkspace("activity-refresh-demo", tmp)
	if err != nil {
		t.Fatalf("create workspace: %v", err)
	}
	chat, err := st.NewChat(ws.ID, "activity-refresh-qa", ws.Path, "", "omo")
	if err != nil {
		t.Fatalf("create chat: %v", err)
	}
	sessions := auth.NewSessionStore(ctx, "pw", logger)
	apiServer := New(ctx, &config.Config{Root: tmp, Provider: "omo"}, st, sessions, logger)
	t.Cleanup(apiServer.chats.CloseAll)
	server := httptest.NewServer(http.HandlerFunc(apiServer.handleWS))
	defer server.Close()
	defer server.CloseClientConnections()

	requester := &frameCollector{notify: make(chan struct{}, 256)}
	client1, _, err := gws.NewClient(requester, &gws.ClientOption{
		Addr: "ws" + strings.TrimPrefix(server.URL, "http"),
	})
	if err != nil {
		t.Fatalf("connect requester ws: %v", err)
	}
	t.Cleanup(func() { _ = client1.WriteClose(1000, nil) })
	go client1.ReadLoop()

	writeFrame(t, client1, map[string]any{"type": "chat.create", "wsId": ws.ID, "chatId": chat.ID})
	requester.waitFor(t, "ready", 3*time.Second)
	writeFrame(t, client1, map[string]any{
		"type":      "chat.send",
		"sessionId": chat.ID,
		"run":       map[string]any{"kind": "prompt", "message": "hello"},
	})
	requester.waitFor(t, "run.done", 5*time.Second)

	// A second client attaches to the SAME live session; its attach replay
	// must settle before the refresh so later traffic has one source.
	bystander := &frameCollector{notify: make(chan struct{}, 256)}
	client2, _, err := gws.NewClient(bystander, &gws.ClientOption{
		Addr: "ws" + strings.TrimPrefix(server.URL, "http"),
	})
	if err != nil {
		t.Fatalf("connect bystander ws: %v", err)
	}
	t.Cleanup(func() { _ = client2.WriteClose(1000, nil) })
	go client2.ReadLoop()
	writeFrame(t, client2, map[string]any{"type": "chat.create", "wsId": ws.ID, "chatId": chat.ID})
	bystander.waitFor(t, "ready", 3*time.Second)
	replayed := collectExtEvents(bystander.snapshot())
	replayDeadline := time.After(5 * time.Second)
	for len(extEventNames(replayed)) < 2 {
		select {
		case <-bystander.notify:
		case <-replayDeadline:
			t.Fatalf("bystander attach replay names = %v, want both events replayed; have: %s", extEventNames(replayed), bystander.types())
		}
		replayed = collectExtEvents(bystander.snapshot())
	}
	// The second attach also queues initialize query responses (and their
	// broadcast copies to the requester) behind the replay. Quiesce ONLY the
	// bystander: it is the sole stats sender, so a pass whose stats response
	// lands as the first frame after the mark is provably self-correlated and
	// proves its stream is fully drained — nothing queues to it afterwards.
	// Straggler broadcast copies still reaching the requester are never
	// extensionEvent frames, and the assertions below only count those.
	bystanderStart := quiesce(t, client2, bystander, chat.ID)
	refreshStart := len(requester.snapshot())
	writeFrame(t, client1, map[string]any{"type": "activity.refresh", "sessionId": chat.ID})
	firstEvent := requester.waitForAfter(t, "extensionEvent", refreshStart, 3*time.Second)
	requester.waitForAfter(t, "extensionEvent", firstEvent, 3*time.Second)

	// Stragglers are never extensionEvent frames (the provider is idle after
	// run.done and no turn follows), so the post-mark extensionEvents are
	// exactly the refresh's two frames.
	pulled := collectExtEvents(requester.snapshot()[refreshStart:])
	events := pulled
	if len(events) != 2 {
		t.Fatalf("refresh produced %d extensionEvent frames, want exactly 2; have: %s", len(events), requester.types())
	}
	if names := extEventNames(events); !reflect.DeepEqual(names, []string{"omo.task.updated", "omo.dag.updated"}) {
		t.Fatalf("refresh extensionEvent names = %v, want exactly [omo.task.updated omo.dag.updated] in replay order; have: %s", names, requester.types())
	}
	for _, ev := range events {
		if ev.SessionID != chat.ID {
			t.Fatalf("refresh extensionEvent sessionId = %q, want %q", ev.SessionID, chat.ID)
		}
	}
	var gotTask, wantTask any
	if err := json.Unmarshal(events[0].Data, &gotTask); err != nil {
		t.Fatalf("pulled task data is not valid JSON: %v (%s)", err, events[0].Data)
	}
	if err := json.Unmarshal([]byte(`{"task":{"id":"st_mock_001","name":"st_mock","title":"Quick category agent","status":"running","category":"quick"}}`), &wantTask); err != nil {
		t.Fatalf("fixture data is not valid JSON: %v", err)
	}
	if !reflect.DeepEqual(gotTask, wantTask) {
		t.Fatalf("pulled task data = %s, want the mock task payload verbatim", events[0].Data)
	}
	var gotDag, wantDag any
	if err := json.Unmarshal(events[1].Data, &gotDag); err != nil {
		t.Fatalf("pulled dag data is not valid JSON: %v (%s)", err, events[1].Data)
	}
	if err := json.Unmarshal([]byte(`{"dag":{"nodes":[{"id":"st_mock_001","status":"running"}],"edges":[]}}`), &wantDag); err != nil {
		t.Fatalf("fixture data is not valid JSON: %v", err)
	}
	if !reflect.DeepEqual(gotDag, wantDag) {
		t.Fatalf("pulled dag data = %s, want the mock dag payload verbatim", events[1].Data)
	}

	// Round-trip a bystander query after the refresh so its FIFO is known to
	// have drained before checking for unicast leakage.
	statsBefore := bystander.countType("stats")
	writeFrame(t, client2, map[string]any{"type": "chat.stats", "sessionId": chat.ID})
	deadline := time.After(3 * time.Second)
	for bystander.countType("stats") <= statsBefore {
		select {
		case <-bystander.notify:
		case <-deadline:
			t.Fatalf("timed out waiting for post-refresh bystander sentinel; have: %s", bystander.types())
		}
	}
	if leaked := len(collectExtEvents(bystander.snapshot()[bystanderStart:])); leaked != 0 {
		t.Fatalf("bystander received %d extensionEvent frames from the refresh, want 0; have: %s", leaked, bystander.types())
	}
}

// End to end: activity.refresh with no attached session is rejected with the
// same no_session error frame every other session-bound command uses.
func TestWebSocketActivityRefreshWithoutSession(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skipf("node not in PATH: %v", err)
	}
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)
	t.Setenv("CHAT_PI_BINARY", "node")
	t.Setenv("CHAT_PI_ARGS", mockPiPath(t))

	ctx := context.Background()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	st, err := store.Load(ctx, logger)
	if err != nil {
		t.Fatalf("load store: %v", err)
	}
	ws, err := st.CreateWorkspace("activity-refresh-nosess", tmp)
	if err != nil {
		t.Fatalf("create workspace: %v", err)
	}
	if _, err := st.NewChat(ws.ID, "activity-refresh-nosess-qa", ws.Path, "", "omo"); err != nil {
		t.Fatalf("create chat: %v", err)
	}
	sessions := auth.NewSessionStore(ctx, "pw", logger)
	apiServer := New(ctx, &config.Config{Root: tmp, Provider: "omo"}, st, sessions, logger)
	t.Cleanup(apiServer.chats.CloseAll)
	server := httptest.NewServer(http.HandlerFunc(apiServer.handleWS))
	defer server.Close()
	defer server.CloseClientConnections()

	collector := &frameCollector{notify: make(chan struct{}, 256)}
	client, _, err := gws.NewClient(collector, &gws.ClientOption{
		Addr: "ws" + strings.TrimPrefix(server.URL, "http"),
	})
	if err != nil {
		t.Fatalf("connect ws: %v", err)
	}
	t.Cleanup(func() { _ = client.WriteClose(1000, nil) })
	go client.ReadLoop()

	writeFrame(t, client, map[string]any{"type": "activity.refresh", "sessionId": "unattached-client-session"})
	collector.waitFor(t, "error", 3*time.Second)
	var errFrame struct {
		Code string `json:"code"`
	}
	for _, b := range collector.snapshot() {
		var env struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(b, &env) != nil || env.Type != "error" {
			continue
		}
		if json.Unmarshal(b, &errFrame) != nil {
			t.Fatalf("error frame is not a valid error frame: %s", b)
		}
		if errFrame.Code != "no_session" {
			t.Fatalf("refresh without a session: error code = %q, want %q; frame: %s", errFrame.Code, "no_session", b)
		}
		return
	}
	t.Fatalf("no error frame found; have: %s", collector.types())
}
