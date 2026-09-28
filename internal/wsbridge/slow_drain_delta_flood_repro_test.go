package wsbridge

import (
	"bytes"
	"fmt"
	"net"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/session"
	"github.com/lxzan/gws"
)

// slowDrainCollector reproduces a busy browser tab: its main thread consumes
// frames slower than the engine produces them. Each eight ingested deltas
// grant at most one read while slow is armed. This creates real TCP
// backpressure without confusing queue overflow with a wall-clock write
// timeout on a busy test machine.
type slowDrainCollector struct {
	collector
	slow    atomic.Bool
	credits chan struct{}
	resume  chan struct{}
}

func (c *slowDrainCollector) OnMessage(conn *gws.Conn, m *gws.Message) {
	if c.slow.Load() {
		select {
		case <-c.credits:
		case <-c.resume:
		}
	}
	c.collector.OnMessage(conn, m)
}

func connectSlowDrain(t *testing.T, h *inPlaceBridgeHarness) (*gws.Conn, *slowDrainCollector) {
	t.Helper()
	frames := &slowDrainCollector{credits: make(chan struct{}, 1), resume: make(chan struct{})}
	frames.notify = make(chan struct{}, 64)
	conn, _, err := gws.NewClient(frames, &gws.ClientOption{Addr: "ws" + strings.TrimPrefix(h.server.URL, "http")})
	if err != nil {
		t.Fatal(err)
	}
	go conn.ReadLoop()
	frames.next(t, "hello")
	writeClient(t, conn, map[string]any{"type": "hello", "version": 2})
	return conn, frames
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
	serverTCP, ok := h.soleServerConnection(t).socket.NetConn().(*net.TCPConn)
	if !ok {
		t.Fatal("expected a real TCP server socket")
	}
	clientTCP, ok := conn.NetConn().(*net.TCPConn)
	if !ok {
		t.Fatal("expected a real TCP client socket")
	}
	if err := serverTCP.SetWriteBuffer(4096); err != nil {
		t.Fatal(err)
	}
	if err := clientTCP.SetReadBuffer(4096); err != nil {
		t.Fatal(err)
	}

	sess, ok := h.manager.Get("slow-drain-flood")
	if !ok || sess == nil {
		t.Fatal("session was not published")
	}
	observer := &overflowNoticeObserver{frames: make(chan session.Frame, 4096)}
	detach := sess.Attach(observer)
	defer detach()
	frames.slow.Store(true)
	defer func() {
		select {
		case <-frames.resume:
		default:
			close(frames.resume)
		}
	}()

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
		if i%8 == 7 {
			select {
			case frames.credits <- struct{}{}:
			default:
			}
		}
	}

	h.daemon.EmitSession(h.path, map[string]any{
		"type":    "message_end",
		"message": map[string]any{"role": "assistant", "content": []any{map[string]any{"type": "text", "text": "final answer"}}},
	})
	awaitSlowDrainObserver(t, observer)
	h.daemon.EmitSession(h.path, map[string]any{"type": "agent_settled", "reason": "end_turn"})
	awaitSlowDrainObserver(t, observer)

	frames.slow.Store(false)
	close(frames.resume)

	sawFinal, sawDone := false, false
	deltas := 0
	scanned := 0
	deadline := time.Now().Add(45 * time.Second)
	for !(sawFinal && sawDone) {
		batch, closed, generation := frames.takeDecoded(scanned)
		scanned += len(batch)
		if closed {
			t.Fatal("transport was torn down during a delta flood (subscriber overflow storm)")
		}
		for _, frame := range batch {
			raw := frame.raw
			if frame.typ == "messageDelta" {
				deltas++
			}
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
		if sawFinal && sawDone {
			break
		}
		if err := frames.waitAfter(generation, time.Until(deadline)); err != nil {
			t.Fatalf("terminal frames never arrived: final=%v done=%v error=%v", sawFinal, sawDone, err)
		}
	}
	if deltas == 0 || deltas >= flood {
		t.Fatalf("expected real delivery and preview shedding under TCP backpressure, delivered %d/%d deltas", deltas, flood)
	}

	h.daemon.EmitSession(h.path, map[string]any{"type": "agent_start"})
	awaitSlowDrainObserver(t, observer)
	sawRestart := false
	deadline = time.Now().Add(10 * time.Second)
	for !sawRestart {
		batch, closed, generation := frames.takeDecoded(scanned)
		scanned += len(batch)
		if closed {
			t.Fatal("transport did not survive the flood for the next turn")
		}
		for _, frame := range batch {
			if bytes.Contains(frame.raw, []byte(`"run.started"`)) {
				sawRestart = true
			}
		}
		if sawRestart {
			break
		}
		if err := frames.waitAfter(generation, time.Until(deadline)); err != nil {
			t.Fatalf("post-flood turn never produced run.started: %v", err)
		}
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
