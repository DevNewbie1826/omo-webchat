package session

import (
	"errors"
	"sync"
)

type errorDeliverer interface{ DeliverFrame(Frame) error }

type subscription struct {
	sub              Subscriber
	q                chan Frame
	stopCh           chan struct{}
	exited           chan struct{}
	initialDone      chan struct{}
	initialRemaining int
	initialOnce      sync.Once
	stopOnce         sync.Once
	retire           func(error)
}

func (x *subscription) start() { go x.run() }

func (x *subscription) run() {
	var retireReason error
	defer func() {
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
		case f := <-x.q:
			// Detach wins over a queued frame even when both cases became ready.
			select {
			case <-x.stopCh:
				return
			default:
			}
			if d, ok := x.sub.(errorDeliverer); ok {
				if err := d.DeliverFrame(f); err != nil {
					retireReason = errors.Join(ErrSubscriberDelivery, err)
					return
				}
			} else {
				x.sub.Deliver(f)
			}
			if x.initialRemaining > 0 {
				x.initialRemaining--
				if x.initialRemaining == 0 {
					x.initialOnce.Do(func() { close(x.initialDone) })
				}
			}
		}
	}
}

func (x *subscription) stop(cancel bool) {
	x.stopOnce.Do(func() {
		close(x.stopCh)
		if cancel {
			_ = x.sub.Cancel()
		}
	})
}

func (x *subscription) enqueue(f Frame) bool {
	select {
	case <-x.stopCh:
		return false
	default:
	}
	select {
	case x.q <- f:
		return true
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

func (b *broadcaster) attach(sub Subscriber, size int, initial []Frame) (uint64, func()) {
	if sub == nil {
		return 0, func() {}
	}
	b.mu.Lock()
	if b.subs == nil {
		b.subs = make(map[uint64]*subscription)
	}
	b.next++
	id := b.next
	x := &subscription{sub: sub, q: make(chan Frame, size), stopCh: make(chan struct{}), exited: make(chan struct{}), initialDone: make(chan struct{}), initialRemaining: len(initial)}
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
	return id, func() { once.Do(func() { b.retire(id, ErrSubscriberDetached, false) }) }
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
	if b.onDetach != nil {
		b.onDetach(x.sub, reason)
	}
}

func (b *broadcaster) publish(f Frame) {
	var retired []*subscription
	b.mu.Lock()
	for id, x := range b.subs {
		if !x.enqueue(f) {
			delete(b.subs, id)
			retired = append(retired, x)
		}
	}
	b.mu.Unlock()
	for _, x := range retired {
		b.finish(x, ErrSubscriberOverflow, true, true)
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
