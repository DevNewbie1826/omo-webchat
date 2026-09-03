package session

import (
	"context"
	"sync"
)

type errorDeliverer interface{ DeliverFrame(Frame) error }

type queuedFrame struct {
	frame     Frame
	delivered chan struct{}
	barrier   bool
}

type subscription struct {
	sub              Subscriber
	q                chan queuedFrame
	stopCh           chan struct{}
	exited           chan struct{}
	initialDone      chan struct{}
	initialRemaining int
	initialOnce      sync.Once
	stopOnce         sync.Once
	retire           func(error)

	replayMu    sync.Mutex
	replaying   bool
	pendingLive []Frame
}

func (x *subscription) start() { go x.run() }

func (x *subscription) run() {
	var retireReason error
	defer func() {
		x.endReplay()
		x.initialOnce.Do(func() { close(x.initialDone) })
		close(x.exited)
		if retireReason != nil {
			x.retire(retireReason)
		}
	}()
	for {
		select {
		case <-x.stopCh:
			return
		default:
		}
		select {
		case <-x.stopCh:
			return
		case item := <-x.q:
			if !item.barrier {
				if !x.deliver(item.frame) {
					retireReason = ErrSubscriberDelivery
					return
				}
				if x.initialRemaining > 0 {
					x.initialRemaining--
					if x.initialRemaining == 0 {
						x.initialOnce.Do(func() { close(x.initialDone) })
					}
				}
			}
			if item.delivered != nil {
				if !x.finishReplay() {
					retireReason = ErrSubscriberDelivery
					return
				}
				close(item.delivered)
			}
		}
	}
}

func (x *subscription) deliver(f Frame) bool {
	// Detach wins over a queued frame even when both cases became ready.
	select {
	case <-x.stopCh:
		return false
	default:
	}
	if d, ok := x.sub.(errorDeliverer); ok {
		if err := d.DeliverFrame(f); err != nil {
			return false
		}
	} else {
		x.sub.Deliver(f)
	}
	return true
}

func (x *subscription) beginReplay() {
	x.replayMu.Lock()
	if !x.replaying {
		x.replaying = true
		if replay, ok := x.sub.(ReplayBackpressureSubscriber); ok {
			replay.BeginReplay()
		}
	}
	x.replayMu.Unlock()
}

func (x *subscription) finishReplay() bool {
	for {
		x.replayMu.Lock()
		if !x.replaying {
			x.replayMu.Unlock()
			return true
		}
		if len(x.pendingLive) == 0 {
			x.replaying = false
			if replay, ok := x.sub.(ReplayBackpressureSubscriber); ok {
				replay.EndReplay()
			}
			x.replayMu.Unlock()
			return true
		}
		pending := x.pendingLive
		x.pendingLive = nil
		x.replayMu.Unlock()

		for _, frame := range pending {
			if !x.deliver(frame) {
				return false
			}
		}
	}
}

func (x *subscription) endReplay() {
	x.replayMu.Lock()
	if x.replaying {
		x.replaying = false
		x.pendingLive = nil
		if replay, ok := x.sub.(ReplayBackpressureSubscriber); ok {
			replay.EndReplay()
		}
	}
	x.replayMu.Unlock()
}

func (x *subscription) stop(cancel bool) {
	x.stopOnce.Do(func() {
		close(x.stopCh)
		x.endReplay()
		if cancel {
			_ = x.sub.Cancel()
		}
	})
}

// enqueue is non-blocking. While a targeted replay is active, live frames are
// retained in a separate bounded FIFO so publishers never wait under session
// or broadcaster locks and cannot overtake the replay terminal.
func (x *subscription) enqueue(f Frame) bool {
	select {
	case <-x.stopCh:
		return false
	default:
	}
	x.replayMu.Lock()
	if x.replaying {
		if len(x.pendingLive) >= cap(x.q) {
			x.replayMu.Unlock()
			return false
		}
		x.pendingLive = append(x.pendingLive, f)
		x.replayMu.Unlock()
		return true
	}
	x.replayMu.Unlock()
	select {
	case x.q <- queuedFrame{frame: f}:
		return true
	default:
		return false
	}
}

// enqueueReplay admits one history frame to this subscriber only. Admission
// and terminal delivery acknowledgment are both bounded by the history context.
func (x *subscription) enqueueReplay(ctx context.Context, f Frame, terminal bool) error {
	item := queuedFrame{frame: f}
	if terminal {
		item.delivered = make(chan struct{})
	}
	select {
	case x.q <- item:
	case <-x.stopCh:
		return ErrSubscriberDetached
	case <-ctx.Done():
		return ctx.Err()
	}
	if item.delivered == nil {
		return nil
	}
	select {
	case <-item.delivered:
		return nil
	case <-x.stopCh:
		return ErrSubscriberDetached
	case <-ctx.Done():
		return ctx.Err()
	}
}

// enqueueReplayBarrier completes replay without delivering another frame. It
// is used when the terminal transition is already buffered as a live frame.
func (x *subscription) enqueueReplayBarrier(ctx context.Context) error {
	item := queuedFrame{delivered: make(chan struct{}), barrier: true}
	select {
	case x.q <- item:
	case <-x.stopCh:
		return ErrSubscriberDetached
	case <-ctx.Done():
		return ctx.Err()
	}
	select {
	case <-item.delivered:
		return nil
	case <-x.stopCh:
		return ErrSubscriberDetached
	case <-ctx.Done():
		return ctx.Err()
	}
}

// enqueueReplayTerminalNow is used after the history context has expired. It
// never waits, but the pump still ends replay only after delivering the error.
func (x *subscription) enqueueReplayTerminalNow(f Frame) bool {
	item := queuedFrame{frame: f, delivered: make(chan struct{})}
	select {
	case x.q <- item:
		return true
	case <-x.stopCh:
		return false
	default:
		return false
	}
}

type broadcaster struct {
	mu       sync.Mutex
	next     uint64
	subs     map[uint64]*subscription
	onDetach func(Subscriber, error)
}

func (b *broadcaster) attach(sub Subscriber, size int, initial []Frame) (uint64, *subscription, func()) {
	if sub == nil {
		return 0, nil, func() {}
	}
	b.mu.Lock()
	if b.subs == nil {
		b.subs = make(map[uint64]*subscription)
	}
	b.next++
	id := b.next
	x := &subscription{sub: sub, q: make(chan queuedFrame, size), stopCh: make(chan struct{}), exited: make(chan struct{}), initialDone: make(chan struct{}), initialRemaining: len(initial)}
	x.retire = func(reason error) { b.retire(id, reason, true) }
	b.subs[id] = x
	accepted := true
	for _, f := range initial {
		if !x.enqueue(f) {
			accepted = false
			delete(b.subs, id)
			break
		}
	}
	b.mu.Unlock()
	if x.initialRemaining == 0 {
		x.initialOnce.Do(func() { close(x.initialDone) })
	}
	x.start()
	if _, synchronous := sub.(SynchronousAttachHook); synchronous {
		<-x.initialDone
	}
	if !accepted {
		b.finish(x, ErrSubscriberOverflow, true, true)
	}
	var once sync.Once
	return id, x, func() { once.Do(func() { b.retire(id, ErrSubscriberDetached, false) }) }
}

func (b *broadcaster) retire(id uint64, reason error, cancel bool) {
	if id == 0 {
		return
	}
	b.mu.Lock()
	x := b.subs[id]
	delete(b.subs, id)
	b.mu.Unlock()
	if x != nil {
		b.finish(x, reason, true, cancel)
	}
}

func (b *broadcaster) finish(x *subscription, reason error, wait, cancel bool) {
	x.stop(cancel)
	if wait {
		<-x.exited
	}
	b.notifyDetach(x, reason)
}

func (b *broadcaster) finishAsync(x *subscription, reason error, cancel bool) {
	x.stop(cancel)
	go func() {
		<-x.exited
		b.notifyDetach(x, reason)
	}()
}

func (b *broadcaster) notifyDetach(x *subscription, reason error) {
	if b.onDetach != nil {
		b.onDetach(x.sub, reason)
	}
}

func (b *broadcaster) publish(f Frame) {
	b.publishExcept(f, nil)
}

func (b *broadcaster) publishExcept(f Frame, except *subscription) {
	var retired []*subscription
	b.mu.Lock()
	for id, x := range b.subs {
		if x == except {
			continue
		}
		if !x.enqueue(f) {
			delete(b.subs, id)
			retired = append(retired, x)
		}
	}
	b.mu.Unlock()
	for _, x := range retired {
		b.finishAsync(x, ErrSubscriberOverflow, true)
	}
}

func (b *broadcaster) close(reason error) {
	b.mu.Lock()
	all := make([]*subscription, 0, len(b.subs))
	for id, x := range b.subs {
		delete(b.subs, id)
		all = append(all, x)
	}
	b.mu.Unlock()
	for _, x := range all {
		b.finish(x, reason, true, true)
	}
}

func (b *broadcaster) count() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.subs)
}
