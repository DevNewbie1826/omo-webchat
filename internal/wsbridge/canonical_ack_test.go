package wsbridge

import (
	"sync"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc/omorpctest"
	"github.com/DevNewbie1826/omo-webchat/internal/sendqueue"
	"github.com/DevNewbie1826/omo-webchat/internal/session"
	"github.com/DevNewbie1826/omo-webchat/internal/wscontract"
)

func TestCanonicalCompletedAckMapping(t *testing.T) {
	for _, phase := range []string{"", "admitted", "completed"} {
		t.Run(phase, func(t *testing.T) {
			wire, err := mapFrame(session.Frame{Kind: session.FrameAck, Command: "chat.send", RequestID: "request", Phase: phase}, "chat", false)
			if err != nil {
				t.Fatal(err)
			}
			if phase != "completed" {
				if wire != nil {
					t.Fatalf("duplicate admission mapped: %#v", wire)
				}
				return
			}
			ack, ok := wire.(wscontract.AckFrame)
			if !ok || ack.RequestID == nil || *ack.RequestID != "request" || ack.SessionID == nil || *ack.SessionID != "chat" || ack.Phase == nil || *ack.Phase != "completed" {
				t.Fatalf("completed ACK missing identity/phase: %#v", wire)
			}
		})
	}
}

func TestCanonicalCompletedAckLiveAndReplay(t *testing.T) {
	for _, kind := range []string{"prompt", "steer", "follow_up"} {
		t.Run(kind, func(t *testing.T) {
			h := newInPlaceBridgeHarness(t, "canonical-ack")
			conn, frames := h.connect(t)
			writeClient(t, conn, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": "canonical-ack"})
			frames.next(t, "ready")
			// Ready precedes replay completion. Inject live events only after
			// create has completed and the live subscription is installed.
			awaitCommandFence(t, conn, frames)
			if kind != "prompt" {
				h.daemon.EmitSession(h.path, map[string]any{"type": omorpctest.EventAgentStart})
				frames.next(t, "run.started")
			}
			command := omorpc.CmdPrompt
			if kind == "steer" {
				command = omorpc.CmdSteer
			}
			if kind == "follow_up" {
				command = omorpc.CmdFollowUp
			}
			unblock := h.daemon.BlockHandler(command)
			var once sync.Once
			release := func() { once.Do(unblock) }
			t.Cleanup(release)
			writeClient(t, conn, map[string]any{"type": "chat.send", "sessionId": "canonical-ack", "requestId": "canonical-request", "run": map[string]any{"kind": kind, "message": "fixture-only"}})
			nextSuccessfulSendAcks(t, frames, "canonical-request")
			if !h.daemon.AwaitRequestCount(command, 1, 5*time.Second) {
				t.Fatal("RPC not received")
			}
			release()
			completed := frames.next(t, "ack")
			if completed["phase"] != "completed" || completed["requestId"] != "canonical-request" {
				t.Fatalf("not terminal success: %v", completed)
			}
			reconnected, replay := h.connect(t)
			writeClient(t, reconnected, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": "canonical-ack"})
			replay.next(t, "ready")
			completed = replay.next(t, "ack")
			if completed["phase"] != "completed" || completed["requestId"] != "canonical-request" || completed["sessionId"] != "canonical-ack" {
				t.Fatalf("not retained terminal success: %v", completed)
			}
			if got := h.daemon.RequestCount(command); got != 1 {
				t.Fatalf("RPC count = %d", got)
			}
		})
	}
}

// Queue dispatch rejection is not a retained terminal send outcome: the same
// durable request may complete after a fresh bridge/session owner attaches.
func TestCanonicalQueuedFailureRestoresSameRequestForRestartCompletion(t *testing.T) {
	h := newInPlaceBridgeHarness(t, "canonical-queue-retry")
	path := t.TempDir() + "/queue.json"
	queue, err := sendqueue.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	h.bridge.cfg.SendQueue = queue
	itemID, _, err := queue.Append("canonical-queue-retry", sendqueue.Item{Text: "queued original", RequestID: "same-request"})
	if err != nil {
		t.Fatal(err)
	}
	h.daemon.FailNext(omorpc.CmdPrompt, omorpc.ErrCodeTooManySessions)
	conn, frames := h.connect(t)
	writeClient(t, conn, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": "canonical-queue-retry"})
	frames.next(t, "ready")
	failure := frames.nextMatching(t, "error", 5*time.Second, func(frame map[string]any) bool { return frame["requestId"] == "same-request" })
	if failure["command"] != "chat.send" {
		t.Fatalf("dispatch failure = %v", failure)
	}
	frames.nextMatching(t, "queue", 5*time.Second, func(frame map[string]any) bool { return frame["revision"] == float64(4) })
	restored := queue.Snapshot("canonical-queue-retry")
	if restored.Dispatching != nil || len(restored.Items) != 1 || restored.Items[0].ID != itemID || restored.Items[0].RequestID != "same-request" {
		t.Fatalf("restored dispatch = %+v", restored)
	}
	queue, err = sendqueue.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	restarted := restartInPlaceBridge(t, h, queue)
	restartConn, replay := restarted.connect(t)
	writeClient(t, restartConn, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": "canonical-queue-retry"})
	replay.next(t, "ready")
	completed := replay.nextMatching(t, "ack", 5*time.Second, func(frame map[string]any) bool {
		return frame["requestId"] == "same-request" && frame["phase"] == "completed"
	})
	if completed["command"] != "chat.send" {
		t.Fatalf("dispatch completion = %v", completed)
	}
	if got := h.daemon.RequestCount(omorpc.CmdPrompt); got != 2 {
		t.Fatalf("prompt attempts = %d, want rejected then successful", got)
	}
	if got := queue.Snapshot("canonical-queue-retry"); got.Dispatching != nil || len(got.Items) != 0 {
		t.Fatalf("completed queue = %+v", got)
	}
}
