package wsbridge

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/sendqueue"
	"github.com/DevNewbie1826/omo-webchat/internal/session"
)

// Unlike the explicitly named legacy replay scenarios, this uses the default
// real-engine unknown-cursor response. No empty-success history is scripted.
func TestQueueExternalAppendUnknownCursorRequiresExplicitRecoveryWithoutResend(t *testing.T) {
	for _, attempted := range []bool{false, true} {
		t.Run(fmt.Sprintf("attempted=%v", attempted), func(t *testing.T) {
			const chat = "queue-external-write"
			h := newInPlaceBridgeHarness(t, chat)
			queue := configureSendQueue(t, h)
			conn, frames := h.connect(t)
			writeClient(t, conn, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": chat})
			frames.next(t, "ready")
			deadline := time.Now().Add(10 * time.Second)
			for frames.nextWithin(t, "entries", time.Until(deadline))["final"] != true {
			}
			ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
			defer cancel()
			releaseChat, err := h.manager.EnterChat(ctx, chat)
			if err != nil {
				t.Fatal(err)
			}
			releaseChat()
			sess, ok := h.manager.Get(chat)
			if !ok {
				t.Fatal("session disappeared")
			}
			before, err := os.Stat(h.path)
			if err != nil {
				t.Fatal(err)
			}
			file, err := os.OpenFile(h.path, os.O_APPEND|os.O_WRONLY, 0o600)
			if err != nil {
				t.Fatal(err)
			}
			// A disk-positive user match must not bypass daemon agreement.
			_, writeErr := file.WriteString("{\"type\":\"message\",\"id\":\"external-end\",\"parentId\":\"root\",\"message\":{\"role\":\"user\",\"content\":\"queued-external\"}}\n")
			closeErr := file.Close()
			if writeErr != nil || closeErr != nil {
				t.Fatalf("append: %v; close: %v", writeErr, closeErr)
			}
			after, err := os.Stat(h.path)
			if err != nil || !os.SameFile(before, after) {
				t.Fatalf("external append changed inode: %v", err)
			}
			_, revision, err := queue.Append(chat, sendqueue.Item{Text: "queued-external", RequestID: "external-request"})
			if err != nil {
				t.Fatal(err)
			}
			if attempted {
				item, ok, err := queue.BeginDispatch(chat)
				if err != nil || !ok {
					t.Fatalf("reserve=%v %v", ok, err)
				}
				if _, err := queue.MarkDispatchAttempted(chat, item.DeliveryID, "root"); err != nil {
					t.Fatal(err)
				}
			}
			beforeQueries := h.daemon.RequestCount(omorpc.CmdGetEntries)
			h.bridge.SessionRunSettled(chat, sess)
			parked := frames.next(t, "notice")
			if parked["kind"] != "queue_delivery_uncertain" {
				t.Fatalf("queue notice=%v", parked)
			}
			parkedNid, _ := parked["nid"].(string)
			if frame := frames.next(t, "error"); frame["code"] != "external-write-detected" || !strings.Contains(fmt.Sprint(frame["message"]), "Entry not found: external-end") {
				t.Fatalf("real provider error/quarantine=%v", frame)
			}
			wantState := sendqueue.DispatchReserved
			if attempted {
				wantState = sendqueue.DispatchAttempted
			}
			snapshot := queue.Snapshot(chat)
			if snapshot.Dispatching == nil || snapshot.Dispatching.DispatchState != wantState {
				t.Fatalf("uncertain dispatch lost: %+v", snapshot)
			}
			if h.daemon.RequestCount(omorpc.CmdPrompt) != 0 {
				t.Fatal("unknown disk end sent or resent queued item")
			}
			if h.daemon.RequestCount(omorpc.CmdGetEntries) != beforeQueries+1 || h.daemon.LastRequest(omorpc.CmdGetEntries)["since"] != "external-end" {
				t.Fatal("unknown disk end used a root/old-cursor fallback")
			}
			var drift *session.ExternalWriteError
			if leaf, err := sess.DurableHistoryLeaf(ctx); leaf != "" || !errors.As(err, &drift) {
				t.Fatalf("quarantined checkpoint=%q %v", leaf, err)
			}
			if found, err := sess.DurableUserMessageAfter(ctx, "root", "queued-external"); found || !errors.As(err, &drift) {
				t.Fatalf("quarantined match=%v %v", found, err)
			}

			beforeOpens, beforeCloses := h.daemon.OpenCount(), h.daemon.CloseCount()
			ordinary, ordinaryFrames := h.connect(t)
			writeClient(t, ordinary, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": chat})
			if frame := ordinaryFrames.next(t, "error"); frame["code"] != "external-write-detected" {
				t.Fatalf("ordinary acquisition cleared quarantine: %v", frame)
			}
			if h.daemon.OpenCount() != beforeOpens || h.daemon.CloseCount() != beforeCloses {
				t.Fatal("ordinary acquisition reopened quarantined route")
			}

			// Reproduce real provider disk loading on explicit reopen. Hold the
			// open only after the stale route was closed; LoadSessionFile reads
			// the actual synthetic JSONL, not a canned successful tail response.
			releaseOpen := h.daemon.BlockHandlerForPath(omorpc.CmdOpenSession, h.path)
			defer releaseOpen()
			beforeOpenRequests := h.daemon.RequestCount(omorpc.CmdOpenSession)
			recovered, recoveredFrames := h.connect(t)
			writeClient(t, recovered, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": chat, "recovery": true})
			if !h.daemon.AwaitRequestCount(omorpc.CmdOpenSession, beforeOpenRequests+1, 5*time.Second) {
				t.Fatal("explicit recovery did not reopen")
			}
			if h.daemon.CloseCount() != beforeCloses+1 {
				t.Fatal("recovery reopened before closing stale route")
			}
			if err := h.daemon.LoadSessionFile(h.path); err != nil {
				t.Fatal(err)
			}
			releaseOpen()
			recoveredFrames.next(t, "ready")
			// The journaled delivery notice replays on every attach with the
			// identity it was stamped with at park time; only a notice with a
			// NEW nid would mean the recovered inspection parked the delivery
			// again, which the completion await below still rejects.
			replayed := recoveredFrames.next(t, "notice")
			replayedNid, _ := replayed["nid"].(string)
			if replayed["kind"] != "queue_delivery_uncertain" || replayedNid == "" || replayedNid != parkedNid {
				t.Fatalf("replayed delivery notice identity changed: parked nid=%q replayed=%v", parkedNid, replayed)
			}
			awaitQueueHistoryCompletion(t, recoveredFrames, revision+3)
			wantPrompts := 1 // A reserved item has never been attempted.
			if attempted {
				wantPrompts = 0
			}
			if h.daemon.RequestCount(omorpc.CmdPrompt) != wantPrompts {
				t.Fatalf("post-recovery prompts=%d want=%d", h.daemon.RequestCount(omorpc.CmdPrompt), wantPrompts)
			}
			if got := queue.Snapshot(chat); got.Dispatching != nil || len(got.Items) != 0 {
				t.Fatalf("verified recovery did not resolve queue: %+v", got)
			}
			if h.daemon.OpenCount() != beforeOpens+1 || h.daemon.LastRequest(omorpc.CmdOpenSession)["sessionPath"] != h.path {
				t.Fatal("explicit recovery did not retain original file")
			}
		})
	}
}
