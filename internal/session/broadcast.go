package session

import "sync"

type subscription struct {
	sub  Subscriber
	q    chan Frame
	done chan struct{}
	once sync.Once
}

func newSubscription(sub Subscriber, size int) *subscription {
	x := &subscription{sub: sub, q: make(chan Frame, size), done: make(chan struct{})}
	go x.run()
	return x
}

func (x *subscription) run() {
	for {
		select {
		case <-x.done:
			return
		case f := <-x.q:
			x.sub.Deliver(f)
		}
	}
}

func (x *subscription) stop() { x.once.Do(func() { close(x.done) }) }

// enqueue is non-blocking. A full queue retires this subscriber only.
func (x *subscription) enqueue(f Frame) bool {
	select {
	case <-x.done:
		return false
	default:
	}
	select {
	case x.q <- f:
		return true
	default:
		x.stop()
		return false
	}
}

type broadcaster struct {
	mu   sync.Mutex
	next uint64
	subs map[uint64]*subscription
}

func (b *broadcaster) attach(sub Subscriber, size int, initial []Frame) (uint64, func()) {
	if sub == nil {
		return 0, func() {}
	}
	x := newSubscription(sub, size)
	b.mu.Lock()
	if b.subs == nil {
		b.subs = make(map[uint64]*subscription)
	}
	b.next++
	id := b.next
	b.subs[id] = x
	for _, f := range initial {
		if !x.enqueue(f) {
			delete(b.subs, id)
			break
		}
	}
	b.mu.Unlock()
	var once sync.Once
	return id, func() { once.Do(func() { b.detach(id) }) }
}

func (b *broadcaster) detach(id uint64) {
	if id == 0 {
		return
	}
	b.mu.Lock()
	x := b.subs[id]
	delete(b.subs, id)
	b.mu.Unlock()
	if x != nil {
		x.stop()
	}
}

func (b *broadcaster) publish(f Frame) {
	b.mu.Lock()
	for id, x := range b.subs {
		if !x.enqueue(f) {
			delete(b.subs, id)
		}
	}
	b.mu.Unlock()
}

func (b *broadcaster) count() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.subs)
}
