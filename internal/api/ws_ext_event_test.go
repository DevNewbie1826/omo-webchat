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

// extEventFrame is the parsed shape of an "extensionEvent" client frame.
type extEventFrame struct {
	Type      string          `json:"type"`
	SessionID string          `json:"sessionId"`
	Name      string          `json:"name"`
	Data      json.RawMessage `json:"data"`
}

func collectExtEvents(frames [][]byte) []extEventFrame {
	var out []extEventFrame
	for _, b := range frames {
		var env extEventFrame
		if json.Unmarshal(b, &env) == nil && env.Type == "extensionEvent" {
			out = append(out, env)
		}
	}
	return out
}

func extEventNames(events []extEventFrame) []string {
	names := make([]string, len(events))
	for i, ev := range events {
		names[i] = ev.Name
	}
	return names
}

// End to end: a mock-pi provider (MOCK_PI_EXT_EVENT=1) emits a valid
// extension_event plus a nameless one during a turn; the WebSocket client
// must receive exactly the two valid extensionEvent frames with payloads
// intact.
func TestWebSocketExtensionEventForwarded(t *testing.T) {
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
	ws, err := st.CreateWorkspace("ext-event-demo", tmp)
	if err != nil {
		t.Fatalf("create workspace: %v", err)
	}
	chat, err := st.NewChat(ws.ID, "ext-event-qa", ws.Path, "", "omo")
	if err != nil {
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

	writeFrame(t, client, map[string]any{"type": "chat.create", "wsId": ws.ID, "chatId": chat.ID})
	collector.waitFor(t, "ready", 3*time.Second)
	writeFrame(t, client, map[string]any{
		"type":      "chat.send",
		"sessionId": chat.ID,
		"run":       map[string]any{"kind": "prompt", "message": "hello"},
	})
	collector.waitFor(t, "run.done", 5*time.Second)

	forwarded := collectExtEvents(collector.snapshot())
	if names := extEventNames(forwarded); !reflect.DeepEqual(names, []string{"omo.task.updated", "omo.dag.updated"}) {
		t.Fatalf("extensionEvent names = %v, want exactly [omo.task.updated omo.dag.updated] (valid forwarded, nameless dropped); have: %s", names, collector.types())
	}
	ev := forwarded[0]
	if ev.SessionID != chat.ID {
		t.Fatalf("extensionEvent sessionId = %q, want %q", ev.SessionID, chat.ID)
	}
	var gotTask, wantTask any
	if err := json.Unmarshal(ev.Data, &gotTask); err != nil {
		t.Fatalf("task data is not valid JSON: %v (%s)", err, ev.Data)
	}
	if err := json.Unmarshal([]byte(`{"task":{"id":"st_mock_001","name":"st_mock","title":"Quick category agent","status":"running","category":"quick"}}`), &wantTask); err != nil {
		t.Fatalf("fixture data is not valid JSON: %v", err)
	}
	if !reflect.DeepEqual(gotTask, wantTask) {
		t.Fatalf("task data = %s, want the mock task payload verbatim", ev.Data)
	}
	var gotDag, wantDag any
	if err := json.Unmarshal(forwarded[1].Data, &gotDag); err != nil {
		t.Fatalf("dag data is not valid JSON: %v (%s)", err, forwarded[1].Data)
	}
	if err := json.Unmarshal([]byte(`{"dag":{"nodes":[{"id":"st_mock_001","status":"running"}],"edges":[]}}`), &wantDag); err != nil {
		t.Fatalf("fixture data is not valid JSON: %v", err)
	}
	if !reflect.DeepEqual(gotDag, wantDag) {
		t.Fatalf("dag data = %s, want the mock dag payload verbatim", forwarded[1].Data)
	}
}

// End to end: activity snapshots emitted during a turn on one connection
// are replayed to a second connection that attaches to the same live session
// after the first one closes — task first, dag second, payloads verbatim.
func TestWebSocketExtensionEventReplayedOnReattach(t *testing.T) {
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
	ws, err := st.CreateWorkspace("ext-replay-demo", tmp)
	if err != nil {
		t.Fatalf("create workspace: %v", err)
	}
	chat, err := st.NewChat(ws.ID, "ext-replay-qa", ws.Path, "", "omo")
	if err != nil {
		t.Fatalf("create chat: %v", err)
	}
	sessions := auth.NewSessionStore(ctx, "pw", logger)
	apiServer := New(ctx, &config.Config{Root: tmp, Provider: "omo"}, st, sessions, logger)
	t.Cleanup(apiServer.chats.CloseAll)
	server := httptest.NewServer(http.HandlerFunc(apiServer.handleWS))
	defer server.Close()
	defer server.CloseClientConnections()

	first := &frameCollector{notify: make(chan struct{}, 256)}
	client1, _, err := gws.NewClient(first, &gws.ClientOption{
		Addr: "ws" + strings.TrimPrefix(server.URL, "http"),
	})
	if err != nil {
		t.Fatalf("connect first ws: %v", err)
	}
	go client1.ReadLoop()
	writeFrame(t, client1, map[string]any{"type": "chat.create", "wsId": ws.ID, "chatId": chat.ID})
	first.waitFor(t, "ready", 3*time.Second)
	writeFrame(t, client1, map[string]any{
		"type":      "chat.send",
		"sessionId": chat.ID,
		"run":       map[string]any{"kind": "prompt", "message": "hello"},
	})
	first.waitFor(t, "run.done", 5*time.Second)
	if names := extEventNames(collectExtEvents(first.snapshot())); !reflect.DeepEqual(names, []string{"omo.task.updated", "omo.dag.updated"}) {
		t.Fatalf("first connection extensionEvent names = %v, want [omo.task.updated omo.dag.updated]; have: %s", names, first.types())
	}
	_ = client1.WriteClose(1000, nil)

	// A second connection attaches to the SAME live session.
	second := &frameCollector{notify: make(chan struct{}, 256)}
	client2, _, err := gws.NewClient(second, &gws.ClientOption{
		Addr: "ws" + strings.TrimPrefix(server.URL, "http"),
	})
	if err != nil {
		t.Fatalf("connect second ws: %v", err)
	}
	t.Cleanup(func() { _ = client2.WriteClose(1000, nil) })
	go client2.ReadLoop()
	writeFrame(t, client2, map[string]any{"type": "chat.create", "wsId": ws.ID, "chatId": chat.ID})
	second.waitFor(t, "ready", 3*time.Second)

	replayed := collectExtEvents(second.snapshot())
	// Replay delivery is asynchronous per subscriber: wait for both replayed
	// extension events to flush through the writer goroutine before asserting.
	replayDeadline := time.After(5 * time.Second)
	for len(extEventNames(replayed)) < 2 {
		select {
		case <-second.notify:
		case <-replayDeadline:
			t.Fatalf("second connection extensionEvent names = %v, want exactly [omo.task.updated omo.dag.updated] replayed; have: %s", extEventNames(replayed), second.types())
		}
		replayed = collectExtEvents(second.snapshot())
	}
	statsStart := len(second.snapshot())
	writeFrame(t, client2, map[string]any{"type": "chat.stats", "sessionId": chat.ID})
	second.waitForAfter(t, "stats", statsStart, 3*time.Second)
	if names := extEventNames(collectExtEvents(second.snapshot())); !reflect.DeepEqual(names, []string{"omo.task.updated", "omo.dag.updated"}) {
		t.Fatalf("second connection extensionEvent names = %v, want exactly [omo.task.updated omo.dag.updated] replayed; have: %s", names, second.types())
	}
	replayed = collectExtEvents(second.snapshot())
	var wantTask, wantDag any
	if err := json.Unmarshal([]byte(`{"task":{"id":"st_mock_001","name":"st_mock","title":"Quick category agent","status":"running","category":"quick"}}`), &wantTask); err != nil {
		t.Fatalf("task fixture is not valid JSON: %v", err)
	}
	if err := json.Unmarshal([]byte(`{"dag":{"nodes":[{"id":"st_mock_001","status":"running"}],"edges":[]}}`), &wantDag); err != nil {
		t.Fatalf("dag fixture is not valid JSON: %v", err)
	}
	var gotTask, gotDag any
	if err := json.Unmarshal(replayed[0].Data, &gotTask); err != nil {
		t.Fatalf("replayed task data is not valid JSON: %v (%s)", err, replayed[0].Data)
	}
	if err := json.Unmarshal(replayed[1].Data, &gotDag); err != nil {
		t.Fatalf("replayed dag data is not valid JSON: %v (%s)", err, replayed[1].Data)
	}
	if !reflect.DeepEqual(gotTask, wantTask) || !reflect.DeepEqual(gotDag, wantDag) {
		t.Fatalf("replayed payloads = %s / %s, want the mock task and dag payloads verbatim", replayed[0].Data, replayed[1].Data)
	}
}
