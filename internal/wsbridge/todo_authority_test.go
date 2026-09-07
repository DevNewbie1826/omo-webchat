package wsbridge

import (
	"context"
	"encoding/json"
	"sync/atomic"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/session"

	"github.com/DevNewbie1826/omo-webchat/internal/wscontract"
)

func TestTodoAuthorityReadyAnnouncesBindingBeforeProjection(t *testing.T) {
	// Given a real bound socket and a complete branch without a todo carrier.
	h := newInPlaceBridgeHarness(t, "todo-startup")
	sock, frames := h.connect(t)
	// When the binding is published.
	writeClient(t, sock, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": "todo-startup"})
	ready := frames.next(t, "ready")
	// Then the announcement establishes the exact authority tuple.
	binding, ok := ready["bindingId"].(string)
	if !ok || binding == "" {
		t.Fatalf("ready did not announce todo binding: %v", ready)
	}
	todo := frames.next(t, "chat.todo")
	if todo["bindingId"] != binding || todo["sessionId"] != ready["sessionId"] || todo["durableSessionId"] != ready["piSessionId"] {
		t.Fatalf("todo identity = %v, ready = %v", todo, ready)
	}
	if todo["status"] != "ready" || todo["phases"] != nil || todo["source"].(map[string]any)["kind"] != "absent" {
		t.Fatalf("initial absent projection = %v", todo)
	}
	raw := mustJSON(t, todo)
	if _, err := wscontract.ParseServerFrame(raw); err != nil {
		t.Fatalf("invalid emitted frame %s: %v", raw, err)
	}
}

func TestTodoAuthorityStartsBeforeAttachControlQueriesFinish(t *testing.T) {
	h := newInPlaceBridgeHarness(t, "todo-start-order")
	release := h.daemon.BlockHandler(omorpc.CmdGetState)
	defer release()
	passes := make(chan struct{}, 4)
	ticks := make(chan time.Time)
	h.bridge.cfg.todoWatch = &todoWatchOptions{ticks: ticks, passDone: func() { passes <- struct{}{} }}
	sock, frames := h.connect(t)
	writeClient(t, sock, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": "todo-start-order"})
	awaitTodoSignal(t, passes)
	server := h.soleServerConnection(t)
	if err := server.write(wscontract.PongFrame{Type: "pong"}); err != nil {
		t.Fatal(err)
	}
	frames.next(t, "pong")
	// Then the raw socket order, not a type-filtered receive, places ready first.
	frames.mu.Lock()
	defer frames.mu.Unlock()
	announced := ""
	found := false
	for _, f := range frames.decoded {
		var wire map[string]any
		if err := json.Unmarshal(f.raw, &wire); err != nil {
			t.Fatal(err)
		}
		switch f.typ {
		case "ready":
			announced, _ = wire["bindingId"].(string)
		case "chat.todo":
			if announced == "" || wire["bindingId"] != announced {
				t.Fatalf("projection before ready: %s", f.raw)
			}
			found = true
		}
	}
	if !found {
		t.Fatal("todo watcher waited for blocked attach control query")
	}
}

func TestTodoAuthorityOldReadCannotPublishAfterReplacement(t *testing.T) {
	for _, recovery := range []string{"rebind", "query-recovery", "send-recovery"} {
		t.Run(recovery, func(t *testing.T) {
			controls := make(chan *todoReadGate, 1)
			var calls atomic.Int64
			w := newTodoTestWatch(t, "todo-replace", func(ctx context.Context, s *session.Session) (session.TodoProjection, error) {
				calls.Add(1)
				select {
				case gate := <-controls:
					close(gate.entered)
					<-ctx.Done()
					close(gate.cancelled)
					// Deliberately uncooperative read: cancellation alone is not a fence.
					<-gate.release
					return session.TodoProjection{Source: session.TodoSource{Kind: "absent"}}, nil
				default:
					return s.ReadTodoProjection(ctx)
				}
			})
			_, _, generation, previous := w.server.bindingSnapshot()
			w.server.stateMu.Lock()
			worker := w.server.todo
			oldBinding := w.server.todoBindingID
			w.server.stateMu.Unlock()
			gate := newTodoReadGate()
			t.Cleanup(func() {
				select {
				case <-gate.release:
				default:
					close(gate.release)
				}
			})
			controls <- gate
			w.hint(t, session.Frame{Kind: session.FrameRunDone})
			select {
			case w.ticks <- time.Now():
			case <-time.After(5 * time.Second):
				t.Fatal("tick blocked")
			}
			awaitTodoSignal(t, gate.entered)
			count := calls.Load()
			switch recovery {
			case "rebind":
				writeClient(t, w.sock, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": "todo-replace"})
			case "query-recovery", "send-recovery":
				w.h.daemon.EvictSessionWithEvent(w.h.path, "session_closed")
				w.h.markSessionResumable(t)
				if recovery == "query-recovery" {
					writeClient(t, w.sock, map[string]any{"type": "chat.commands", "sessionId": "todo-replace"})
				} else {
					writeClient(t, w.sock, map[string]any{"type": "chat.send", "sessionId": "todo-replace", "requestId": "todo-retry", "run": map[string]any{"kind": "prompt", "message": "once"}})
				}
			}
			ready := w.frames.next(t, "ready")
			awaitTodoSignal(t, gate.cancelled)
			if ready["bindingId"] == oldBinding || ready["bindingId"] == "" {
				t.Fatalf("replacement reused binding: %v", ready)
			}
			_, _, currentGeneration, current := w.server.bindingSnapshot()
			if recovery != "rebind" && (currentGeneration != generation || current == previous) {
				t.Fatal("fixture did not replace pointer while retaining generation")
			}
			w.server.stateMu.Lock()
			sameWorker := w.server.todo == worker
			w.server.stateMu.Unlock()
			if !sameWorker || calls.Load() != count {
				t.Fatal("replacement started a concurrent worker/read")
			}
			close(gate.release)
			awaitTodoSignal(t, w.passes) // old read exits
			awaitTodoSignal(t, w.passes) // new binding's initial acquisition
			projection := w.frames.next(t, "chat.todo")
			if projection["bindingId"] != ready["bindingId"] || projection["status"] != "ready" {
				t.Fatalf("old read published after replacement ready: %v", projection)
			}
			w.assertNoTodo(t)
		})
	}
}

func TestTodoAuthorityHydrationRetryRenewsBindingEvenWithSamePointer(t *testing.T) {
	c := &connection{}
	s := newSubscriber(c)
	c.chatID, c.sess, c.sub = "retry", &session.Session{}, s
	s.readyOnce.Do(func() { close(s.ready) })
	if !s.activate(t.Context(), false) {
		t.Fatal("initial activation failed")
	}
	old := s.claim
	s.DiscardHydrationAttempt()
	if !s.activate(t.Context(), true) {
		t.Fatal("retry activation failed")
	}
	if s.claim.session != old.session || s.claim.generation != old.generation || s.claim.bindingID == old.bindingID {
		t.Fatalf("retry did not renew same-pointer claim: old=%+v new=%+v", old, s.claim)
	}
	// With no socket installed, any attempted stale delivery would fail/panic.
	if err := c.writeIfCurrent(old, wscontract.PongFrame{Type: "pong"}); err != nil {
		t.Fatalf("stale retry claim wrote: %v", err)
	}
}
