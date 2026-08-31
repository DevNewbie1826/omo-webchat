package chat

import (
	"reflect"
	"sort"
	"sync"
	"time"
)

// FrameSubscriber receives every provider-facing frame for an attached client.
type FrameSubscriber func([]byte) error

// FrameWriterCanceller releases a FrameWriter blocked in WriteJSON.
// Implementations must return immediately and tolerate concurrent calls.
type FrameWriterCanceller interface {
	Close() error
}

// subscriberQueueSize bounds each cancellable subscription's outbound FIFO.
// It mirrors sessionQueueSize on purpose: a writer that falls a full route
// queue behind is cancelled and detached instead of ever blocking a producer,
// so the route queue can only overflow when the route worker itself is the
// bottleneck — never because of a slow client. The bound must stay at or
// below sessionQueueSize: with the in-flight frame held by the writer
// goroutine, a wedged writer accumulates one pending frame per routed event,
// and the overflow-detach has to fire strictly before the route queue (also
// sessionQueueSize) would overflow and kill the session.
const subscriberQueueSize = sessionQueueSize

type frameSubscription struct {
	deliver FrameSubscriber
	closer  FrameWriterCanceller
	writer  FrameWriter
	// queue and quit exist only for cancellable subscriptions: writers that
	// opted into the cancellation contract by implementing Close are exactly
	// the ones allowed to block indefinitely, so their delivery runs on a
	// dedicated goroutine behind a bounded buffer. Non-cancellable writers
	// promise prompt WriteJSON calls and are delivered inline.
	queue      chan []byte
	quit       chan struct{}
	quitOnce   sync.Once
	delivering bool // guarded by broadcaster.mu
}

// stop stops the subscription's writer goroutine. Frames still queued are
// dropped: the subscriber has been detached, so delivering them would target
// a client that went away. A goroutine wedged inside WriteJSON is released by
// the canceller Close performed by detach or cancelActive, per the
// FrameWriterCanceller contract.
func (s *frameSubscription) stop() {
	if s.quit != nil {
		s.quitOnce.Do(func() { close(s.quit) })
	}
}

type broadcaster struct {
	mu          sync.Mutex
	subscribers map[uint64]*frameSubscription
	active      map[*frameSubscription]struct{}
	nextID      uint64
	// writePatience bounds every cancellable WriteJSON: a write that has
	// not returned within it is wedged and its writer is closed by a
	// watchdog. Synchronously, an in-flight write that will finish is
	// indistinguishable from one that never will, so patience - not the
	// remover or session teardown - is the only correct discriminator.
	// Tests shrink it; production keeps the five-second default.
	writePatience time.Duration
}

func newBroadcaster() *broadcaster {
	return &broadcaster{
		subscribers:   make(map[uint64]*frameSubscription),
		active:        make(map[*frameSubscription]struct{}),
		writePatience: 5 * time.Second,
	}
}

func (b *broadcaster) add(subscriber FrameSubscriber, closer FrameWriterCanceller, writer FrameWriter) uint64 {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.nextID++
	id := b.nextID
	sub := &frameSubscription{deliver: subscriber, closer: closer, writer: writer}
	if closer != nil {
		sub.queue = make(chan []byte, subscriberQueueSize)
		sub.quit = make(chan struct{})
		b.active[sub] = struct{}{}
		go b.drain(id, sub)
	}
	b.subscribers[id] = sub
	return id
}

func (b *broadcaster) remove(id uint64) {
	// The unsubscribe and the quit close are one atomic step: a drain's
	// critical section then observes either (still subscribed, quit open) or
	// (removed, quit closed). A drain parked inside a WriteJSON - healthy or
	// wedged - is never closed here: an in-flight write that will finish is
	// indistinguishable from one that will not, so only the per-write
	// patience watchdog closes writers, and a healthy detach (chat switch)
	// never kills the connection.
	b.mu.Lock()
	sub := b.subscribers[id]
	delete(b.subscribers, id)
	if sub != nil && sub.quit != nil {
		sub.quitOnce.Do(func() { close(sub.quit) })
	}
	b.mu.Unlock()
}

func (b *broadcaster) write(frame []byte) {
	b.mu.Lock()
	ids := make([]uint64, 0, len(b.subscribers))
	for id := range b.subscribers {
		ids = append(ids, id)
	}
	b.mu.Unlock()
	// Attachment order gives every subscriber the same frame sequence and
	// makes fan-out deterministic; per-subscriber FIFO is preserved by the
	// delivery path below.
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	for _, id := range ids {
		b.writeTo(id, frame)
	}
}

// writeToWriter unicasts frames through the target attachment's normal FIFO.
// The caller holds the session delivery barrier, ordering the replay before
// every later live broadcast.
func (b *broadcaster) writeToWriter(writer FrameWriter, frames [][]byte) {
	b.mu.Lock()
	var id uint64
	target := reflect.ValueOf(writer)
	for candidate, sub := range b.subscribers {
		attached := reflect.ValueOf(sub.writer)
		if target.IsValid() && attached.IsValid() && target.Type() == attached.Type() && target.Type().Comparable() && target.Interface() == attached.Interface() {
			id = candidate
			break
		}
	}
	b.mu.Unlock()
	if id == 0 {
		return
	}
	for _, frame := range frames {
		b.writeTo(id, frame)
	}
}

// writeTo uses the same tracked delivery path for both live broadcasts and
// attach-time replay. In particular, cancelActive can always find a writer
// while it is blocked in WriteJSON.
//
// Cancellable writers (FrameWriterCanceller) are the ones that may block
// indefinitely, so their frames go through a bounded per-subscription FIFO
// consumed by a dedicated goroutine. The enqueue below never blocks: when the
// buffer is full the writer cannot keep up, so it is detached — its closer is
// invoked to release a WriteJSON wedged on frame delivery and the
// subscription is removed — while sibling subscribers keep flowing. The
// route worker therefore can no longer be stalled into a queue-overflow
// session kill by a slow subscriber.
func (b *broadcaster) writeTo(id uint64, frame []byte) {
	b.mu.Lock()
	sub := b.subscribers[id]
	if sub == nil {
		b.mu.Unlock()
		return
	}
	if sub.closer != nil {
		select {
		case sub.queue <- frame:
			b.mu.Unlock()
			return
		default:
			b.mu.Unlock()
			b.detach(id, sub)
			return
		}
	}
	b.mu.Unlock()

	err := sub.deliver(frame)
	if err != nil {
		b.detach(id, sub)
	}
}

// drain consumes one cancellable subscription's FIFO in order. Exactly one
// goroutine runs per subscription, so WriteJSON calls are serialized per
// subscriber. It exits when the subscription is removed or detached, or after
// a failed deliver detaches it.
// claimDelivery dequeues one frame and latches the delivering mark under a
// single lock acquisition, re-checking quit after the dequeue: if the
// subscription was removed (delete + quit close are atomic in remove and
// detach), the frame is discarded and the drain exits; otherwise the
// delivering mark is latched before the drain enters its watchdogged
// WriteJSON.
func (b *broadcaster) claimDelivery(sub *frameSubscription) ([]byte, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	select {
	case <-sub.quit:
		return nil, false
	default:
	}
	select {
	case frame := <-sub.queue:
		select {
		case <-sub.quit:
			return nil, false
		default:
			sub.delivering = true
			return frame, true
		}
	default:
		return nil, true // no frame ready; caller may wait outside the lock
	}
}

func (b *broadcaster) drain(id uint64, sub *frameSubscription) {
	defer func() {
		b.mu.Lock()
		delete(b.active, sub)
		b.mu.Unlock()
	}()
	for {
		frame, ok := b.claimDelivery(sub)
		if ok && frame == nil {
			select {
			case f := <-sub.queue:
				frame = f
				b.mu.Lock()
				select {
				case <-sub.quit:
					b.mu.Unlock()
					return
				default:
					sub.delivering = true
				}
				b.mu.Unlock()
				ok = true
			case <-sub.quit:
				return
			}
		}
		if !ok {
			return
		}
		if !b.deliverQueued(id, sub, frame) {
			return
		}
	}
}

// deliverQueued runs one delivery under the per-write patience watchdog:
// if the WriteJSON has not returned within writePatience, the watchdog
// closes the writer's closer AND detaches the subscription itself. Closing
// only releases the write — FrameWriterCanceller makes no promise about the
// value WriteJSON then returns — so the watchdog cannot rely on a non-nil
// error to detach: a timed-out subscription is dead regardless. A write
// that finishes in time is never touched, under any detach/close ordering.
func (b *broadcaster) deliverQueued(id uint64, sub *frameSubscription, frame []byte) bool {
	b.mu.Lock()
	sub.delivering = true
	b.mu.Unlock()
	patience := b.writePatience
	if patience <= 0 {
		patience = 5 * time.Second
	}
	timer := time.AfterFunc(patience, func() {
		if sub.closer != nil {
			_ = sub.closer.Close()
		}
		b.detach(id, sub)
	})
	err := sub.deliver(frame)
	timer.Stop()
	b.mu.Lock()
	sub.delivering = false
	b.mu.Unlock()
	if err == nil {
		return true
	}
	// A failed socket belongs only to this logical session and attachment.
	// Detach it so later frames cannot repeatedly fail or affect delivery
	// workers for any other routed session.
	b.detach(id, sub)
	return false
}

// detach removes one subscription and cancels its writer. It is idempotent:
// only the subscription currently registered under id is torn down.
func (b *broadcaster) detach(id uint64, sub *frameSubscription) {
	b.mu.Lock()
	if b.subscribers[id] != sub {
		b.mu.Unlock()
		return
	}
	delete(b.subscribers, id)
	delete(b.active, sub)
	if sub.quit != nil {
		sub.quitOnce.Do(func() { close(sub.quit) })
	}
	b.mu.Unlock()

	if sub.closer != nil {
		_ = sub.closer.Close()
	}
}

// cancelActive closes every live cancellable writer. Its callers are
// destructive paths only (route abort and session/server teardown), so closing
// healthy writers that are waiting for their next frame is intentional.
func (b *broadcaster) cancelActive() {
	b.mu.Lock()
	closers := make([]FrameWriterCanceller, 0, len(b.active))
	for sub := range b.active {
		closers = append(closers, sub.closer)
	}
	b.mu.Unlock()
	for _, closer := range closers {
		_ = closer.Close()
	}
}

func (b *broadcaster) count() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.subscribers)
}

func (s *Session) attachmentCountLocked() int {
	return s.frames.count()
}

func (s *Session) attachLocked(writer FrameWriter) (detach func(), replay func()) {
	if writer == nil {
		return func() {}, func() {}
	}
	subscribe := func(frame []byte) error { return writer.WriteJSON(frame) }
	var closer FrameWriterCanceller
	if cancellable, ok := writer.(FrameWriterCanceller); ok {
		closer = cancellable
	}
	// Registration and snapshot capture linearize under the delivery barrier.
	// The caller releases lifecycle/manager locks before replay performs I/O,
	// while the retained barrier keeps every following live frame behind it.
	s.barrier.Lock()
	id := s.frames.add(subscribe, closer, writer)
	snapshots := s.activitySnapshots()
	notices := s.durableNoticeFrames()
	var once sync.Once
	detach = func() {
		once.Do(func() { s.frames.remove(id) })
	}
	replay = func() {
		defer s.barrier.Unlock()
		for _, frame := range snapshots {
			s.frames.writeTo(id, frame)
		}
		// Durable notices follow the activity snapshots, oldest -> newest.
		// The log is session state, not a consumed replay: every later attach
		// receives it again.
		for _, frame := range notices {
			s.frames.writeTo(id, frame)
		}
	}
	return detach, replay
}

// Attach subscribes writer to future provider frames. The returned detach is
// idempotent and never owns the process lifetime.
func (s *Session) Attach(writer FrameWriter) func() {
	s.lifecycleMu.Lock()
	detach, replay := s.attachLocked(writer)
	s.lifecycleMu.Unlock()
	replay()
	return detach
}

func (s *Session) writeFrame(frame []byte) {
	s.frames.write(frame)
}
