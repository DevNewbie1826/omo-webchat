package wsbridge

import (
	"encoding/json"
	"reflect"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc/omorpctest"
	"github.com/DevNewbie1826/omo-webchat/internal/sendqueue"
	"github.com/DevNewbie1826/omo-webchat/internal/session"
)

func noticeFields(t *testing.T, frame map[string]any) (kind, nid, at string) {
	t.Helper()
	kind, _ = frame["kind"].(string)
	nid, _ = frame["nid"].(string)
	at, _ = frame["at"].(string)
	return kind, nid, at
}

// drainHistory consumes the attach-time durable history stream up to and
// including its terminal page.
func drainHistory(t *testing.T, frames *collector) {
	t.Helper()
	for frames.next(t, "entries")["final"] != true {
	}
}

// collectUntilHistoryTerminal gathers every wire frame up to and including
// the final entries page, bounding the attach-replay window inside which
// journaled notices must arrive.
func collectUntilHistoryTerminal(t *testing.T, frames *collector) []map[string]any {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	start := 0
	var out []map[string]any
	for {
		batch, closed, generation := frames.takeDecoded(start)
		for _, frame := range batch {
			var wire map[string]any
			if err := json.Unmarshal(frame.raw, &wire); err != nil {
				t.Fatal(err)
			}
			out = append(out, wire)
			if frame.typ == "entries" && wire["final"] == true {
				return out
			}
		}
		start += len(batch)
		if closed {
			t.Fatal("socket closed before the history terminal")
		}
		if err := frames.waitAfter(generation, time.Until(deadline)); err != nil {
			t.Fatalf("timed out waiting for the history terminal after %d frames", len(out))
		}
	}
}

func windowNotices(window []map[string]any, kind string) []map[string]any {
	var notices []map[string]any
	for _, frame := range window {
		if frame["type"] == "notice" && frame["kind"] == kind {
			notices = append(notices, frame)
		}
	}
	return notices
}

// awaitStreamClosed waits until the server ends the detached client's stream.
func awaitStreamClosed(t *testing.T, frames *collector) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		_, closed, generation := frames.takeDecoded(0)
		if closed {
			return
		}
		if err := frames.waitAfter(generation, time.Until(deadline)); err != nil {
			t.Fatal("socket stream did not close after client detach")
		}
	}
}

// A client-visible notice must survive detach and re-attach: the replayed
// frame carries the identical journal identity (nid, at) and payload.
func TestNoticeReplayOnReattachPreservesIdentity(t *testing.T) {
	const chat = "notice-replay"
	h := newInPlaceBridgeHarness(t, chat)
	conn, frames := h.connect(t)
	writeClient(t, conn, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": chat})
	frames.next(t, "ready")
	drainHistory(t, frames)

	h.daemon.EmitSession(h.path, map[string]any{"type": "high_reasoning_warning", "modelId": "gpt-5.6-sol", "provider": "openai-codex", "thinkingLevel": "xhigh"})
	live := frames.next(t, "notice")
	kind, nid, at := noticeFields(t, live)
	if kind != "high_reasoning_warning" {
		t.Fatalf("live notice kind = %q", kind)
	}
	if nid == "" || at == "" {
		t.Fatalf("live notice lacks journal identity: nid=%q at=%q", nid, at)
	}

	_ = conn.WriteClose(1000, nil)
	awaitStreamClosed(t, frames)

	conn2, frames2 := h.connect(t)
	writeClient(t, conn2, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": chat})
	frames2.next(t, "ready")
	window := collectUntilHistoryTerminal(t, frames2)
	replayed := windowNotices(window, "high_reasoning_warning")
	if len(replayed) != 1 {
		t.Fatalf("replay window delivered %d notices, want exactly 1: %+v", len(replayed), replayed)
	}
	rKind, rNid, rAt := noticeFields(t, replayed[0])
	if rKind != kind || rNid != nid || rAt != at {
		t.Fatalf("replayed notice identity changed: live=(%s,%s,%s) replay=(%s,%s,%s)", kind, nid, at, rKind, rNid, rAt)
	}
	if !reflect.DeepEqual(replayed[0]["payload"], live["payload"]) {
		t.Fatalf("replayed payload changed: live=%v replay=%v", live["payload"], replayed[0]["payload"])
	}
}

// Fanout of one session notice to concurrent subscribers journals exactly one
// record: a later attach replays the notice exactly once with one identity.
func TestConcurrentSubscribersShareOneJournalRecord(t *testing.T) {
	const chat = "notice-fanout"
	h := newInPlaceBridgeHarness(t, chat)
	connA, framesA := h.connect(t)
	writeClient(t, connA, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": chat})
	framesA.next(t, "ready")
	drainHistory(t, framesA)
	connB, framesB := h.connect(t)
	writeClient(t, connB, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": chat})
	framesB.next(t, "ready")
	drainHistory(t, framesB)

	h.daemon.EmitSession(h.path, map[string]any{"type": "auto_retry_start", "attempt": 2})
	a := framesA.next(t, "notice")
	b := framesB.next(t, "notice")
	_, nidA, atA := noticeFields(t, a)
	_, nidB, atB := noticeFields(t, b)
	if nidA == "" || nidA != nidB || atA != atB {
		t.Fatalf("concurrent fanout identity diverged: A=(%q,%q) B=(%q,%q)", nidA, atA, nidB, atB)
	}

	_ = connA.WriteClose(1000, nil)
	awaitStreamClosed(t, framesA)
	_ = connB.WriteClose(1000, nil)
	awaitStreamClosed(t, framesB)

	connC, framesC := h.connect(t)
	writeClient(t, connC, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": chat})
	framesC.next(t, "ready")
	window := collectUntilHistoryTerminal(t, framesC)
	replayed := windowNotices(window, "auto_retry_start")
	if len(replayed) != 1 {
		t.Fatalf("replay after fanout delivered %d notices, want exactly 1: %+v", len(replayed), replayed)
	}
	_, rNid, rAt := noticeFields(t, replayed[0])
	if rNid != nidA || rAt != atA {
		t.Fatalf("replayed identity diverged from fanout: fanout=(%q,%q) replay=(%q,%q)", nidA, atA, rNid, rAt)
	}
}

// The per-chat journal is a ring: past the cap the oldest notices are evicted
// first and a later attach replays only the newest retained entries.
func TestNoticeJournalCapEvictionKeepsNewest(t *testing.T) {
	const chat = "notice-cap"
	const journalCap = session.NoticeJournalCapacity
	const emitted = journalCap + 5
	h := newInPlaceBridgeHarness(t, chat)
	conn, frames := h.connect(t)
	writeClient(t, conn, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": chat})
	frames.next(t, "ready")
	drainHistory(t, frames)

	var liveNids []string
	for i := 0; i < emitted; i++ {
		h.daemon.EmitSession(h.path, map[string]any{"type": "extension_notify", "seq": i + 1})
		notice := frames.next(t, "notice")
		if notice["kind"] != "extension_notify" {
			t.Fatalf("live notice kind = %v", notice["kind"])
		}
		nid, _ := notice["nid"].(string)
		liveNids = append(liveNids, nid)
	}
	if liveNids[0] == "" {
		t.Fatalf("live notices were not stamped with nid: %+v", liveNids[:3])
	}

	_ = conn.WriteClose(1000, nil)
	awaitStreamClosed(t, frames)

	conn2, frames2 := h.connect(t)
	writeClient(t, conn2, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": chat})
	frames2.next(t, "ready")
	window := collectUntilHistoryTerminal(t, frames2)
	replayed := windowNotices(window, "extension_notify")
	if len(replayed) != journalCap {
		t.Fatalf("capped replay delivered %d notices, want %d", len(replayed), journalCap)
	}
	for i, frame := range replayed {
		want := liveNids[len(liveNids)-journalCap+i]
		if got, _ := frame["nid"].(string); got != want {
			t.Fatalf("replay[%d] nid=%q, want %q (oldest evicted first)", i, got, want)
		}
	}
}

// The bridge-originated queue_delivery_uncertain notice journals with stable
// identity and replays on the next attach exactly like engine notices.
func TestQueueDeliveryUncertainNoticeIsJournaledAndReplayed(t *testing.T) {
	const chat = "notice-queue-uncertain"
	h := newInPlaceBridgeHarness(t, chat)
	queue := configureSendQueue(t, h)
	if _, _, err := queue.Append(chat, sendqueue.Item{Text: "possibly accepted", RequestID: "uncertain-request"}); err != nil {
		t.Fatal(err)
	}
	release := h.daemon.BlockHandler(omorpc.CmdPrompt)
	defer release()
	conn, frames := h.connect(t)
	writeClient(t, conn, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": chat})
	frames.next(t, "ready")
	if !h.daemon.AwaitRequestCount(omorpc.CmdPrompt, 1, 5*time.Second) {
		t.Fatal("dispatch did not reach the provider transport")
	}
	h.daemon.DropConnections()
	live := frames.next(t, "notice")
	if live["kind"] != "queue_delivery_uncertain" {
		t.Fatalf("uncertain delivery notice = %v", live)
	}
	_, nid, at := noticeFields(t, live)
	if nid == "" || at == "" {
		t.Fatalf("queue notice lacks journal identity: nid=%q at=%q", nid, at)
	}
	_ = conn.WriteClose(1000, nil)
	awaitStreamClosed(t, frames)

	// The retained reservation is re-driven on the next attach; arm a clean
	// settle script so that retry completes without publishing another notice.
	h.daemon.SetDefaultPromptScript(
		map[string]any{"type": omorpctest.EventAgentStart},
		map[string]any{"type": omorpctest.EventAgentSettled, "reason": "end_turn"},
	)
	conn2, frames2 := h.connect(t)
	writeClient(t, conn2, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": chat})
	frames2.next(t, "ready")
	window := collectUntilHistoryTerminal(t, frames2)
	replayed := windowNotices(window, "queue_delivery_uncertain")
	if len(replayed) != 1 {
		t.Fatalf("queue notice replay delivered %d notices, want exactly 1: %+v", len(replayed), replayed)
	}
	_, rNid, rAt := noticeFields(t, replayed[0])
	if rNid != nid || rAt != at {
		t.Fatalf("queue notice identity changed: live=(%q,%q) replay=(%q,%q)", nid, at, rNid, rAt)
	}
	if !reflect.DeepEqual(replayed[0]["payload"], live["payload"]) {
		t.Fatalf("queue notice payload changed: live=%v replay=%v", live["payload"], replayed[0]["payload"])
	}
}
