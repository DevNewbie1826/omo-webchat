package session

import (
	"errors"
	"sync"
)

type errorDeliverer interface{ DeliverFrame(Frame) error }
type subscriberCloser interface{ Close() error }

type subscription struct {
	sub      Subscriber
	q        chan Frame
	stopCh   chan struct{}
	exited   chan struct{}
	stopOnce sync.Once
	retire   func(error)
}

func (x *subscription) start() { go x.run() }

func (x *subscription) run() {
	defer close(x.exited)
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
					x.retire(errors.Join(ErrSubscriberDelivery, err))
					return
				}
			} else {
				x.sub.Deliver(f)
			}
		}
	}
}

func (x *subscription) stop() {
	x.stopOnce.Do(func() {
		close(x.stopCh)
		if c, ok := x.sub.(subscriberCloser); ok {
			_ = c.Close()
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
	x := &subscription{sub: sub, q: make(chan Frame, size), stopCh: make(chan struct{}), exited: make(chan struct{})}
	x.retire = func(reason error) { b.retire(id, reason) }
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
	x.start()
	if !accepted {
		b.finish(x, ErrSubscriberOverflow)
	}
	var once sync.Once
	return id, func() { once.Do(func() { b.retire(id, ErrSubscriberDetached) }) }
}

func (b *broadcaster) retire(id uint64, reason error) {
	if id == 0 {
		return
	}
	b.mu.Lock()
	x := b.subs[id]
	delete(b.subs, id)
	b.mu.Unlock()
	if x != nil {
		b.finish(x, reason)
	}
}

func (b *broadcaster) finish(x *subscription, reason error) {
	x.stop()
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
		b.finish(x, ErrSubscriberOverflow)
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
		b.finish(x, reason)
	}
}

func (b *broadcaster) count() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.subs)
}
