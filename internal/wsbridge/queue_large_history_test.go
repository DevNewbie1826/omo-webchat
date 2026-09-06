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

	"github.com/DevNewbie1826/omo-webchat/internal/cursorstore"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc/omorpctest"
	"github.com/DevNewbie1826/omo-webchat/internal/sendqueue"
	"github.com/DevNewbie1826/omo-webchat/internal/session"
)

func TestQueueLargeHistoryCheckpointKeepsPeerLive(t *testing.T) {
	// Given two file-backed chats on the harness's single real RPC client.
	const chatA, chatB = "queue-large-A", "queue-small-B"
	h := newInPlaceBridgeHarness(t, chatB)
	queuePath := filepath.Join(t.TempDir(), "queue-v1.json")
	queue, err := sendqueue.Load(queuePath)
	if err != nil {
		t.Fatal(err)
	}
	h.bridge.cfg.SendQueue = queue
	pathA := filepath.Join(filepath.Dir(h.path), chatA+".jsonl")
	var body strings.Builder
	fmt.Fprintf(&body, "{\"type\":\"session\",\"version\":3,\"id\":\"durable-%s\"}\n", chatA)
	parent := "null"
	leaf := ""
	for i := 0; i < 520; i++ {
		leaf = fmt.Sprintf("large-entry-%04d", i)
		fmt.Fprintf(&body, "{\"type\":\"message\",\"id\":%q,\"parentId\":%s,\"message\":{\"role\":\"assistant\",\"content\":%q}}\n", leaf, parent, strings.Repeat("x", 9000))
		parent = fmt.Sprintf("%q", leaf)
	}
	if body.Len() <= omorpc.DefaultConfig().MaxLineBytes {
		t.Fatal("fixture must exceed the unchanged inbound RPC frame cap")
	}
	if err := os.WriteFile(pathA, []byte(body.String()), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := h.daemon.LoadSessionFile(pathA); err != nil {
		t.Fatal(err)
	}
	if err := h.store.SaveChat(cursorstore.Chat{
		ID: chatA, WorkspaceID: "ws-1", CWD: filepath.Dir(pathA), Name: chatA,
		SessionFile: pathA, DurableSessionID: "durable-" + chatA,
		SessionProvenance: cursorstore.SessionProvenanceInPlace,
	}); err != nil {
		t.Fatal(err)
	}

	var sessions []*session.Session
	var collectors []*collector
	for _, id := range []string{chatA, chatB} {
		conn, frames := h.connect(t)
		writeClient(t, conn, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": id})
		frames.next(t, "ready")
		frames.next(t, "queue")
		frames.next(t, "queue") // Join the initial get_state refresh before appending.
		sess, ok := h.manager.Get(id)
		if !ok || sess.Resumable() {
			t.Fatalf("chat %s did not acquire a live session", id)
		}
		sessions = append(sessions, sess)
		collectors = append(collectors, frames)
	}

	completion := &cancelSignalSubscriber{frames: make(chan session.Frame, 64), cancelled: make(chan struct{})}
	detach := sessions[0].Attach(completion)
	t.Cleanup(detach)
	releasePrompt := h.daemon.BlockHandler(omorpc.CmdPrompt)
	joined := false
	joinCompletion := func() {
		t.Helper()
		releasePrompt()
		if joined || h.daemon.RequestCount(omorpc.CmdPrompt) == 0 {
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		for {
			select {
			case frame := <-completion.frames:
				if frame.Kind != session.FrameAck || frame.Phase != "completed" || frame.RequestID != "large-checkpoint-request" {
					continue
				}
				// Completion publishes its ack after enqueuing queue updates and idle drain.
				release, err := h.manager.EnterChat(ctx, chatA)
				if err != nil {
					t.Fatal(err)
				}
				release()
				joined = true
				return
			case <-ctx.Done():
				t.Fatal("timed out joining the checkpointed queue delivery completion")
			}
		}
	}
	t.Cleanup(joinCompletion)
	if _, _, err := queue.Append(chatA, sendqueue.Item{Text: "queued after large history", RequestID: "large-checkpoint-request"}); err != nil {
		t.Fatal(err)
	}
	reserved, ok, err := queue.BeginDispatch(chatA)
	if err != nil || !ok || reserved.DispatchState != sendqueue.DispatchReserved {
		t.Fatalf("reservation = (%+v, %v, %v)", reserved, ok, err)
	}

	// When the real settled-run entry point flushes the reserved queue head.
	// EnterChat is a FIFO barrier for that exact flush, not a timing-based wait.
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	h.bridge.SessionRunSettled(chatA, sessions[0])
	releaseChat, err := h.manager.EnterChat(ctx, chatA)
	if err != nil {
		t.Fatal(err)
	}
	releaseChat()

	// Then the checkpoint never fetches an unbounded transcript from the daemon.
	for _, request := range h.daemon.Requests() {
		if request["type"] == omorpc.CmdGetEntries && request["since"] == nil {
			t.Fatalf("large-history checkpoint issued get_entries without since; dispatch=%+v", queue.Snapshot(chatA).Dispatching)
		}
	}
	if !h.daemon.AwaitRequestCount(omorpc.CmdPrompt, 1, 5*time.Second) {
		t.Fatal("checkpoint did not reach the prompt RPC")
	}
	// The held prompt response preserves the durable attempt for inspection.
	snapshot := queue.Snapshot(chatA)
	persisted, err := sendqueue.Load(queuePath)
	if err != nil {
		t.Fatal(err)
	}
	for _, state := range []sendqueue.Snapshot{snapshot, persisted.Snapshot(chatA)} {
		item := state.Dispatching
		if item == nil || item.DeliveryID != reserved.DeliveryID || item.DispatchState != sendqueue.DispatchAttempted || item.HistoryCursor != leaf || len(state.Items) != 0 {
			t.Fatalf("checkpoint did not persist disk leaf %q before prompt: %+v", leaf, item)
		}
	}
	if got := h.daemon.RequestCount(omorpc.CmdPrompt); got != 1 {
		t.Fatalf("prompt requests = %d, want exactly 1", got)
	}
	joinCompletion()
	if snapshot := queue.Snapshot(chatA); snapshot.Dispatching != nil || len(snapshot.Items) != 0 {
		t.Fatalf("completed queue delivery still pending: %+v", snapshot)
	}

	// Exercise both existing routes and join an exact event through each websocket.
	// The terminal event also fences all prior subscriber error frames.
	for i, path := range []string{pathA, h.path} {
		if _, err := sessions[i].QueryState(ctx); err != nil {
			t.Fatalf("peer %s no longer answers on its existing route: %v", sessions[i].ChatID(), err)
		}
		h.daemon.EmitSession(path, map[string]any{"type": omorpctest.EventAgentStart})
		h.daemon.EmitSession(path, map[string]any{"type": omorpctest.EventAgentSettled, "reason": "end_turn"})
		collectors[i].next(t, "run.done")
		if sessions[i].Resumable() {
			t.Errorf("chat %s became resumable", sessions[i].ChatID())
		}
		collectors[i].mu.Lock()
		pending := append([]json.RawMessage(nil), collectors[i].frames...)
		collectors[i].mu.Unlock()
		for _, raw := range pending {
			var frame struct {
				Type string `json:"type"`
				Code string `json:"code"`
			}
			if err := json.Unmarshal(raw, &frame); err != nil {
				t.Fatal(err)
			}
			if frame.Type == "error" && frame.Code == "provider_disconnected" {
				t.Errorf("chat %s received provider_disconnected", sessions[i].ChatID())
			}
		}
		release, err := h.manager.EnterChat(ctx, sessions[i].ChatID())
		if err != nil {
			t.Fatal(err)
		}
		release()
	}
	if got := h.daemon.RequestCount(omorpc.CmdPrompt); got != 1 {
		t.Fatalf("settled notifications duplicated dispatch: %d prompt requests", got)
	}
}
