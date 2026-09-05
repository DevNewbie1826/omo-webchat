package wsbridge

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math/rand"
	"net"
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
)

const historyE2ETestBudget = 30 * time.Second

type cappedReadConn struct {
	net.Conn
	maxRead int
}

func (c cappedReadConn) Read(p []byte) (int, error) {
	if len(p) > c.maxRead {
		p = p[:c.maxRead]
	}
	return c.Conn.Read(p)
}

type cappedDialer struct{ maxRead int }

func (d cappedDialer) Dial(network, address string) (net.Conn, error) {
	conn, err := net.Dial(network, address)
	if err != nil {
		return nil, err
	}
	return cappedReadConn{Conn: conn, maxRead: d.maxRead}, nil
}

// historyCursorStore keeps these history-only fixtures on their registered
// daemon paths. Production CursorStore migration is covered by adoption tests.
type historyCursorStore struct{ *CursorStore }

func (s *historyCursorStore) CursorForOpen(ctx context.Context, id string) (session.Cursor, error) {
	return s.CursorFor(ctx, id)
}

type historyBridgeHarness struct {
	daemon    *omorpctest.Daemon
	client    *omorpc.Client
	store     *cursorstore.Store
	manager   *session.Manager
	handler   *Handler
	server    *httptest.Server
	workspace cursorstore.Workspace
}

func newHistoryBridgeHarness(t *testing.T, historyTimeout time.Duration) *historyBridgeHarness {
	t.Helper()
	dir, err := os.MkdirTemp("", "wsbridge-history-")
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
	store, err := cursorstore.Open(filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	workspace := cursorstore.Workspace{ID: "history-workspace", Name: "history", Path: dir}
	if err := store.SaveWorkspace(workspace); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveChat(cursorstore.Chat{
		ID: "history-sibling", WorkspaceID: workspace.ID, CWD: dir,
		Name: "sibling", NameSource: cursorstore.NameSourceAuto,
	}); err != nil {
		t.Fatal(err)
	}
	mgr := session.NewManager(session.Config{Client: client, Store: &historyCursorStore{CursorStore: (*CursorStore)(store)}})
	t.Cleanup(func() { _ = mgr.CloseAll(context.Background()) })
	h := New(Config{
		Manager: mgr, Store: store, ServerVersion: client.ServerVersion(),
		Logger:       slog.New(slog.NewTextHandler(io.Discard, nil)),
		WriteTimeout: historyE2ETestBudget / 6, HistoryTimeout: historyTimeout,
	})
	ts := httptest.NewServer(h)
	t.Cleanup(ts.Close)
	return &historyBridgeHarness{daemon: d, client: client, store: store, manager: mgr, handler: h, server: ts, workspace: workspace}
}

func (h *historyBridgeHarness) connect(t *testing.T, maxRead int) (*gws.Conn, *collector) {
	t.Helper()
	frames := &collector{notify: make(chan struct{}, 256), timeout: historyE2ETestBudget}
	option := &gws.ClientOption{Addr: "ws" + strings.TrimPrefix(h.server.URL, "http")}
	if maxRead > 0 {
		option.NewDialer = func() (gws.Dialer, error) { return cappedDialer{maxRead: maxRead}, nil }
	}
	conn, _, err := gws.NewClient(frames, option)
	if err != nil {
		t.Fatal(err)
	}
	go conn.ReadLoop()
	t.Cleanup(func() { _ = conn.WriteClose(1000, nil) })
	frames.next(t, "hello")
	writeClient(t, conn, map[string]any{"type": "hello", "version": ContractVersion})
	return conn, frames
}

func (h *historyBridgeHarness) saveChat(t *testing.T, id, path string) {
	t.Helper()
	if err := h.store.SaveChat(cursorstore.Chat{
		ID: id, WorkspaceID: h.workspace.ID, CWD: h.workspace.Path, SessionFile: path,
		Name: id, NameSource: cursorstore.NameSourceAuto,
	}); err != nil {
		t.Fatal(err)
	}
}

func openSibling(t *testing.T, h *historyBridgeHarness) (*gws.Conn, *collector) {
	t.Helper()
	conn, frames := h.connect(t, 0)
	writeClient(t, conn, map[string]any{
		"type": "chat.create", "wsId": h.workspace.ID, "chatId": "history-sibling",
	})
	frames.next(t, "ready")
	return conn, frames
}

func assertSiblingRoutable(t *testing.T, conn *gws.Conn, frames *collector, timeout time.Duration) {
	t.Helper()
	writeClient(t, conn, map[string]any{"type": "chat.stats", "sessionId": "history-sibling"})
	frames.nextWithin(t, "stats", timeout)
}

func seedLargeHybridHistory(t *testing.T, h *historyBridgeHarness) (path, diskLeaf string, expected map[string]struct{}) {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), historyE2ETestBudget)
	defer cancel()
	response, err := h.client.Call(ctx, omorpc.OpenSession{CWD: h.workspace.Path})
	if err != nil {
		t.Fatal(err)
	}
	var opened omorpc.OpenSessionData
	if err := json.Unmarshal(response.Data, &opened); err != nil {
		t.Fatal(err)
	}

	const diskPayloadEntries = 80
	script := make([]map[string]any, 0, diskPayloadEntries)
	random := make([]byte, 128<<10)
	source := rand.New(rand.NewSource(1))
	for i := 0; i < diskPayloadEntries; i++ {
		if _, err := source.Read(random); err != nil {
			t.Fatal(err)
		}
		script = append(script, map[string]any{
			"type": "message_end",
			"message": map[string]any{"role": "assistant", "content": []any{map[string]any{
				"type": "text", "text": base64.StdEncoding.EncodeToString(random),
			}}},
		})
	}
	h.daemon.SetPromptScript(opened.State.SessionFile, script...)
	if _, err := h.client.Call(ctx, omorpc.Prompt{SessionID: opened.SessionID, Message: "disk-root"}); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(opened.State.SessionFile)
	if err != nil {
		t.Fatal(err)
	}
	if info.Size() < 10<<20 {
		t.Fatalf("disk history size = %d, want at least 10 MiB", info.Size())
	}
	diskEnd := info.Size()
	diskLeaf = fmt.Sprintf("entry-%d", diskPayloadEntries+1)

	h.daemon.SetPromptScript(opened.State.SessionFile, map[string]any{
		"type": "message_end", "message": map[string]any{"role": "assistant", "content": "daemon-only-tail"},
	})
	if _, err := h.client.Call(ctx, omorpc.Prompt{SessionID: opened.SessionID, Message: "daemon-tail-root"}); err != nil {
		t.Fatal(err)
	}
	if err := os.Truncate(opened.State.SessionFile, diskEnd); err != nil {
		t.Fatal(err)
	}

	expected = make(map[string]struct{}, diskPayloadEntries+3)
	for i := 1; i <= diskPayloadEntries+3; i++ {
		expected[fmt.Sprintf("entry-%d", i)] = struct{}{}
	}
	return opened.State.SessionFile, diskLeaf, expected
}

func entriesIDs(t *testing.T, frame map[string]any) []string {
	t.Helper()
	rawEntries, ok := frame["entries"].([]any)
	if !ok {
		t.Fatalf("entries frame payload = %#v", frame["entries"])
	}
	ids := make([]string, 0, len(rawEntries))
	for _, raw := range rawEntries {
		entry, ok := raw.(map[string]any)
		if !ok {
			t.Fatalf("entry payload = %#v", raw)
		}
		id, _ := entry["id"].(string)
		if id == "" {
			t.Fatalf("entry has no id: %#v", entry)
		}
		ids = append(ids, id)
	}
	return ids
}

func assertNoQueuedHistoryFailure(t *testing.T, frames *collector, terminal *int) {
	t.Helper()
	frames.mu.Lock()
	defer frames.mu.Unlock()
	for _, raw := range frames.frames {
		var frame map[string]any
		if json.Unmarshal(raw, &frame) != nil {
			continue
		}
		if frame["type"] == "entries" && frame["final"] == true {
			(*terminal)++
		}
		if frame["type"] == "error" {
			t.Fatalf("history replay published an error: %v", frame)
		}
	}
}

func assertNoQueuedFrameTypes(t *testing.T, frames *collector, types ...string) {
	t.Helper()
	forbidden := make(map[string]struct{}, len(types))
	for _, typ := range types {
		forbidden[typ] = struct{}{}
	}
	frames.mu.Lock()
	defer frames.mu.Unlock()
	for _, raw := range frames.frames {
		var frame map[string]any
		if json.Unmarshal(raw, &frame) != nil {
			continue
		}
		if typ, _ := frame["type"].(string); typ != "" {
			if _, found := forbidden[typ]; found {
				t.Fatalf("unexpected %s frame: %v", typ, frame)
			}
		}
	}
}

type triggeredDeadlineContext struct {
	context.Context
	done chan struct{}
	once sync.Once
}

func newTriggeredDeadlineContext() *triggeredDeadlineContext {
	return &triggeredDeadlineContext{Context: context.Background(), done: make(chan struct{})}
}

func (c *triggeredDeadlineContext) Done() <-chan struct{} { return c.done }
func (c *triggeredDeadlineContext) Err() error {
	select {
	case <-c.done:
		return context.DeadlineExceeded
	default:
		return nil
	}
}
func (c *triggeredDeadlineContext) expire() { c.once.Do(func() { close(c.done) }) }

func TestSubscribedSocketPrioritizesHistoryReplayOverActivity(t *testing.T) {
	h := newHistoryBridgeHarness(t, historyE2ETestBudget*2)
	source := newTestActivitySource()
	h.handler.cfg.ActivitySource = source
	path, _, _ := seedLargeHybridHistory(t, h)
	h.saveChat(t, "activity-history", path)

	conn, frames := h.connect(t, 0)
	writeClient(t, conn, map[string]any{"type": "sessions.subscribe", "mode": "explicit", "sessionIds": []string{"activity-history"}})
	frames.next(t, "ack")
	releaseTail := h.daemon.BlockHandlerForPath(omorpc.CmdGetEntries, path)
	defer releaseTail()
	writeClient(t, conn, map[string]any{
		"type": "chat.create", "wsId": h.workspace.ID, "chatId": "activity-history",
	})
	if !h.daemon.AwaitRequestCount(omorpc.CmdGetEntries, 1, historyE2ETestBudget) {
		t.Fatal("history replay did not reach daemon tail")
	}
	source.publish(activitySummary("activity-history"))
	releaseTail()

	timer := time.NewTimer(historyE2ETestBudget * 3)
	defer timer.Stop()
	scanned, terminals := 0, 0
	activitySeen := false
	for !activitySeen {
		// Snapshot only new immutable frames. Decoding the growing transcript
		// under the collector lock blocks the socket reader and can stall the
		// replay writer itself, especially under the race detector.
		frames.mu.Lock()
		pending := append([]json.RawMessage(nil), frames.frames[scanned:]...)
		scanned = len(frames.frames)
		frames.mu.Unlock()
		for _, raw := range pending {
			var frame struct {
				Type      string `json:"type"`
				SessionID string `json:"sessionId"`
				Final     bool   `json:"final"`
			}
			if err := json.Unmarshal(raw, &frame); err != nil {
				t.Fatal(err)
			}
			switch frame.Type {
			case "error":
				t.Fatalf("history replay published an error: %s", raw)
			case "entries":
				if frame.Final {
					terminals++
					if terminals != 1 {
						t.Fatal("history replay published multiple terminals")
					}
				}
			case "sessions.activity":
				if terminals != 1 {
					t.Fatal("activity overtook history replay terminal")
				}
				if frame.SessionID != "activity-history" {
					t.Fatalf("resumed activity frame = %s", raw)
				}
				activitySeen = true
			}
		}
		if activitySeen {
			break
		}
		select {
		case <-frames.notify:
		case <-timer.C:
			t.Fatal("timed out waiting for history terminal and activity")
		}
	}
}

func TestHistoryHybridReplayThroughWebSocketMergesDaemonTailExactlyOnce(t *testing.T) {
	h := newHistoryBridgeHarness(t, historyE2ETestBudget*2/3)
	path, diskLeaf, expected := seedLargeHybridHistory(t, h)
	h.saveChat(t, "large-history", path)
	epoch, _ := h.client.CurrentEpoch()

	siblingConn, siblingFrames := openSibling(t, h)
	releaseTail := h.daemon.BlockHandlerForPath(omorpc.CmdGetEntries, path)
	defer releaseTail()
	conn, frames := h.connect(t, 1024)
	deadline := time.Now().Add(historyE2ETestBudget)
	writeClient(t, conn, map[string]any{
		"type": "chat.create", "wsId": h.workspace.ID, "chatId": "large-history",
	})
	if !h.daemon.AwaitRequestCount(omorpc.CmdGetEntries, 1, time.Until(deadline)) {
		t.Fatal("incremental history request was not observed")
	}
	request := h.daemon.LastRequest(omorpc.CmdGetEntries)
	since, present := request["since"]
	if !present || since == nil || since == "" || since != diskLeaf {
		t.Fatalf("get_entries cursor = %#v, want present non-empty %q", request, diskLeaf)
	}
	assertSiblingRoutable(t, siblingConn, siblingFrames, time.Until(deadline))
	releaseTail()

	seen := make(map[string]int, len(expected))
	entryFrames, terminals := 0, 0
	var terminalIDs []string
	for len(seen) < len(expected) || terminals == 0 {
		frame := frames.nextWithin(t, "entries", time.Until(deadline))
		entryFrames++
		ids := entriesIDs(t, frame)
		for _, id := range ids {
			seen[id]++
		}
		if frame["final"] == true {
			terminals++
			terminalIDs = ids
		}
	}
	writeClient(t, conn, map[string]any{"type": "ping"})
	frames.nextWithin(t, "pong", time.Until(deadline))
	assertNoQueuedHistoryFailure(t, frames, &terminals)

	if len(seen) != len(expected) {
		t.Fatalf("unique history IDs = %d, want %d", len(seen), len(expected))
	}
	for id := range expected {
		if seen[id] != 1 {
			t.Fatalf("entry %s deliveries = %d, want 1", id, seen[id])
		}
	}
	if entryFrames <= 64 {
		t.Fatalf("history replay pages = %d, want more than 64", entryFrames)
	}
	if terminals != 1 {
		t.Fatalf("terminal entries frames = %d, want 1", terminals)
	}
	wantTail := []string{"entry-82", "entry-83"}
	if fmt.Sprint(terminalIDs) != fmt.Sprint(wantTail) {
		t.Fatalf("terminal daemon tail IDs = %v, want %v", terminalIDs, wantTail)
	}
	assertSiblingRoutable(t, siblingConn, siblingFrames, time.Until(deadline))
	for _, chatID := range []string{"large-history", "history-sibling"} {
		sess, ok := h.manager.Get(chatID)
		if !ok || sess.Resumable() {
			t.Fatalf("session %q is not live after hydration", chatID)
		}
	}
	if !h.client.EpochCurrent(epoch) || h.daemon.CloseCount() != 0 {
		t.Fatalf("history replay changed provider epoch or closed a session: closes=%d", h.daemon.CloseCount())
	}
}

func TestHistoryHybridSecondSocketReplayAndLateControlOutcome(t *testing.T) {
	h := newHistoryBridgeHarness(t, historyE2ETestBudget*2/3)
	path, diskLeaf, expected := seedLargeHybridHistory(t, h)
	h.saveChat(t, "combined-history", path)
	epoch, _ := h.client.CurrentEpoch()
	deadline := time.Now().Add(historyE2ETestBudget)

	firstConn, firstFrames := h.connect(t, 0)
	writeClient(t, firstConn, map[string]any{
		"type": "chat.create", "wsId": h.workspace.ID, "chatId": "combined-history",
	})
	firstFrames.nextWithin(t, "ready", time.Until(deadline))
	for {
		frame := firstFrames.nextWithin(t, "entries", time.Until(deadline))
		if frame["final"] == true {
			break
		}
	}
	assertNoQueuedFrameTypes(t, firstFrames, "entries", "error")

	releaseTail := h.daemon.BlockHandlerForPath(omorpc.CmdGetEntries, path)
	defer releaseTail()
	secondConn, secondFrames := h.connect(t, 1024)
	writeClient(t, secondConn, map[string]any{
		"type": "chat.create", "wsId": h.workspace.ID, "chatId": "combined-history",
	})
	if !h.daemon.AwaitRequestCount(omorpc.CmdGetEntries, 2, time.Until(deadline)) {
		t.Fatal("reattach tail request was not observed")
	}
	if request := h.daemon.LastRequest(omorpc.CmdGetEntries); request["since"] != diskLeaf {
		t.Fatalf("reattach cursor = %#v, want %q", request["since"], diskLeaf)
	}

	sess, ok := h.manager.Get("combined-history")
	if !ok || sess.Resumable() {
		t.Fatal("reattached session is not live")
	}
	releaseControl := h.daemon.BlockHandler(omorpc.CmdSetModel)
	defer releaseControl()
	h.daemon.FailNext(omorpc.CmdSetModel, omorpc.ErrCodeUnknownSession)
	controlContext := newTriggeredDeadlineContext()
	controlReturned := make(chan error, 1)
	go func() {
		controlReturned <- sess.SetModel(controlContext, "anthropic", "late-model", "late-control")
	}()
	if !h.daemon.AwaitRequestCount(omorpc.CmdSetModel, 1, time.Until(deadline)) {
		t.Fatal("control request was not written")
	}
	controlContext.expire()
	select {
	case err := <-controlReturned:
		if !errors.Is(err, omorpc.ErrWrittenUnanswered) || !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("control timeout = %v, want written-unanswered deadline", err)
		}
	case <-time.After(time.Until(deadline)):
		t.Fatal("written-unanswered control did not return")
	}
	assertNoQueuedFrameTypes(t, firstFrames, "control.result", "entries", "error")
	assertNoQueuedFrameTypes(t, secondFrames, "control.result", "error")

	releaseControl()
	firstResult := firstFrames.nextWithin(t, "control.result", time.Until(deadline))
	if firstResult["requestId"] != "late-control" || firstResult["success"] != false {
		t.Fatalf("first socket late control outcome = %v", firstResult)
	}
	assertNoQueuedFrameTypes(t, firstFrames, "entries", "error")
	assertNoQueuedFrameTypes(t, secondFrames, "control.result", "error")

	releaseTail()
	seen := make(map[string]int, len(expected))
	entryFrames, terminals := 0, 0
	var terminalIDs []string
	for len(seen) < len(expected) || terminals == 0 {
		frame := secondFrames.nextWithin(t, "entries", time.Until(deadline))
		entryFrames++
		ids := entriesIDs(t, frame)
		for _, id := range ids {
			seen[id]++
		}
		if frame["final"] == true {
			terminals++
			terminalIDs = ids
		}
	}
	secondResult := secondFrames.nextWithin(t, "control.result", time.Until(deadline))
	if secondResult["requestId"] != "late-control" || secondResult["success"] != false {
		t.Fatalf("second socket late control outcome = %v", secondResult)
	}
	assertNoQueuedHistoryFailure(t, secondFrames, &terminals)

	if len(seen) != len(expected) {
		t.Fatalf("unique history IDs = %d, want %d", len(seen), len(expected))
	}
	for id := range expected {
		if seen[id] != 1 {
			t.Fatalf("entry %s deliveries = %d, want 1", id, seen[id])
		}
	}
	if entryFrames <= 64 {
		t.Fatalf("reattach history pages = %d, want more than 64", entryFrames)
	}
	if terminals != 1 {
		t.Fatalf("terminal entries frames = %d, want 1", terminals)
	}
	if want := []string{"entry-82", "entry-83"}; fmt.Sprint(terminalIDs) != fmt.Sprint(want) {
		t.Fatalf("terminal daemon tail IDs = %v, want %v", terminalIDs, want)
	}

	assertNoQueuedFrameTypes(t, firstFrames, "entries", "error")
	writeClient(t, firstConn, map[string]any{"type": "ping"})
	firstFrames.nextWithin(t, "pong", time.Until(deadline))
	writeClient(t, secondConn, map[string]any{"type": "ping"})
	secondFrames.nextWithin(t, "pong", time.Until(deadline))
	if !h.client.EpochCurrent(epoch) || h.daemon.CloseCount() != 0 {
		t.Fatalf("combined regression changed provider epoch or closed the session: closes=%d", h.daemon.CloseCount())
	}
}

func writeDelayedHistory(t *testing.T, dir string) (string, string) {
	t.Helper()
	path := filepath.Join(dir, "delayed-history.jsonl")
	leaf := "disk-leaf"
	sum := sha256.Sum256([]byte(path))
	durableID := "durable-" + hex.EncodeToString(sum[:4]) + "-7d24-4b1e-resume"
	contents := `{"type":"session","version":3,"id":"` + durableID + `","cwd":"` + dir + `"}` + "\n" +
		`{"type":"message","id":"` + leaf + `","parentId":null,"message":{"role":"user","content":"hello"}}` + "\n"
	if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
		t.Fatal(err)
	}
	return path, leaf
}

func writeHeaderOnlyHistory(t *testing.T, dir string) string {
	t.Helper()
	path := filepath.Join(dir, "header-only-history.jsonl")
	sum := sha256.Sum256([]byte(path))
	durableID := "durable-" + hex.EncodeToString(sum[:4]) + "-7d24-4b1e-resume"
	contents := `{"type":"session","version":3,"id":"` + durableID + `","cwd":"` + dir + `"}` + "\n"
	if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestHistoryHybridIncompleteHistoryCodeThroughWebSocket(t *testing.T) {
	h := newHistoryBridgeHarness(t, historyE2ETestBudget/3)
	tests := []struct {
		name string
		path string
	}{
		{name: "header-only", path: writeHeaderOnlyHistory(t, h.workspace.Path)},
		{name: "unknown-cursor", path: func() string {
			path, _ := writeDelayedHistory(t, h.workspace.Path)
			return path
		}()},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h.saveChat(t, tt.name, tt.path)
			conn, frames := h.connect(t, 0)
			deadline := time.Now().Add(historyE2ETestBudget)
			writeClient(t, conn, map[string]any{
				"type": "chat.create", "wsId": h.workspace.ID, "chatId": tt.name,
			})
			errorFrame := frames.nextWithin(t, "error", time.Until(deadline))
			if errorFrame["code"] != "incomplete_history" || !strings.Contains(fmt.Sprint(errorFrame["message"]), "history load failed") {
				t.Fatalf("visible incomplete history = %v", errorFrame)
			}
			writeClient(t, conn, map[string]any{"type": "ping"})
			frames.nextWithin(t, "pong", time.Until(deadline))
			sess, ok := h.manager.Get(tt.name)
			if !ok || sess.Resumable() {
				t.Fatalf("session is not usable after incomplete history: found=%v resumable=%v", ok, ok && sess.Resumable())
			}
		})
	}
}

func TestHistoryHybridTimeoutThroughWebSocketStaysLocal(t *testing.T) {
	historyTimeout := historyE2ETestBudget / 6
	h := newHistoryBridgeHarness(t, historyTimeout)
	path, leaf := writeDelayedHistory(t, h.workspace.Path)
	h.saveChat(t, "delayed-history", path)
	epoch, _ := h.client.CurrentEpoch()

	siblingConn, siblingFrames := openSibling(t, h)
	release := h.daemon.BlockHandlerForPath(omorpc.CmdGetEntries, path)
	defer release()
	conn, frames := h.connect(t, 0)
	deadline := time.Now().Add(historyE2ETestBudget)
	writeClient(t, conn, map[string]any{
		"type": "chat.create", "wsId": h.workspace.ID, "chatId": "delayed-history",
	})
	if !h.daemon.AwaitRequestCount(omorpc.CmdGetEntries, 1, time.Until(deadline)) {
		t.Fatal("delayed get_entries request was not observed")
	}
	request := h.daemon.LastRequest(omorpc.CmdGetEntries)
	if since, present := request["since"]; !present || since == nil || since == "" || since != leaf {
		t.Fatalf("delayed get_entries cursor = %#v, want present non-empty %q", request, leaf)
	}
	assertSiblingRoutable(t, siblingConn, siblingFrames, time.Until(deadline))

	errorFrame := frames.nextWithin(t, "error", time.Until(deadline))
	if errorFrame["code"] != "provider_timeout" || !strings.Contains(fmt.Sprint(errorFrame["message"]), "history load failed") {
		t.Fatalf("visible history timeout = %v", errorFrame)
	}
	writeClient(t, conn, map[string]any{"type": "ping"})
	frames.nextWithin(t, "pong", time.Until(deadline))
	assertSiblingRoutable(t, siblingConn, siblingFrames, time.Until(deadline))
	for _, chatID := range []string{"delayed-history", "history-sibling"} {
		sess, ok := h.manager.Get(chatID)
		if !ok || sess.Resumable() {
			t.Fatalf("session %q was invalidated by local history timeout", chatID)
		}
	}
	if !h.client.EpochCurrent(epoch) || h.daemon.CloseCount() != 0 {
		t.Fatalf("local history timeout changed provider epoch or closed a session: closes=%d", h.daemon.CloseCount())
	}
}
