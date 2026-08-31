package chat

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"runtime"
	"strconv"
	"sync"
	"testing"
	"time"
)

// cancellingBlockingWriter follows the channelBlockingWriter pattern and
// implements FrameWriterCanceller so cancelActive can unblock WriteJSON.
type cancellingBlockingWriter struct {
	entered chan struct{}
	release chan struct{}
	once    sync.Once
}

func (w *cancellingBlockingWriter) WriteJSON([]byte) error {
	select {
	case <-w.entered:
	default:
		close(w.entered)
	}
	<-w.release
	return io.ErrClosedPipe
}

func (w *cancellingBlockingWriter) Close() error {
	w.once.Do(func() { close(w.release) })
	return nil
}

type nonBlockingCancellableWriter struct {
	wrote   chan struct{}
	release chan struct{}
	once    sync.Once
}

func (w *nonBlockingCancellableWriter) WriteJSON([]byte) error {
	select {
	case w.wrote <- struct{}{}:
	default:
	}
	return nil
}

func (w *nonBlockingCancellableWriter) Close() error {
	w.once.Do(func() { close(w.release) })
	return nil
}

func TestBroadcasterDetachesSlowSubscriberWithoutKillingSession(t *testing.T) {
	blocked := &cancellingBlockingWriter{entered: make(chan struct{}), release: make(chan struct{})}
	t.Cleanup(func() { _ = blocked.Close() })
	healthy := newCollectWriter()

	session := newTestSession("chat-overflow-detach", nil)
	session.Attach(blocked)
	session.Attach(healthy)

	commands := make(chan []byte, 8)
	provider := fakeSharedProvider(commands)
	handle := "route-overflow-detach"
	session.shared = provider
	session.routingHandle = handle
	route := &sessionRoute{
		session:  session,
		handle:   handle,
		queue:    make(chan sessionDelivery, sessionQueueSize),
		ready:    make(chan struct{}),
		provider: provider,
	}
	provider.sessions[handle] = route
	go route.run()
	route.activate()
	t.Cleanup(route.cancel)

	total := sessionQueueSize + 2
	provider.route(sessionInfoEvent(handle, eventName(0)))
	select {
	case <-blocked.entered:
	case <-time.After(2 * time.Second):
		t.Fatal("slow subscriber never entered WriteJSON")
	}
	for i := 1; i < total; i++ {
		event := sessionInfoEvent(handle, eventName(i))
		route.queue <- sessionDelivery{event: &event}
	}

	deadline := time.After(2 * time.Second)
	var frames [][]byte
	for {
		frames = healthy.snapshot()
		if hasErrorCode(frames, "provider_overflow") || countNameFrames(frames) >= total {
			break
		}
		select {
		case <-healthy.notify:
		case <-blocked.release:
		case <-deadline:
			t.Fatalf("timed out waiting for healthy delivery or overflow; names=%d frames=%s", countNameFrames(frames), healthy.typesString())
		}
	}

	if hasErrorCode(frames, "provider_overflow") {
		t.Fatalf("slow subscriber overflow killed the session with provider_overflow; frames: %s", healthy.typesString())
	}
	if !session.ProcessAlive() {
		t.Fatal("session was torn down")
	}
	if got := countNameFrames(frames); got != total {
		t.Fatalf("healthy subscriber received %d name frames, want %d; frames: %s", got, total, healthy.typesString())
	}
	select {
	case <-blocked.release:
	default:
		t.Fatal("blocked subscriber closer was not invoked")
	}
	if got := session.frames.count(); got != 1 {
		t.Fatalf("subscriber count = %d, want 1 after detaching the slow subscriber", got)
	}
}

// TestBroadcasterLongBlockedSubscriberSurvivesDefaultDeadline proves both
// that the default five-second delivery deadline never fires for a
// client-wedged writer and that the per-write patience watchdog releases the
// wedged writer (auto-detaching it) without tearing the session down.
func TestBroadcasterLongBlockedSubscriberSurvivesDefaultDeadline(t *testing.T) {
	blocked := &cancellingBlockingWriter{entered: make(chan struct{}), release: make(chan struct{})}
	t.Cleanup(func() { _ = blocked.Close() })
	healthy := newCollectWriter()

	session := newTestSession("chat-default-delivery-deadline", nil)
	session.Attach(blocked)
	session.Attach(healthy)

	commands := make(chan []byte, 8)
	provider := fakeSharedProvider(commands)
	handle := "route-default-delivery-deadline"
	session.shared = provider
	session.routingHandle = handle
	route := &sessionRoute{
		session:  session,
		handle:   handle,
		queue:    make(chan sessionDelivery, sessionQueueSize),
		ready:    make(chan struct{}),
		provider: provider,
	}
	provider.sessions[handle] = route
	go route.run()
	route.activate()
	t.Cleanup(route.cancel)

	const initial = 40
	first := sessionInfoEvent(handle, eventName(0))
	route.queue <- sessionDelivery{event: &first}
	select {
	case <-blocked.entered:
	case <-time.After(2 * time.Second):
		t.Fatal("slow subscriber never entered WriteJSON")
	}
	for i := 1; i < initial; i++ {
		event := sessionInfoEvent(handle, eventName(i))
		route.queue <- sessionDelivery{event: &event}
	}

	total := initial
	observationDeadline := time.NewTimer(5500 * time.Millisecond)
	defer observationDeadline.Stop()
	periodic := time.NewTicker(500 * time.Millisecond)
	defer periodic.Stop()
observe:
	for {
		select {
		case <-periodic.C:
			event := sessionInfoEvent(handle, eventName(total))
			route.queue <- sessionDelivery{event: &event}
			total++
			frames := healthy.snapshot()
			if hasErrorCode(frames, "provider_timeout") || hasErrorCode(frames, "provider_overflow") {
				t.Fatalf("blocked subscriber tore down the session; frames: %s", healthy.typesString())
			}
		case <-observationDeadline.C:
			break observe
		}
	}

	deadline := time.After(2 * time.Second)
	for countNameFrames(healthy.snapshot()) < total {
		select {
		case <-healthy.notify:
		case <-deadline:
			t.Fatalf("healthy subscriber received %d name frames, want %d; frames: %s", countNameFrames(healthy.snapshot()), total, healthy.typesString())
		}
	}
	frames := healthy.snapshot()
	if hasErrorCode(frames, "provider_timeout") || hasErrorCode(frames, "provider_overflow") {
		t.Fatalf("blocked subscriber tore down the session; frames: %s", healthy.typesString())
	}
	if got := countNameFrames(frames); got != total {
		t.Fatalf("healthy subscriber received %d name frames, want %d; frames: %s", got, total, healthy.typesString())
	}
	if !session.ProcessAlive() {
		t.Fatal("session was torn down")
	}

	// The writer has been wedged since before the window opened, so the
	// default 5s write patience watchdog must have released it during the
	// observation window; the failed write then auto-detaches it.
	select {
	case <-blocked.release:
	case <-time.After(2 * time.Second):
		t.Fatal("patience watchdog never released the >5s-wedged writer")
	}
	countDeadline := time.After(2 * time.Second)
	for session.frames.count() != 1 {
		select {
		case <-time.After(10 * time.Millisecond):
		case <-countDeadline:
			t.Fatalf("subscriber count = %d, want 1 after the watchdog released the wedged writer", session.frames.count())
		}
	}
	if got := countNameFrames(healthy.snapshot()); got != total {
		t.Fatalf("healthy subscriber received %d name frames, want %d; frames: %s", got, total, healthy.typesString())
	}
}

// nilOnCancelWriter blocks inside WriteJSON until Close releases it and
// then returns nil — contract-valid for FrameWriterCanceller, which promises
// only to release the write, not to make it fail.
type nilOnCancelWriter struct {
	entered chan struct{}
	release chan struct{}
	once    sync.Once
}

func (w *nilOnCancelWriter) WriteJSON([]byte) error {
	close(w.entered)
	<-w.release
	return nil
}

func (w *nilOnCancelWriter) Close() error {
	w.once.Do(func() { close(w.release) })
	return nil
}

func TestWatchdogDetachesEvenWhenCancelledWriteReturnsNil(t *testing.T) {
	blocked := &nilOnCancelWriter{entered: make(chan struct{}), release: make(chan struct{})}
	t.Cleanup(func() { _ = blocked.Close() })
	session := newTestSession("chat-nil-cancel", nil)
	session.frames.writePatience = 20 * time.Millisecond
	session.Attach(blocked)

	session.send(NameFrame{Type: "chat.name", SessionID: session.ID(), Name: "nil-cancel", Origin: "provider"})
	select {
	case <-blocked.entered:
	case <-time.After(2 * time.Second):
		t.Fatal("writer never entered WriteJSON")
	}

	// The watchdog must detach the timed-out subscription itself: a closed
	// writer whose WriteJSON returns nil never reaches the error-detach path.
	deadline := time.After(2 * time.Second)
	for session.frames.count() != 0 {
		select {
		case <-time.After(10 * time.Millisecond):
		case <-deadline:
			t.Fatalf("subscriber count = %d, want 0: watchdog did not detach the nil-returning timed-out writer", session.frames.count())
		}
	}
	select {
	case <-blocked.release:
	default:
		t.Fatal("watchdog closed the writer without releasing the write")
	}
}

func TestBroadcasterDeliveryTimeoutDoesNotKillSession(t *testing.T) {
	blocked := &cancellingBlockingWriter{entered: make(chan struct{}), release: make(chan struct{})}
	t.Cleanup(func() { _ = blocked.Close() })
	healthy := newCollectWriter()

	session := newTestSession("chat-delivery-timeout", nil)
	session.Attach(blocked)
	session.Attach(healthy)

	commands := make(chan []byte, 8)
	provider := fakeSharedProvider(commands)
	handle := "route-delivery-timeout"
	session.shared = provider
	session.routingHandle = handle
	route := &sessionRoute{
		session:  session,
		handle:   handle,
		queue:    make(chan sessionDelivery, sessionQueueSize),
		ready:    make(chan struct{}),
		provider: provider,
	}
	// Shrink the delivery deadline far below the blocked-writer hold time.
	// With async per-subscriber delivery, dispatch no longer waits on the
	// subscriber's WriteJSON, so even this tiny deadline must never fire a
	// provider_timeout teardown (incident 2026-08-31 03:42/03:59 KST).
	route.deliveryDeadline = func() <-chan time.Time { return time.After(50 * time.Millisecond) }
	provider.sessions[handle] = route
	go route.run()
	route.activate()
	t.Cleanup(route.cancel)

	provider.route(sessionInfoEvent(handle, eventName(0)))
	select {
	case <-blocked.entered:
	case <-time.After(2 * time.Second):
		t.Fatal("slow subscriber never entered WriteJSON")
	}
	for i := 1; i < 5; i++ {
		provider.route(sessionInfoEvent(handle, eventName(i)))
	}

	deadline := time.After(2 * time.Second)
	for {
		frames := healthy.snapshot()
		if hasErrorCode(frames, "provider_timeout") || countNameFrames(frames) >= 5 {
			break
		}
		select {
		case <-healthy.notify:
		case <-deadline:
			t.Fatalf("timed out waiting for healthy delivery; frames=%s", healthy.typesString())
		}
	}
	if hasErrorCode(healthy.snapshot(), "provider_timeout") {
		t.Fatalf("blocked subscriber triggered provider_timeout teardown; frames: %s", healthy.typesString())
	}
	if !session.ProcessAlive() {
		t.Fatal("session was torn down")
	}
	if got := countNameFrames(healthy.snapshot()); got != 5 {
		t.Fatalf("healthy subscriber received %d name frames, want 5; frames: %s", got, healthy.typesString())
	}
}

func TestReleaseOrphansSkipsHealthyRemovedDrain(t *testing.T) {
	writer := &nonBlockingCancellableWriter{
		wrote:   make(chan struct{}, 1),
		release: make(chan struct{}),
	}
	session := newTestSession("chat-removed-healthy", nil)
	detach := session.Attach(writer)

	detach()
	if err := session.Close(); err != nil {
		t.Fatalf("close session: %v", err)
	}
	if got := session.frames.count(); got != 0 {
		t.Fatalf("subscriber count = %d after detach, want 0", got)
	}

	select {
	case <-writer.release:
		t.Fatal("Session.Close invoked the healthy removed writer's closer")
	case <-time.After(100 * time.Millisecond):
	}
}

func TestConcurrentDetachCloseReleasesWedgedWriter(t *testing.T) {
	// Races detach against Session.Close with the writer ALWAYS already
	// wedged inside WriteJSON, covering both orderings: when Close's
	// releaseOrphans runs first it must skip the still-attached writer, and
	// the subsequent remove must then release the wedged drain itself; when
	// detach wins first, releaseOrphans (or the remover) must release it.
	for i := 0; i < 30; i++ {
		blocked := &cancellingBlockingWriter{entered: make(chan struct{}), release: make(chan struct{})}
		session := newTestSession(fmt.Sprintf("chat-close-race-%d", i), nil)
		session.frames.writePatience = 20 * time.Millisecond
		detach := session.Attach(blocked)
		session.send(NameFrame{Type: "chat.name", SessionID: session.ID(), Name: "wedge", Origin: "provider"})
		select {
		case <-blocked.entered:
		case <-time.After(2 * time.Second):
			t.Fatalf("iteration %d: writer never entered WriteJSON", i)
		}
		go detach()
		if err := session.Close(); err != nil {
			t.Fatalf("iteration %d close: %v", i, err)
		}
		select {
		case <-blocked.release:
		case <-time.After(2 * time.Second):
			t.Fatalf("iteration %d: wedged writer never released under concurrent detach/close", i)
		}
	}
}

func TestReleaseOrphansNoLeakUnderConcurrentDetachClose(t *testing.T) {
	// Stress canary for the dequeue-to-delivering handoff: traffic floods the
	// subscription while detach and Session.Close race. Every iteration must
	// end with no parked drain goroutine left behind.
	base := runtime.NumGoroutine()
	for i := 0; i < 40; i++ {
		blocked := &cancellingBlockingWriter{entered: make(chan struct{}), release: make(chan struct{})}
		session := newTestSession(fmt.Sprintf("chat-race-%d", i), nil)
		detach := session.Attach(blocked)
		stop := make(chan struct{})
		go func() {
			n := 0
			for {
				select {
				case <-stop:
					return
				default:
				}
				session.send(NameFrame{Type: "chat.name", SessionID: session.ID(), Name: fmt.Sprintf("n%d", n), Origin: "provider"})
				n++
				runtime.Gosched()
			}
		}()
		detach()
		_ = blocked.Close()
		close(stop)
		if err := session.Close(); err != nil {
			t.Fatalf("iteration %d close: %v", i, err)
		}
	}
	deadline := time.After(2 * time.Second)
	for runtime.NumGoroutine() > base+2 {
		select {
		case <-deadline:
			t.Fatalf("drain goroutines leaked under concurrent detach/close: %d > baseline %d+2", runtime.NumGoroutine(), base)
		case <-time.After(10 * time.Millisecond):
		}
	}
}

func TestDetachReleasesWedgedSubscriberItRemoves(t *testing.T) {
	blocked := &cancellingBlockingWriter{entered: make(chan struct{}), release: make(chan struct{})}
	session := newTestSession("chat-removed-wedge", nil)
	session.frames.writePatience = 20 * time.Millisecond
	detach := session.Attach(blocked)

	session.send(NameFrame{Type: "chat.name", SessionID: session.ID(), Name: "wedge", Origin: "provider"})
	select {
	case <-blocked.entered:
	case <-time.After(2 * time.Second):
		t.Fatal("subscriber never entered WriteJSON")
	}

	// Detach while the writer is parked inside WriteJSON: quit alone cannot
	// interrupt the write; the per-write patience watchdog releases it.
	detach()
	if got := session.frames.count(); got != 0 {
		t.Fatalf("subscriber count = %d after detach, want 0", got)
	}
	select {
	case <-blocked.release:
	case <-time.After(2 * time.Second):
		t.Fatal("patience watchdog never released the wedged writer")
	}
}

type slowHealthyWriter struct {
	entered  chan struct{}
	returned chan struct{}
	release  chan struct{}
	once     sync.Once
}

func (w *slowHealthyWriter) WriteJSON([]byte) error {
	close(w.entered)
	time.Sleep(80 * time.Millisecond)
	close(w.returned)
	return nil
}

func (w *slowHealthyWriter) Close() error {
	w.once.Do(func() { close(w.release) })
	return nil
}

func TestHealthyInFlightWriteSurvivesDetach(t *testing.T) {
	// A cancellable writer whose WriteJSON finishes after a short, bounded
	// delay: detaching while the write is in flight must NOT close it, and it
	// must complete normally (chat switching survives ordinary writes).
	w := &slowHealthyWriter{entered: make(chan struct{}), returned: make(chan struct{}), release: make(chan struct{})}
	session := newTestSession("chat-healthy-inflight", nil) // default 5s patience
	detach := session.Attach(w)

	session.send(NameFrame{Type: "chat.name", SessionID: session.ID(), Name: "slow", Origin: "provider"})
	select {
	case <-w.entered:
	case <-time.After(2 * time.Second):
		t.Fatal("writer never entered WriteJSON")
	}
	detach() // race the in-flight healthy write
	select {
	case <-w.returned:
	case <-time.After(2 * time.Second):
		t.Fatal("healthy write never finished")
	}
	select {
	case <-w.release:
		t.Fatal("detach closed a healthy in-flight write; only wedged writes may be released")
	case <-time.After(300 * time.Millisecond):
	}
}

func TestBroadcasterPreservesPerSubscriberFrameOrder(t *testing.T) {
	writer := newCollectWriter()
	session := newTestSession("chat-order", writer)

	ack := ReadyFrame{Type: "ready", SessionID: session.ID(), PiSessionID: "pi-order", Resumed: true}
	session.send(ack)

	const n = 5
	want := make([][]byte, 0, 1+n)
	ackJSON, err := json.Marshal(ack)
	if err != nil {
		t.Fatal(err)
	}
	want = append(want, ackJSON)
	for i := 0; i < n; i++ {
		frame := NameFrame{Type: "chat.name", SessionID: session.ID(), Name: eventName(i), Origin: "provider"}
		session.send(frame)
		raw, err := json.Marshal(frame)
		if err != nil {
			t.Fatal(err)
		}
		want = append(want, raw)
	}

	got := writer.snapshot()
	if len(got) != len(want) {
		t.Fatalf("frame count = %d, want %d; frames: %s", len(got), len(want), writer.typesString())
	}
	for i := range want {
		if !bytes.Equal(got[i], want[i]) {
			t.Fatalf("frame %d = %s, want %s", i, got[i], want[i])
		}
	}
}

func sessionInfoEvent(handle, name string) Event {
	raw, _ := json.Marshal(struct {
		Type      string `json:"type"`
		SessionID string `json:"sessionId"`
		Name      string `json:"name"`
	}{Type: "session_info_changed", SessionID: handle, Name: name})
	return Event{Type: "session_info_changed", Raw: raw}
}

func eventName(i int) string {
	return "evt-" + strconv.Itoa(i)
}

func countNameFrames(frames [][]byte) int {
	n := 0
	for _, raw := range frames {
		var frame NameFrame
		if json.Unmarshal(raw, &frame) == nil && frame.Type == "chat.name" {
			n++
		}
	}
	return n
}
