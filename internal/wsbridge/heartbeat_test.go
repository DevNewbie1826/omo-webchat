package wsbridge

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/lxzan/gws"

	"github.com/DevNewbie1826/omo-webchat/internal/cursorstore"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc/omorpctest"
	"github.com/DevNewbie1826/omo-webchat/internal/session"
)

const heartbeatTestTimeout = 5 * time.Second

// Keep the real cursor store and observe the acquisition boundary inside the
// manager's per-chat flight. A replacement reaching this boundary proves the
// canceled acquisition has released that flight, not its retained open.
type heartbeatCursorStore struct {
	*CursorStore
	opening chan string
}

func (s *heartbeatCursorStore) CursorForOpen(ctx context.Context, id string) (session.Cursor, error) {
	cursor, err := s.CursorStore.CursorForOpen(ctx, id)
	s.opening <- id
	return cursor, err
}

type heartbeatHarness struct {
	daemon  *omorpctest.Daemon
	manager *session.Manager
	bridge  *Handler
	server  *httptest.Server
	opening chan string
}

func newHeartbeatHarness(t *testing.T) *heartbeatHarness {
	t.Helper()
	// Keep the Unix socket path below the platform limit, even under -race.
	dir, err := os.MkdirTemp("", "ws-heartbeat-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	d := omorpctest.New(dir)
	if err := d.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(d.Stop)
	client, err := omorpc.Dial(t.Context(), d.SocketPath())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close() })
	store, err := cursorstore.Open(filepath.Join(dir, "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SaveWorkspace(cursorstore.Workspace{ID: "ws-1", Name: "heartbeat", Path: dir}); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "heartbeat.jsonl")
	transcript := "{\"type\":\"session\",\"id\":\"durable-heartbeat\",\"version\":3}\n" +
		"{\"type\":\"message\",\"id\":\"root\",\"parentId\":null,\"message\":{\"role\":\"user\",\"content\":\"before\"}}\n"
	if err := os.WriteFile(path, []byte(transcript), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := d.LoadSessionFile(path); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveChat(cursorstore.Chat{
		ID: "heartbeat", WorkspaceID: "ws-1", CWD: dir, Name: "heartbeat",
		SessionFile: path, DurableSessionID: "durable-heartbeat", SessionProvenance: cursorstore.SessionProvenanceNative,
	}); err != nil {
		t.Fatal(err)
	}
	opening := make(chan string, 8)
	mgr := session.NewManager(session.Config{
		Client: client, Store: &heartbeatCursorStore{CursorStore: (*CursorStore)(store), opening: opening},
		// Exercise expiration of the canceled caller's cleanup budget, while
		// the provider response remains owned until the explicit gate release.
		CloseTimeout: 100 * time.Millisecond,
	})
	t.Cleanup(func() { _ = mgr.CloseAll(context.Background()) })
	bridge := New(Config{Manager: mgr, Store: store, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
	server := httptest.NewServer(bridge)
	t.Cleanup(server.Close)
	t.Cleanup(bridge.CloseConnections)
	return &heartbeatHarness{daemon: d, manager: mgr, bridge: bridge, server: server, opening: opening}
}

func (h *heartbeatHarness) connect(t *testing.T) (*gws.Conn, *collector) {
	t.Helper()
	frames := &collector{notify: make(chan struct{}, 64)}
	socket, _, err := gws.NewClient(frames, &gws.ClientOption{Addr: "ws" + strings.TrimPrefix(h.server.URL, "http")})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = socket.NetConn().Close() })
	go socket.ReadLoop()
	frames.next(t, "hello")
	return socket, frames
}

func heartbeatWriteRaw(t *testing.T, socket *gws.Conn, raw string) {
	t.Helper()
	if err := socket.WriteMessage(gws.OpcodeText, []byte(raw)); err != nil {
		t.Fatal(err)
	}
}

// Unlike a type-filtered collector read, this catches an unexpected pong before
// a rejection instead of silently leaving it in the frame backlog.
func heartbeatNext(t *testing.T, frames *collector, typ string) map[string]any {
	t.Helper()
	timer := time.NewTimer(heartbeatTestTimeout)
	defer timer.Stop()
	for {
		frames.mu.Lock()
		if len(frames.frames) != 0 {
			raw := frames.frames[0]
			frames.frames = frames.frames[1:]
			frames.decoded = frames.decoded[1:]
			frames.mu.Unlock()
			var frame map[string]any
			if err := json.Unmarshal(raw, &frame); err != nil {
				t.Fatal(err)
			}
			if frame["type"] != typ {
				t.Fatalf("next frame = %s, want %s", raw, typ)
			}
			return frame
		}
		frames.mu.Unlock()
		select {
		case <-frames.notify:
		case <-timer.C:
			t.Fatalf("timed out waiting for %s before releasing the open barrier", typ)
		}
	}
}

// awaitCommandFence observes completion of earlier ordinary commands without
// treating transport pong as their acknowledgement. The valid, deliberately
// mismatched command cannot mutate a session; its correlated rejection passes
// through the same FIFO as create, history replay, and ordinary chat commands.
// Consume only that rejection, preserving every frame the caller asserts on.
func awaitCommandFence(t *testing.T, socket *gws.Conn, frames *collector) {
	t.Helper()
	const fence = "test-command-fence"
	writeClient(t, socket, map[string]any{
		"type": "chat.queue.remove", "sessionId": fence, "itemId": fence, "requestId": fence,
	})
	frame := frames.nextMatching(t, "error", heartbeatTestTimeout, func(f map[string]any) bool {
		return f["requestId"] == fence
	})
	if frame["code"] != "session_mismatch" {
		t.Fatalf("command fence = %v, want session_mismatch", frame)
	}
}

func TestHeartbeatHelloAndParsing(t *testing.T) {
	h := newHeartbeatHarness(t)
	socket, frames := h.connect(t)
	for _, raw := range []string{
		`{"type":"ping"}`,
		`{"type":"chat.create","wsId":"ws-1","chatId":"heartbeat"}`,
		`{"type":"hello","version":99}`,
		`{"type":"ping"}`,
		`{"type":"hello","version":null}`,
		`{"type":"ping"}`,
	} {
		heartbeatWriteRaw(t, socket, raw)
		if frame := heartbeatNext(t, frames, "error"); frame["code"] != "bad_frame" {
			t.Fatalf("frame %s: rejection = %v", raw, frame)
		}
	}
	// No acknowledgement or scheduling fence between hello and ping.
	heartbeatWriteRaw(t, socket, `{"type":"hello","version":2}`)
	heartbeatWriteRaw(t, socket, `{"type":"ping"}`)
	heartbeatNext(t, frames, "pong")
	for _, raw := range []string{
		`{"type":"ping"`, `null`, `{"type":["ping"]}`, `{"type":null}`,
		`{"type":"ping","type":["ping"]}`,
	} {
		heartbeatWriteRaw(t, socket, raw)
		if frame := heartbeatNext(t, frames, "error"); frame["code"] != "bad_frame" {
			t.Fatalf("frame %s: rejection = %v", raw, frame)
		}
	}
	// JSON escaping and whitespace are parsed, not recognized by raw prefix.
	heartbeatWriteRaw(t, socket, " {\"type\":\"p\\u0069ng\"} ")
	heartbeatNext(t, frames, "pong")
	if got := h.daemon.RequestCount(omorpc.CmdOpenSession); got != 0 {
		t.Fatalf("hello/parsing characterization opened %d provider sessions", got)
	}
}

func (h *heartbeatHarness) awaitOpening(t *testing.T) {
	t.Helper()
	select {
	case id := <-h.opening:
		if id != "heartbeat" {
			t.Fatalf("opening chat = %q", id)
		}
	case <-time.After(heartbeatTestTimeout):
		t.Fatal("chat.create did not enter acquisition inside the per-chat flight")
	}
}

func heartbeatCreate(t *testing.T, socket *gws.Conn) {
	t.Helper()
	heartbeatWriteRaw(t, socket, `{"type":"hello","version":2}`)
	heartbeatWriteRaw(t, socket, `{"type":"chat.create","wsId":"ws-1","chatId":"heartbeat"}`)
}

func TestHeartbeatDuringBlockedOpen(t *testing.T) {
	h := newHeartbeatHarness(t)
	release := h.daemon.BlockHandler(omorpc.CmdOpenSession)
	t.Cleanup(release)
	socket, frames := h.connect(t)
	heartbeatCreate(t, socket)
	h.awaitOpening(t)
	if !h.daemon.AwaitRequestCount(omorpc.CmdOpenSession, 1, heartbeatTestTimeout) {
		t.Fatal("fixture did not receive the gated open")
	}
	t.Log("open request observed; fixture barrier remains held")
	heartbeatWriteRaw(t, socket, `{"type":"ping"}`)
	heartbeatNext(t, frames, "pong")
	if got := h.daemon.OpenCount(); got != 0 {
		t.Fatalf("provider completed %d opens before release", got)
	}
	release()
	frames.next(t, "ready")
	frames.nextMatching(t, "entries", heartbeatTestTimeout, func(f map[string]any) bool { return f["final"] == true })
	// The ordinary FIFO must still put close before the following session
	// command; pong is explicitly not a command-completion fence.
	heartbeatWriteRaw(t, socket, `{"type":"chat.close","sessionId":"heartbeat"}`)
	heartbeatWriteRaw(t, socket, `{"type":"chat.commands","sessionId":"heartbeat"}`)
	if frame := frames.next(t, "error"); frame["code"] != "session_mismatch" {
		t.Fatalf("command after detach = %v", frame)
	}
	heartbeatWriteRaw(t, socket, `{"type":"ping"}`)
	frames.next(t, "pong")
}

func TestHeartbeatDuringPendingOpenWait(t *testing.T) {
	h := newHeartbeatHarness(t)
	release := h.daemon.BlockHandler(omorpc.CmdOpenSession)
	t.Cleanup(release)
	first, _ := h.connect(t)
	heartbeatCreate(t, first)
	h.awaitOpening(t)
	if !h.daemon.AwaitRequestCount(omorpc.CmdOpenSession, 1, heartbeatTestTimeout) {
		t.Fatal("fixture did not receive the first gated open")
	}
	if err := first.NetConn().Close(); err != nil {
		t.Fatal(err)
	}
	replacement, frames := h.connect(t)
	heartbeatCreate(t, replacement)
	// This second store event cannot occur until the canceled acquisition
	// gives up its per-chat flight. The original open is still gated and has
	// no response, so reacquisition must wait for its retained completion.
	h.awaitOpening(t)
	if got := h.daemon.RequestCount(omorpc.CmdOpenSession); got != 1 {
		t.Fatalf("replacement issued %d open requests before retained cleanup", got)
	}
	t.Log("replacement acquisition entered after canceled flight; original open response remains gated")
	heartbeatWriteRaw(t, replacement, `{"type":"ping"}`)
	heartbeatNext(t, frames, "pong")
	if got := h.daemon.OpenCount(); got != 0 {
		t.Fatalf("provider completed %d opens before release", got)
	}
	release()
	if !h.daemon.AwaitCloseCount(1, heartbeatTestTimeout) {
		t.Fatal("canceled open's late route was not closed")
	}
	frames.next(t, "ready")
	frames.nextMatching(t, "entries", heartbeatTestTimeout, func(f map[string]any) bool { return f["final"] == true })
	if got := h.daemon.RequestCount(omorpc.CmdOpenSession); got != 2 {
		t.Fatalf("open requests after reacquisition = %d, want 2", got)
	}
	if got := h.daemon.CloseCount(); got != 1 {
		t.Fatalf("late route close completions = %d, want 1", got)
	}
	if got := h.daemon.LiveSessions(); len(got) != 1 {
		t.Fatalf("live routes after reacquisition = %v, want one replacement", got)
	}
	if got := h.daemon.RequestCount(omorpc.CmdPrompt); got != 0 {
		t.Fatalf("heartbeat issued %d prompts", got)
	}
}
