package wsbridge

import (
	"encoding/json"
	"reflect"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/session"
)

type overflowNoticeObserver struct {
	frames chan session.Frame
}

func (s *overflowNoticeObserver) Deliver(f session.Frame) { s.frames <- f }
func (s *overflowNoticeObserver) Cancel() error           { return nil }

func TestRecoveryAttachSurvivesLiveFrameOverflow(t *testing.T) {
	h := newInPlaceBridgeHarnessWithHistory(t, "recovery-overflow", 10)
	conn, frames := h.connect(t)
	defer func() { _ = conn.WriteClose(1000, nil) }()

	release := h.daemon.BlockHandler(omorpc.CmdGetEntries)
	defer release()
	writeClient(t, conn, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": "recovery-overflow", "recovery": true})
	if !h.daemon.AwaitRequestCount(omorpc.CmdGetEntries, 1, 5*time.Second) {
		t.Fatal("recovery attach never reached history validation")
	}

	sess, _ := h.manager.Get("recovery-overflow")
	if sess == nil {
		t.Fatal("session was not published")
	}
	observer := &overflowNoticeObserver{frames: make(chan session.Frame, 1024)}
	detach := sess.Attach(observer)
	defer detach()
	const count = 200
	for i := 0; i < count; i++ {
		h.daemon.EmitSession(h.path, map[string]any{"type": "extension_notify", "seq": i + 1})
		for {
			select {
			case f := <-observer.frames:
				if f.Kind == session.FrameNotice {
					goto observed
				}
			case <-time.After(5 * time.Second):
				t.Fatal("notice ingestion was not observed")
			}
		}
	observed:
	}

	release()
	if !h.daemon.AwaitRequestCount(omorpc.CmdGetEntries, 2, 15*time.Second) {
		t.Fatal("overflowed hydration did not re-enter attach")
	}
	frames.nextWithin(t, "ready", 15*time.Second)
	frames.nextMatching(t, "entries", 15*time.Second, func(frame map[string]any) bool {
		return frame["final"] == true
	})

	h.daemon.EmitSession(h.path, map[string]any{"type": "agent_start"})
	frames.nextWithin(t, "run.started", 5*time.Second)

	frames.mu.Lock()
	rawFrames := append([]json.RawMessage(nil), frames.frames...)
	frames.mu.Unlock()
	seen := make(map[float64]bool, count)
	for _, raw := range rawFrames {
		var frame map[string]any
		if err := json.Unmarshal(raw, &frame); err != nil {
			t.Fatal(err)
		}
		if frame["type"] != "notice" {
			continue
		}
		payload, ok := frame["payload"].(map[string]any)
		if !ok {
			continue
		}
		if seq, ok := payload["seq"].(float64); ok {
			seen[seq] = true
		}
	}
	if len(seen) != count {
		t.Fatalf("successful recovery delivered %d/%d numbered notices", len(seen), count)
	}
}

func TestLiveSubscriberOverflowReattachesAndContinuesDelivery(t *testing.T) {
	h := newInPlaceBridgeHarnessWithHistory(t, "live-overflow", 10)
	conn, frames := h.connect(t)
	defer func() { _ = conn.WriteClose(1000, nil) }()
	attachAndAwaitHistory(t, conn, frames, "live-overflow")

	server := h.soleServerConnection(t)
	server.stateMu.Lock()
	overflowed := server.sub
	server.stateMu.Unlock()
	if err := overflowed.CancelDelivery(); err != nil {
		t.Fatal(err)
	}
	overflowed.RecoverSubscriberOverflow()

	frames.nextWithin(t, "ready", 15*time.Second)
	frames.nextMatching(t, "entries", 15*time.Second, func(frame map[string]any) bool {
		return frame["final"] == true
	})
	h.daemon.EmitSession(h.path, map[string]any{"type": "agent_start"})
	frames.nextWithin(t, "run.started", 5*time.Second)
}

func TestExhaustedActivationDetachesFinalPump(t *testing.T) {
	h := newInPlaceBridgeHarnessWithHistory(t, "recovery-exhaustion", 10)
	validationCalls := 0
	h.bridge.cfg.ChatVersion = func(string) uint64 {
		validationCalls++
		if validationCalls%2 != 0 {
			return 0
		}
		h.bridge.conns.Range(func(_, value any) bool {
			c := value.(*connection)
			for range preActivationBufferCapacity + 1 {
				c.sub.Deliver(session.Frame{Kind: session.FrameKind("unmapped")})
			}
			return true
		})
		return 0
	}
	conn, frames := h.connect(t)
	c := h.soleServerConnection(t)
	writeClient(t, conn, map[string]any{"type": "chat.create", "wsId": "ws-1", "chatId": "recovery-exhaustion"})

	got := frames.next(t, "error")
	if got["code"] != "subscriber_overflow" {
		t.Fatalf("error=%v", got)
	}
	select {
	case <-c.ctx.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("exhausted attach did not shut down")
	}
	frames.mu.Lock()
	closed := frames.closed
	frames.mu.Unlock()
	if closed != nil {
		select {
		case <-closed:
		case <-time.After(5 * time.Second):
			t.Fatal("socket did not close")
		}
	}

	sess, _ := h.manager.Get("recovery-exhaustion")
	if sess == nil {
		t.Fatal("session missing")
	}
	count := reflect.ValueOf(sess).Elem().FieldByName("broadcast").FieldByName("subs").Len()
	if count != 0 {
		t.Fatalf("closed socket retained %d subscription pump(s)", count)
	}
}
