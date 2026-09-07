package wsbridge

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/sendqueue"
)

// Each record is small; only the retained file-order response exceeds the
// production cap. Both chats use the same real bridge/session/RPC client.
func seedQueueHistory(t *testing.T, h *historyBridgeHarness, chat string, count int, accepted string) string {
	t.Helper()
	path := filepath.Join(h.workspace.Path, chat+".jsonl")
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	enc := json.NewEncoder(f)
	if err := enc.Encode(map[string]any{"type": "session", "id": "durable-" + chat, "version": 3}); err != nil {
		t.Fatal(err)
	}
	var parent any
	for i := 0; i < count; i++ {
		id := fmt.Sprintf("entry-%d", i)
		text, role := strings.Repeat("x", 32<<10), "assistant"
		if i == 1 && accepted != "" {
			text, role = accepted, "user"
		}
		if err := enc.Encode(map[string]any{"type": "message", "id": id, "parentId": parent, "message": map[string]any{"role": role, "content": text}}); err != nil {
			t.Fatal(err)
		}
		parent = id
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	if err := h.daemon.LoadSessionFile(path); err != nil {
		t.Fatal(err)
	}
	h.saveChat(t, chat, path)
	return path
}

func awaitQueueHistoryCompletion(t *testing.T, frames *collector, revision int64) {
	t.Helper()
	deadline := time.Now().Add(historyE2ETestBudget)
	start := 0
	for {
		batch, closed, generation := frames.takeDecoded(start)
		for _, frame := range batch {
			var wire map[string]any
			if err := json.Unmarshal(frame.raw, &wire); err != nil {
				t.Fatal(err)
			}
			if frame.typ == "notice" && wire["kind"] == "queue_delivery_uncertain" {
				t.Fatalf("queue history inspection parked delivery: %s", frame.raw)
			}
			if frame.typ == "error" {
				t.Fatalf("queue history inspection error: %s", frame.raw)
			}
			if frame.typ == "queue" && wire["revision"].(float64) >= float64(revision) && len(wire["items"].([]any)) == 0 {
				return
			}
		}
		start += len(batch)
		if closed {
			t.Fatal("queue socket closed")
		}
		if err := frames.waitAfter(generation, time.Until(deadline)); err != nil {
			t.Fatal(err)
		}
	}
}

func TestQueueLargeHistoryCheckpointKeepsPeerLive(t *testing.T) {
	testQueueLargeHistory(t, false)
}

func TestQueueLargeHistoryAttemptedRecoveryDoesNotResend(t *testing.T) {
	testQueueLargeHistory(t, true)
}

func testQueueLargeHistory(t *testing.T, recovery bool) {
	t.Helper()
	h := newHistoryBridgeHarness(t, historyE2ETestBudget)
	text := "queued-history-checkpoint"
	accepted := ""
	if recovery {
		accepted = text
	}
	a := seedQueueHistory(t, h, "large-queue", 402, accepted)
	if recovery {
		// Acceptance remains retained in file order but is no longer replayed
		// on the active branch. Recovery must not equate branch replay to history.
		f, err := os.OpenFile(a, os.O_APPEND|os.O_WRONLY, 0o600)
		if err != nil {
			t.Fatal(err)
		}
		if err := json.NewEncoder(f).Encode(map[string]any{"type": "message", "id": "new-branch", "parentId": "entry-0", "message": map[string]any{"role": "assistant", "content": "branched"}}); err != nil {
			t.Fatal(err)
		}
		if err := f.Close(); err != nil {
			t.Fatal(err)
		}
		if err := h.daemon.LoadSessionFile(a); err != nil {
			t.Fatal(err)
		}
	}
	b := seedQueueHistory(t, h, "history-sibling", 64, "")
	ai, err := os.Stat(a)
	if err != nil {
		t.Fatal(err)
	}
	bi, err := os.Stat(b)
	if err != nil {
		t.Fatal(err)
	}
	if ai.Size() <= 12<<20 || bi.Size() >= 3<<20 {
		t.Fatalf("fixture sizes A=%d B=%d", ai.Size(), bi.Size())
	}
	t.Logf("synthetic history bytes: A=%d B=%d; default RPC cap=4MiB", ai.Size(), bi.Size())
	qpath := filepath.Join(t.TempDir(), "queue.json")
	queue, err := sendqueue.Load(qpath)
	if err != nil {
		t.Fatal(err)
	}
	_, revision, err := queue.Append("large-queue", sendqueue.Item{Text: text, RequestID: "large-queue-request"})
	if err != nil {
		t.Fatal(err)
	}
	if recovery {
		item, ok, err := queue.BeginDispatch("large-queue")
		if err != nil || !ok {
			t.Fatalf("reserve: %v %v", ok, err)
		}
		if _, err := queue.MarkDispatchAttempted("large-queue", item.DeliveryID, "entry-0"); err != nil {
			t.Fatal(err)
		}
		queue, err = sendqueue.Load(qpath)
		if err != nil {
			t.Fatal(err)
		}
	}
	h.handler.cfg.SendQueue = queue
	peer, peerFrames := openSibling(t, h)
	epoch, _ := h.client.CurrentEpoch()
	conn, frames := h.connect(t, 0)
	writeClient(t, conn, map[string]any{"type": "chat.create", "wsId": h.workspace.ID, "chatId": "large-queue"})
	// Observe the actual queue completion publication, not request arrival.
	awaitQueueHistoryCompletion(t, frames, revision+3)
	want := 1
	if recovery {
		want = 0
	}
	if got := h.daemon.RequestCount(omorpc.CmdPrompt); got != want {
		t.Fatalf("queued prompt requests=%d want=%d", got, want)
	}
	reloaded, err := sendqueue.Load(qpath)
	if err != nil {
		t.Fatal(err)
	}
	if got := reloaded.Snapshot("large-queue"); got.Dispatching != nil || len(got.Items) != 0 {
		t.Fatalf("queue not durably completed: %+v", got)
	}
	if count := h.daemon.RequestCountForPath(omorpc.CmdGetEntries, a); count < 2 {
		t.Fatalf("queue did not validate independently of hydration: get_entries=%d", count)
	}
	wantCursor := "entry-401"
	if recovery {
		wantCursor = "new-branch"
	}
	if request := lastEntriesForPath(t, h.daemon, a); request["since"] != wantCursor {
		t.Fatalf("queue validation did not use file-order end: %v", request)
	}
	assertSiblingRoutable(t, peer, peerFrames, historyE2ETestBudget)
	if !h.client.EpochCurrent(epoch) {
		t.Fatal("peer usability required reconnecting the shared transport")
	}
	t.Logf("verified: queued prompts=%d; queue durably empty; since=%s; peer stats usable", want, wantCursor)
}

func TestQueueHistoryOversizedFreshTailStaysDurableAndPeerLive(t *testing.T) {
	for _, recovery := range []bool{false, true} {
		t.Run(fmt.Sprintf("recovery=%v", recovery), func(t *testing.T) {
			h := newHistoryBridgeHarness(t, historyE2ETestBudget)
			path := seedQueueHistory(t, h, "growing-queue", 3, "")
			seedQueueHistory(t, h, "history-sibling", 64, "")
			qpath := filepath.Join(t.TempDir(), "queue.json")
			queue, err := sendqueue.Load(qpath)
			if err != nil {
				t.Fatal(err)
			}
			h.handler.cfg.SendQueue = queue
			peer, peerFrames := openSibling(t, h)
			epoch, _ := h.client.CurrentEpoch()
			conn, frames := h.connect(t, 0)
			writeClient(t, conn, map[string]any{"type": "chat.create", "wsId": h.workspace.ID, "chatId": "growing-queue"})
			frames.next(t, "ready")
			deadline := time.Now().Add(historyE2ETestBudget)
			for !frames.nextWithin(t, "entries", time.Until(deadline))["final"].(bool) {
			}
			// Join acquisition's FIFO position before adding this idle backlog.
			ctx, cancel := context.WithTimeout(t.Context(), historyE2ETestBudget)
			defer cancel()
			releaseChat, err := h.manager.EnterChat(ctx, "growing-queue")
			if err != nil {
				t.Fatal(err)
			}
			releaseChat()
			if _, _, err := queue.Append("growing-queue", sendqueue.Item{Text: "uncertain-tail", RequestID: "growing-request"}); err != nil {
				t.Fatal(err)
			}
			if recovery {
				item, ok, err := queue.BeginDispatch("growing-queue")
				if err != nil || !ok {
					t.Fatalf("reserve=%v %v", ok, err)
				}
				if _, err := queue.MarkDispatchAttempted("growing-queue", item.DeliveryID, "entry-0"); err != nil {
					t.Fatal(err)
				}
			}
			before := h.daemon.RequestCountForPath(omorpc.CmdGetEntries, path)
			release := h.daemon.BlockHandlerForPath(omorpc.CmdGetEntries, path)
			defer release()
			h.handler.SessionRunSettled("growing-queue", nil)
			if !h.daemon.AwaitRequestCountForPath(omorpc.CmdGetEntries, path, before+1, historyE2ETestBudget) {
				t.Fatal("no queue validation request")
			}
			if req := lastEntriesForPath(t, h.daemon, path); req["since"] != "entry-2" {
				t.Fatalf("queue queried stale/root cursor: %v", req)
			}
			for i := 0; i < 160; i++ {
				if !h.daemon.AppendHistory(path, "assistant", strings.Repeat("y", 32<<10)) {
					t.Fatal("append to synthetic route failed")
				}
			}
			release()
			if notice := frames.next(t, "notice"); notice["kind"] != "queue_delivery_uncertain" {
				t.Fatalf("oversized tail notice=%v", notice)
			}
			reloaded, err := sendqueue.Load(qpath)
			if err != nil {
				t.Fatal(err)
			}
			got := reloaded.Snapshot("growing-queue")
			want := sendqueue.DispatchReserved
			if recovery {
				want = sendqueue.DispatchAttempted
			}
			if got.Dispatching == nil || got.Dispatching.DispatchState != want {
				t.Fatalf("oversized tail lost durable queue boundary: %+v", got)
			}
			if h.daemon.RequestCount(omorpc.CmdPrompt) != 0 {
				t.Fatal("oversized tail sent/resubmitted uncertain item")
			}
			assertSiblingRoutable(t, peer, peerFrames, historyE2ETestBudget)
			if !h.client.EpochCurrent(epoch) {
				t.Fatal("oversized fresh tail disconnected the shared transport")
			}
		})
	}
}
