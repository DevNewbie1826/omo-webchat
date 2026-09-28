package wsbridge

// Contract negotiation for progressive history: a version-2 client keeps the
// full root-to-leaf stream with no head pages; a version-3 client gets the
// bounded tail, the terminal live-tail page, then head pages warming the
// earlier branch newest-first with historyComplete on the last one. A
// version-4 client stops after that terminal page.

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lxzan/gws"
)

func connectHistoryVersion(t *testing.T, h *historyBridgeHarness, version, maxRead int) (*gws.Conn, *collector) {
	t.Helper()
	frames := &collector{
		notify:  make(chan struct{}, 256),
		timeout: historyE2ETestBudget,
		closed:  make(chan struct{}),
	}
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
	writeClient(t, conn, map[string]any{"type": "hello", "version": version})
	return conn, frames
}

func writeBridgeHistory(t *testing.T, entries int) (path, leafID string) {
	t.Helper()
	dir := t.TempDir()
	path = filepath.Join(dir, "progressive-session.jsonl")
	sum := sha256.Sum256([]byte(path))
	durableID := "durable-" + hex.EncodeToString(sum[:4]) + "-7d24-4b1e-resume"
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	writer := bufio.NewWriterSize(file, 64<<10)
	encoder := json.NewEncoder(writer)
	if err := encoder.Encode(map[string]any{
		"type": "session", "version": 3, "id": durableID,
		"timestamp": "2026-09-16T00:00:00.000Z", "cwd": dir,
	}); err != nil {
		t.Fatal(err)
	}
	parent := any(nil)
	for i := 0; i < entries; i++ {
		id := fmt.Sprintf("entry-%04d", i)
		if err := encoder.Encode(map[string]any{
			"type": "message", "id": id, "parentId": parent,
			"timestamp": "2026-09-16T00:00:01.000Z",
			"message": map[string]any{
				"role":    "user",
				"content": []any{map[string]any{"type": "text", "text": fmt.Sprintf("body %d", i)}},
			},
		}); err != nil {
			t.Fatal(err)
		}
		parent, leafID = id, id
	}
	if err := writer.Flush(); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	return path, leafID
}

type wireHistory struct {
	mu       sync.Mutex
	decoded  []map[string]any
	ready    bool
	terminal bool
	errors   []map[string]any
}

func (w *wireHistory) record(frame decodedFrame) {
	var decoded map[string]any
	if err := json.Unmarshal(frame.raw, &decoded); err != nil {
		return
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	switch frame.typ {
	case "ready":
		w.ready = true
	case "error":
		w.errors = append(w.errors, decoded)
	case "entries":
		w.decoded = append(w.decoded, decoded)
		if frame.final {
			if segment, _ := decoded["segment"].(string); segment == "" {
				w.terminal = true
			}
		}
	}
}

// awaitWireHistory polls decoded frames until ready plus the caller's
// completion predicate holds; head pages stream asynchronously after the
// terminal page, so a plain "await final" would miss them.
func awaitWireHistory(t *testing.T, frames *collector, complete func(*wireHistory) bool) []map[string]any {
	t.Helper()
	w := &wireHistory{}
	deadline := time.After(historyE2ETestBudget)
	scanned := 0
	for {
		batch, closed, gen := frames.takeDecoded(scanned)
		for _, frame := range batch {
			if frame.err != nil {
				t.Fatalf("malformed websocket frame: %s", frame.raw)
			}
			w.record(frame)
		}
		scanned += len(batch)
		w.mu.Lock()
		ready, done := w.ready, complete(w)
		snapshot := append([]map[string]any(nil), w.decoded...)
		errors := append([]map[string]any(nil), w.errors...)
		w.mu.Unlock()
		if len(errors) > 0 {
			t.Fatalf("history attach published an error: %v", errors[0])
		}
		if ready && done {
			return snapshot
		}
		if closed {
			t.Fatal("socket closed before history condition met")
		}
		select {
		case <-deadline:
			t.Fatalf("timed out waiting for history condition (%d entries frames, ready=%v)", len(snapshot), ready)
		default:
		}
		// An idle waitAfter window only means no new frame arrived; the
		// outer deadline bounds the whole condition.
		_ = frames.waitAfter(gen, 50*time.Millisecond)
	}
}

func attachHistorySocket(t *testing.T, h *historyBridgeHarness, chatID, path, leafID string, version int, complete func(*wireHistory) bool) []map[string]any {
	t.Helper()
	// Register the fixture transcript so the daemon answers the attach-time
	// tail probe naturally (entries after the disk leaf are empty).
	if err := h.daemon.LoadSessionFile(path); err != nil {
		t.Fatal(err)
	}
	conn, frames := connectHistoryVersion(t, h, version, 0)
	writeClient(t, conn, map[string]any{"type": "chat.create", "wsId": h.workspace.ID, "chatId": chatID})
	return awaitWireHistory(t, frames, complete)
}

func wirePageIDs(t *testing.T, frame map[string]any) []string {
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

func TestLegacyVersionTwoAttachStreamsFullHistoryWithoutHeadPages(t *testing.T) {
	h := newHistoryBridgeHarness(t, historyE2ETestBudget)
	path, leafID := writeBridgeHistory(t, 300)
	h.saveChat(t, "legacy-attach", path)

	conn, helloFrames := connectHistoryVersion(t, h, 2, 0)
	// A version-2 hello is inside the negotiated window: the socket routes
	// frames normally - a ping gets its pong - and never sees a bad_frame.
	writeClient(t, conn, map[string]any{"type": "ping"})
	helloFrames.next(t, "pong")

	frames := attachHistorySocket(t, h, "legacy-attach", path, leafID, 2, func(w *wireHistory) bool {
		return w.terminal
	})

	var stream []string
	terminals := 0
	for i, frame := range frames {
		if _, has := frame["segment"]; has {
			t.Fatalf("legacy frame %d carries segment: %v", i, frame)
		}
		if _, has := frame["historyComplete"]; has {
			t.Fatalf("legacy frame %d carries historyComplete: %v", i, frame)
		}
		if final, _ := frame["final"].(bool); final {
			terminals++
			if frame["leafId"] != leafID {
				t.Fatalf("terminal leaf = %v, want %q", frame["leafId"], leafID)
			}
			continue
		}
		stream = append(stream, wirePageIDs(t, frame)...)
	}
	if terminals != 1 {
		t.Fatalf("legacy attach produced %d terminal pages, want 1", terminals)
	}
	if len(stream) != 300 {
		t.Fatalf("legacy attach streamed %d entries, want 300", len(stream))
	}
	for i, id := range stream {
		if want := fmt.Sprintf("entry-%04d", i); id != want {
			t.Fatalf("legacy stream[%d] = %q, want %q", i, id, want)
		}
	}
}

func TestProgressiveVersionThreeAttachWarmsHeadPagesAfterTerminal(t *testing.T) {
	h := newHistoryBridgeHarness(t, historyE2ETestBudget)
	path, leafID := writeBridgeHistory(t, 300)
	h.saveChat(t, "progressive-attach", path)

	complete := func(w *wireHistory) bool {
		for _, frame := range w.decoded {
			if segment, _ := frame["segment"].(string); segment == "head" {
				if done, _ := frame["historyComplete"].(bool); done {
					return true
				}
			}
		}
		return false
	}
	frames := attachHistorySocket(t, h, "progressive-attach", path, leafID, 3, complete)

	terminalIndex := -1
	before := 0
	for i, frame := range frames {
		final, _ := frame["final"].(bool)
		segment, _ := frame["segment"].(string)
		if final && segment != "head" {
			if terminalIndex >= 0 {
				t.Fatalf("second terminal page at %d", i)
			}
			terminalIndex = i
			continue
		}
		if terminalIndex < 0 && segment == "" {
			before += len(wirePageIDs(t, frame))
		}
	}
	if terminalIndex < 0 {
		t.Fatal("progressive attach produced no terminal page")
	}
	if before != 60 {
		t.Fatalf("branch entries before terminal = %d, want 60", before)
	}
	terminal := frames[terminalIndex]
	if terminal["leafId"] != leafID {
		t.Fatalf("terminal leaf = %v, want disk leaf %q", terminal["leafId"], leafID)
	}
	if entries, _ := terminal["entries"].([]any); len(entries) != 0 {
		t.Fatalf("terminal page holds live entries %v, want empty engine tail", terminal["entries"])
	}
	if got, present := terminal["historyComplete"]; !present || got != false {
		t.Fatalf("terminal historyComplete = %v (present=%v), want explicit false while head chunks follow", got, present)
	}

	var heads []map[string]any
	for _, frame := range frames {
		if segment, _ := frame["segment"].(string); segment == "head" {
			heads = append(heads, frame)
		}
	}
	if len(heads) != 3 {
		t.Fatalf("progressive attach produced %d head pages, want 3", len(heads))
	}
	wantHeadRanges := [][2]int{{140, 240}, {40, 140}, {0, 40}}
	for i, head := range heads {
		entries, _ := head["entries"].([]any)
		if len(entries) > 100 {
			t.Fatalf("head page %d holds %d entries, want at most 100", i, len(entries))
		}
		completeFlag, present := head["historyComplete"]
		if i == len(heads)-1 {
			if !present || completeFlag != true {
				t.Fatalf("final head page must set historyComplete=true: %v", head)
			}
		} else if present {
			t.Fatalf("non-final head page %d must omit historyComplete: %v", i, head)
		}
		got := wirePageIDs(t, head)
		lo, hi := wantHeadRanges[i][0], wantHeadRanges[i][1]
		if len(got) != hi-lo {
			t.Fatalf("head page %d holds %d entries, want %d", i, len(got), hi-lo)
		}
		for j := range got {
			if want := fmt.Sprintf("entry-%04d", lo+j); got[j] != want {
				t.Fatalf("head page %d ids[%d] = %q, want %q", i, j, got[j], want)
			}
		}
	}
}

func TestHelloVersionAboveNegotiatedRangeIsRejected(t *testing.T) {
	h := newHistoryBridgeHarness(t, historyE2ETestBudget)
	conn, frames := connectHistoryVersion(t, h, 2, 0)
	writeClient(t, conn, map[string]any{"type": "hello", "version": ContractVersion + 1})
	got := frames.nextWithin(t, "error", historyE2ETestBudget)
	if code, _ := got["code"].(string); code != "bad_frame" {
		t.Fatalf("future-version hello error code = %v, want bad_frame", got["code"])
	}
}

// progressiveSecondSocketComplete awaits a full tail -> terminal -> head
// warm sequence on one socket's entries frames.
func progressiveSecondSocketComplete(w *wireHistory) bool {
	terminalSeen := false
	completed := false
	for _, frame := range w.decoded {
		segment, _ := frame["segment"].(string)
		if segment == "head" {
			if done, _ := frame["historyComplete"].(bool); done {
				completed = true
			}
		}
		if final, _ := frame["final"].(bool); final && segment == "" {
			terminalSeen = true
		}
	}
	return terminalSeen && completed
}

func TestProgressiveSecondSocketAttachKeepsSequencesIsolated(t *testing.T) {
	h := newHistoryBridgeHarness(t, historyE2ETestBudget)
	path, leafID := writeBridgeHistory(t, 300)
	h.saveChat(t, "live-progressive", path)
	if err := h.daemon.LoadSessionFile(path); err != nil {
		t.Fatal(err)
	}

	firstConn, firstFrames := connectHistoryVersion(t, h, progressiveHistoryVersion, 0)
	writeClient(t, firstConn, map[string]any{"type": "chat.create", "wsId": h.workspace.ID, "chatId": "live-progressive"})
	firstPages := awaitWireHistory(t, firstFrames, progressiveSecondSocketComplete)
	if len(firstPages) != 5 {
		t.Fatalf("first socket pages = %d, want 5 (tail, terminal, 3 head)", len(firstPages))
	}

	// Baseline the first socket's stream: everything decoded after this
	// index arrived during (and after) the second socket's own attach.
	baseline, _, _ := firstFrames.takeDecoded(0)
	baselineCount := len(baseline)

	secondConn, secondFrames := connectHistoryVersion(t, h, progressiveHistoryVersion, 0)
	writeClient(t, secondConn, map[string]any{"type": "chat.create", "wsId": h.workspace.ID, "chatId": "live-progressive"})
	secondPages := awaitWireHistory(t, secondFrames, progressiveSecondSocketComplete)

	// The second socket receives its own bounded tail, terminal, then heads;
	// no head page may precede its own terminal page.
	terminalIndex := -1
	before := 0
	for i, frame := range secondPages {
		final, _ := frame["final"].(bool)
		segment, _ := frame["segment"].(string)
		if segment == "head" {
			if terminalIndex < 0 {
				t.Fatalf("head page arrived at %d before this socket's terminal page", i)
			}
			continue
		}
		if final {
			if terminalIndex >= 0 {
				t.Fatalf("second terminal page at %d", i)
			}
			terminalIndex = i
			if frame["leafId"] != leafID {
				t.Fatalf("terminal leaf = %v, want disk leaf %q", frame["leafId"], leafID)
			}
			if got, present := frame["historyComplete"]; !present || got != false {
				t.Fatalf("terminal historyComplete = %v (present=%v), want explicit false while head chunks follow", got, present)
			}
			continue
		}
		before += len(wirePageIDs(t, frame))
	}
	if terminalIndex < 0 {
		t.Fatal("second socket produced no terminal page")
	}
	if before != 60 {
		t.Fatalf("branch entries before second socket's terminal = %d, want 60", before)
	}
	heads := 0
	for _, frame := range secondPages {
		if segment, _ := frame["segment"].(string); segment == "head" {
			heads++
		}
	}
	if heads != 3 {
		t.Fatalf("second socket head pages = %d, want 3", heads)
	}
	last := secondPages[len(secondPages)-1]
	if segment, _ := last["segment"].(string); segment != "head" {
		t.Fatalf("last frame segment = %v, want head", last["segment"])
	}
	if got, present := last["historyComplete"]; !present || got != true {
		t.Fatalf("last head historyComplete = %v (present=%v), want true", got, present)
	}

	// The first socket must not receive the second socket's pages: on this
	// idle chat nothing entries-shaped may appear after the baseline.
	leaked, closed, _ := firstFrames.takeDecoded(baselineCount)
	if closed {
		t.Fatal("first socket closed during second attach")
	}
	for _, frame := range leaked {
		if frame.err != nil {
			t.Fatalf("malformed frame on first socket: %s", frame.raw)
		}
		if frame.typ == "entries" {
			t.Fatalf("first socket received the second socket's page: %s", frame.raw)
		}
		if frame.typ == "error" {
			t.Fatalf("first socket received an error during second attach: %s", frame.raw)
		}
	}
}

// TestOnDemandVersionFourNoCursorWire mirrors the v3 no-cursor golden: the
// same 300-entry fixture, but a version-4 hello stops after the bounded tail
// and the terminal page. No segment:"head" page is part of that wire.
func TestOnDemandVersionFourNoCursorWire(t *testing.T) {
	h := newHistoryBridgeHarness(t, historyE2ETestBudget)
	path := filepath.Join(t.TempDir(), "review.jsonl")
	body := "{\"type\":\"session\",\"version\":3,\"id\":\"review-durable\",\"cwd\":\"/tmp\"}\n"
	for i := 0; i < 300; i++ {
		var parent any
		if i > 0 {
			parent = fmt.Sprintf("e-%03d", i-1)
		}
		raw, err := json.Marshal(map[string]any{"type": "message", "id": fmt.Sprintf("e-%03d", i), "parentId": parent, "message": map[string]any{"role": "user", "content": "fixture"}})
		if err != nil {
			t.Fatal(err)
		}
		body += string(raw) + "\n"
	}
	if err := os.WriteFile(path, []byte(body), 0600); err != nil {
		t.Fatal(err)
	}
	if err := h.daemon.LoadSessionFile(path); err != nil {
		t.Fatal(err)
	}
	h.saveChat(t, "review-chat", path)
	conn, frames := connectHistoryVersion(t, h, onDemandHistoryVersion, 0)
	writeClient(t, conn, map[string]any{"type": "chat.create", "wsId": h.workspace.ID, "chatId": "review-chat"})

	deadline := time.Now().Add(historyE2ETestBudget)
	scanned := 0
	var wire bytes.Buffer
	complete := false
	for !time.Now().After(deadline) {
		batch, closed, signal := frames.takeDecoded(scanned)
		scanned += len(batch)
		for _, f := range batch {
			if f.typ == "error" {
				t.Fatalf("wire error: %s", f.raw)
			}
			if f.typ != "entries" {
				continue
			}
			var data map[string]any
			if err := json.Unmarshal(f.raw, &data); err != nil {
				t.Fatal(err)
			}
			if segment, _ := data["segment"].(string); segment != "" {
				t.Fatalf("v4 entries frame carries segment %q: %s", segment, f.raw)
			}
			wire.Write(f.raw)
			wire.WriteByte('\n')
			if f.final {
				complete = true
			}
		}
		if complete {
			if closed {
				break
			}
			if err := frames.waitAfter(signal, 500*time.Millisecond); err != nil {
				break
			}
			continue
		}
		if closed {
			t.Fatal("closed")
		}
		if err := frames.waitAfter(signal, time.Until(deadline)); err != nil {
			t.Fatal(err)
		}
	}
	if !complete {
		t.Fatal("timed out waiting for the v4 terminal page")
	}

	lines := bytes.Split(bytes.TrimRight(wire.Bytes(), "\n"), []byte("\n"))
	if len(lines) != 2 {
		t.Fatalf("v4 entries frames = %d, want tail and terminal only", len(lines))
	}
	var tail, terminal map[string]any
	if err := json.Unmarshal(lines[0], &tail); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(lines[1], &terminal); err != nil {
		t.Fatal(err)
	}
	entries, _ := tail["entries"].([]any)
	if tail["final"] == true || len(entries) != 60 {
		t.Fatalf("tail page final=%v entries=%d, want non-final 60", tail["final"], len(entries))
	}
	first, _ := entries[0].(map[string]any)
	last, _ := entries[len(entries)-1].(map[string]any)
	if first["id"] != "e-240" || last["id"] != "e-299" {
		t.Fatalf("tail range %v..%v, want e-240..e-299", first["id"], last["id"])
	}
	terminalEntries, _ := terminal["entries"].([]any)
	if terminal["final"] != true || terminal["historyComplete"] != false || terminal["leafId"] != "e-299" || len(terminalEntries) != 0 || terminal["segment"] != nil {
		t.Fatalf("terminal = %s", lines[1])
	}
	if out := os.Getenv("REVIEW_WIRE_DIR"); out != "" {
		if err := os.WriteFile(filepath.Join(out, "wire-v4.jsonl"), wire.Bytes(), 0600); err != nil {
			t.Fatal(err)
		}
	}
	baseline, err := os.ReadFile(filepath.Join("testdata", "resume-wire", "wire-v4.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(baseline, wire.Bytes()) {
		t.Fatalf("v4 no-cursor wire changed: baseline=%d actual=%d bytes", len(baseline), wire.Len())
	}
}
