package wsbridge

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/session"
	"github.com/lxzan/gws"
)

// slowDrainCollector reproduces a busy browser tab: its main thread consumes
// frames slower than the engine produces them, so every incoming message is
// held for a fixed delay while slow is armed. That throttles the socket read
// loop and creates real TCP backpressure against the server-side subscriber
// pump, unlike lock-holding tests which stall the pump in process.
type slowDrainCollector struct {
	collector
	slow atomic.Bool
}

func (c *slowDrainCollector) OnMessage(conn *gws.Conn, m *gws.Message) {
	if c.slow.Load() {
		time.Sleep(15 * time.Millisecond)
	}
	c.collector.OnMessage(conn, m)
}

func connectSlowDrain(t *testing.T, h *inPlaceBridgeHarness) (*gws.Conn, *slowDrainCollector) {
	t.Helper()
	frames := &slowDrainCollector{}
	frames.notify = make(chan struct{}, 64)
	frames.slow.Store(true)
	conn, _, err := gws.NewClient(frames, &gws.ClientOption{Addr: "ws" + strings.TrimPrefix(h.server.URL, "http")})
	if err != nil {
		t.Fatal(err)
	}
	go conn.ReadLoop()
	frames.next(t, "hello")
	writeClient(t, conn, map[string]any{"type": "hello", "version": 2})
	return conn, frames
}

func (c *slowDrainCollector) transportClosed() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.streamClosed
}

func (c *slowDrainCollector) snapshot() []json.RawMessage {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]json.RawMessage(nil), c.frames...)
}

// A live turn streams message deltas far faster than a busy browser tab can
// drain them. Deltas are transient previews superseded by the terminal
// message frame at message_end, so a slow consumer must never tear the
// transport down with subscriber_queue_overflow reconnect churn: the session
// stays live, the terminal message and run.done arrive once the consumer
// catches up, and no subscriber_overflow error frame is ever sent.
func TestDeltaFloodWithSlowDrainingClientKeepsTransportAlive(t *testing.T) {
	h := newInPlaceBridgeHarnessWithHistory(t, "slow-drain-flood", 10)
	conn, frames := connectSlowDrain(t, h)
	defer func() { _ = conn.WriteClose(1000, nil) }()
	attachAndAwaitHistory(t, conn, &frames.collector, "slow-drain-flood")

	sess, ok := h.manager.Get("slow-drain-flood")
	if !ok || sess == nil {
		t.Fatal("session was not published")
	}
	observer := &overflowNoticeObserver{frames: make(chan session.Frame, 4096)}
	detach := sess.Attach(observer)
	defer detach()

	h.daemon.EmitSession(h.path, map[string]any{"type": "agent_start"})
	awaitSlowDrainObserver(t, observer)

	const flood = 40000
	for i := 0; i < flood; i++ {
		h.daemon.EmitSession(h.path, map[string]any{
			"type":      "message_update",
			"messageId": "m-1",
			"message":   map[string]any{"role": "assistant"},
			"assistantMessageEvent": map[string]any{
				"type": "text_delta", "contentIndex": 0,
				"delta":   fmt.Sprintf(" %d", i),
				"partial": map[string]any{"type": "text", "text": fmt.Sprintf("chunk-%d", i)},
			},
		})
		awaitSlowDrainObserver(t, observer)
	}

	h.daemon.EmitSession(h.path, map[string]any{
		"type":    "message_end",
		"message": map[string]any{"role": "assistant", "content": []any{map[string]any{"type": "text", "text": "final answer"}}},
	})
	awaitSlowDrainObserver(t, observer)
	h.daemon.EmitSession(h.path, map[string]any{"type": "agent_settled", "reason": "end_turn"})
	awaitSlowDrainObserver(t, observer)

	frames.slow.Store(false)

	sawFinal, sawDone := false, false
	scanned := 0
	scan := func() {
		all := frames.snapshot()
		for ; scanned < len(all); scanned++ {
			raw := all[scanned]
			if bytes.Contains(raw, []byte(`"final answer"`)) && bytes.Contains(raw, []byte(`"message"`)) {
				sawFinal = true
			}
			if bytes.Contains(raw, []byte(`"run.done"`)) {
				sawDone = true
			}
			if bytes.Contains(raw, []byte(`"subscriber_overflow"`)) {
				t.Fatalf("subscriber_overflow error frame observed: %s", raw)
			}
		}
	}
	deadline := time.Now().Add(45 * time.Second)
	for !(sawFinal && sawDone) {
		if frames.transportClosed() {
			t.Fatal("transport was torn down during a delta flood (subscriber overflow storm)")
		}
		scan()
		if sawFinal && sawDone {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("terminal frames never arrived: final=%v done=%v closed=%v undrained=%d",
				sawFinal, sawDone, frames.transportClosed(), len(frames.snapshot())-scanned)
		}
		time.Sleep(25 * time.Millisecond)
	}

	h.daemon.EmitSession(h.path, map[string]any{"type": "agent_start"})
	awaitSlowDrainObserver(t, observer)
	sawRestart := false
	deadline = time.Now().Add(10 * time.Second)
	for !sawRestart {
		if frames.transportClosed() {
			t.Fatal("transport did not survive the flood for the next turn")
		}
		all := frames.snapshot()
		for ; scanned < len(all); scanned++ {
			if bytes.Contains(all[scanned], []byte(`"run.started"`)) {
				sawRestart = true
			}
		}
		if sawRestart {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("post-flood turn never produced run.started")
		}
		time.Sleep(25 * time.Millisecond)
	}
}

func awaitSlowDrainObserver(t *testing.T, observer *overflowNoticeObserver) {
	t.Helper()
	select {
	case <-observer.frames:
		return
	default:
	}
	select {
	case <-observer.frames:
	case <-time.After(5 * time.Second):
		t.Fatal("session did not ingest the emitted event")
	}
}
