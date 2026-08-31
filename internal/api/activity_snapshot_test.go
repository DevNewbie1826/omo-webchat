package api

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/lxzan/gws"

	"github.com/DevNewbie1826/omo-webchat/internal/auth"
	"github.com/DevNewbie1826/omo-webchat/internal/config"
	"github.com/DevNewbie1826/omo-webchat/internal/store"
)

// seedTaskData / seedDagData are the persisted activity payloads planted in
// the chat record's state file before the server starts. They deliberately
// differ from mock-pi's live payloads (st_seed_001/completed vs
// st_mock_001/running) so a replay of the stale seed can never be confused
// with a replay of fresher live state.
const seedTaskData = `{"task":{"id":"st_seed_001","name":"seed","title":"Seeded subagent","status":"completed","category":"quick"}}`

const seedDagData = `{"dag":{"nodes":[{"id":"st_seed_001","status":"completed"}],"edges":[]}}`

// liveTaskData / liveDagData mirror the payloads mock-pi emits under
// MOCK_PI_EXT_EVENT=1 (see ws_ext_event_test.go).
const liveTaskData = `{"task":{"id":"st_mock_001","name":"st_mock","title":"Quick category agent","status":"running","category":"quick"}}`

const liveDagData = `{"dag":{"nodes":[{"id":"st_mock_001","status":"running"}],"edges":[]}}`

// seedSnapshotState writes a state file whose chat record already carries an
// activitySnapshot pair, as if a previous server run had persisted it. It
// returns the fake HOME the store and server must run under.
func seedSnapshotState(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	dir, err := store.StateDir()
	if err != nil {
		t.Fatalf("state dir: %v", err)
	}
	fixture := map[string]any{
		"workspaces": []any{
			map[string]any{
				"id":   "ws-snap",
				"name": "snap",
				"path": home,
				"chats": []any{
					map[string]any{
						"id":        "chat-snap",
						"name":      "snap-qa",
						"wsId":      "ws-snap",
						"cwd":       home,
						"provider":  "omo",
						"createdAt": 1234,
						"activitySnapshot": map[string]any{
							"task": json.RawMessage(seedTaskData),
							"dag":  json.RawMessage(seedDagData),
						},
					},
				},
			},
		},
	}
	raw, err := json.Marshal(fixture)
	if err != nil {
		t.Fatalf("marshal fixture: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "state.json"), raw, 0o600); err != nil {
		t.Fatalf("write state fixture: %v", err)
	}
	return home
}

// snapshotServer starts a WebSocket API server over the seeded store.
func snapshotServer(t *testing.T, home string) *httptest.Server {
	t.Helper()
	ctx := context.Background()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	st, err := store.Load(ctx, logger)
	if err != nil {
		t.Fatalf("load store: %v", err)
	}
	sessions := auth.NewSessionStore(ctx, "pw", logger)
	apiServer := New(ctx, &config.Config{Root: home, Provider: "omo"}, st, sessions, logger)
	server := httptest.NewServer(http.HandlerFunc(apiServer.handleWS))
	t.Cleanup(func() {
		server.Close()
		server.CloseClientConnections()
	})
	return server
}

func connectCollector(t *testing.T, server *httptest.Server) (*frameCollector, *gws.Conn) {
	t.Helper()
	collector := &frameCollector{notify: make(chan struct{}, 256)}
	client, _, err := gws.NewClient(collector, &gws.ClientOption{
		Addr: "ws" + strings.TrimPrefix(server.URL, "http"),
	})
	if err != nil {
		t.Fatalf("connect ws: %v", err)
	}
	t.Cleanup(func() { _ = client.WriteClose(1000, nil) })
	go client.ReadLoop()
	return collector, client
}

func assertSnapshotFrames(t *testing.T, frames []extEventFrame, wantTaskData, wantDagData, sessionID string) {
	t.Helper()
	if names := extEventNames(frames); !reflect.DeepEqual(names, []string{"omo.task.updated", "omo.dag.updated"}) {
		t.Fatalf("extensionEvent names = %v, want exactly [omo.task.updated omo.dag.updated]; have: %s", names, extEventNamesString(frames))
	}
	for i, want := range []string{wantTaskData, wantDagData} {
		var got, expected any
		if err := json.Unmarshal(frames[i].Data, &got); err != nil {
			t.Fatalf("frame %d data is not valid JSON: %v (%s)", i, err, frames[i].Data)
		}
		if err := json.Unmarshal([]byte(want), &expected); err != nil {
			t.Fatalf("fixture data is not valid JSON: %v", err)
		}
		if !reflect.DeepEqual(got, expected) {
			t.Fatalf("frame %d data = %s, want %s", i, frames[i].Data, want)
		}
	}
	if frames[0].SessionID != sessionID {
		t.Fatalf("extensionEvent sessionId = %q, want %q", frames[0].SessionID, sessionID)
	}
}

func extEventNamesString(frames []extEventFrame) string {
	names := extEventNames(frames)
	out, _ := json.Marshal(names)
	return string(out)
}

// End to end: a chat whose persisted record carries an activity snapshot
// (written by a previous run) must replay it — task first, dag second,
// payloads verbatim — to the client attaching to the session restored from
// disk, even though the restored provider has no in-memory activity state.
func TestWebSocketRestoredChatReplaysPersistedActivity(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skipf("node not in PATH: %v", err)
	}
	home := seedSnapshotState(t)
	t.Setenv("CHAT_PI_BINARY", "node")
	t.Setenv("CHAT_PI_ARGS", mockPiPath(t))

	server := snapshotServer(t, home)
	collector, client := connectCollector(t, server)
	writeFrame(t, client, map[string]any{"type": "chat.create", "wsId": "ws-snap", "chatId": "chat-snap"})
	collector.waitFor(t, "ready", 3*time.Second)

	replayed := collectExtEvents(collector.snapshot())
	assertSnapshotFrames(t, replayed, seedTaskData, seedDagData, "chat-snap")
}

// End to end: a settled run over a seeded session must (a) persist the live
// pair to the chat record on disk and (b) leave the in-memory fast path
// intact, so a reattach to the still-live session replays the live payloads —
// the persisted seed only fills the gap until real snapshots arrive.
func TestWebSocketLiveRunSupersedesPersistedSeed(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skipf("node not in PATH: %v", err)
	}
	home := seedSnapshotState(t)
	t.Setenv("CHAT_PI_BINARY", "node")
	t.Setenv("CHAT_PI_ARGS", mockPiPath(t))
	t.Setenv("MOCK_PI_EXT_EVENT", "1")

	server := snapshotServer(t, home)
	first, client1 := connectCollector(t, server)
	writeFrame(t, client1, map[string]any{"type": "chat.create", "wsId": "ws-snap", "chatId": "chat-snap"})
	first.waitFor(t, "ready", 3*time.Second)
	writeFrame(t, client1, map[string]any{
		"type":      "chat.send",
		"sessionId": "chat-snap",
		"run":       map[string]any{"kind": "prompt", "message": "hello"},
	})
	first.waitFor(t, "run.done", 5*time.Second)

	// The settled run must have persisted the live pair to the state file.
	statePath := filepath.Join(home, ".local", "state", "omo-webchat", "state.json")
	var wantLiveTask any
	if err := json.Unmarshal([]byte(liveTaskData), &wantLiveTask); err != nil {
		t.Fatalf("fixture data is not valid JSON: %v", err)
	}
	var persistedTask, persistedDag json.RawMessage
	deadline := time.After(5 * time.Second)
	for {
		persistedTask, persistedDag = readPersistedSnapshot(t, statePath)
		var got any
		if persistedTask != nil && json.Unmarshal(persistedTask, &got) == nil && reflect.DeepEqual(got, wantLiveTask) {
			break
		}
		select {
		case <-deadline:
			t.Fatalf("run completion never persisted the live payload to %s; task on disk: %s", statePath, persistedTask)
		case <-time.After(5 * time.Millisecond):
		}
	}
	var persistedDagAny, wantLiveDag any
	if err := json.Unmarshal(persistedDag, &persistedDagAny); err != nil {
		t.Fatalf("persisted dag is not valid JSON: %v (%s)", err, persistedDag)
	}
	if err := json.Unmarshal([]byte(liveDagData), &wantLiveDag); err != nil {
		t.Fatalf("fixture data is not valid JSON: %v", err)
	}
	if !reflect.DeepEqual(persistedDagAny, wantLiveDag) {
		t.Fatalf("persisted dag = %s, want the live payload %s", persistedDag, liveDagData)
	}

	// Reattach to the SAME live session: the in-memory fast path replays the
	// live payloads, never the stale persisted seed.
	_ = client1.WriteClose(1000, nil)
	second, client2 := connectCollector(t, server)
	writeFrame(t, client2, map[string]any{"type": "chat.create", "wsId": "ws-snap", "chatId": "chat-snap"})
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
	writeFrame(t, client2, map[string]any{"type": "chat.stats", "sessionId": "chat-snap"})
	second.waitForAfter(t, "stats", statsStart, 3*time.Second)
	assertSnapshotFrames(t, collectExtEvents(second.snapshot()), liveTaskData, liveDagData, "chat-snap")
}

// readPersistedSnapshot reads the activity pair of chat-snap from the state
// file on disk, or returns nils when the record carries none.
func readPersistedSnapshot(t *testing.T, path string) (json.RawMessage, json.RawMessage) {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read state file: %v", err)
	}
	var parsed struct {
		Workspaces []struct {
			ID    string `json:"id"`
			Chats []struct {
				ID               string `json:"id"`
				ActivitySnapshot *struct {
					Task json.RawMessage `json:"task"`
					Dag  json.RawMessage `json:"dag"`
				} `json:"activitySnapshot"`
			} `json:"chats"`
		} `json:"workspaces"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		t.Fatalf("parse state file: %v", err)
	}
	for _, ws := range parsed.Workspaces {
		if ws.ID != "ws-snap" {
			continue
		}
		for _, chat := range ws.Chats {
			if chat.ID == "chat-snap" && chat.ActivitySnapshot != nil {
				return chat.ActivitySnapshot.Task, chat.ActivitySnapshot.Dag
			}
		}
	}
	return nil, nil
}
