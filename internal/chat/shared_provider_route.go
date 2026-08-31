package chat

import (
	"encoding/json"
	"sync"
	"time"
)

const (
	sessionQueueSize       = 64
	sessionDeliveryTimeout = 5 * time.Second
)

func (k providerTerminationKind) String() string {
	switch k {
	case providerTerminationUnexpected:
		return "unexpected"
	case providerTerminationDecodeFailed:
		return "decode_failed"
	case providerTerminationIntentional:
		return "intentional"
	case providerTerminationQueueOverflow:
		return "queue_overflow"
	case providerTerminationDeliveryTimeout:
		return "delivery_timeout"
	default:
		return "unknown"
	}
}

type sessionDelivery struct {
	event        *Event
	initialState json.RawMessage
	termination  *providerTermination
}

type sessionRoute struct {
	session          *Session
	handle           string
	queue            chan sessionDelivery
	ready            chan struct{}
	readyOnce        sync.Once
	stop             chan struct{}
	stopped          chan struct{}
	stopOnce         sync.Once
	initOnce         sync.Once
	teardownOnce     sync.Once
	provider         *sharedProvider
	deliveryDeadline func() <-chan time.Time
}

func (r *sessionRoute) init() {
	r.initOnce.Do(func() {
		r.stop = make(chan struct{})
		r.stopped = make(chan struct{})
		if r.deliveryDeadline == nil {
			r.deliveryDeadline = func() <-chan time.Time { return time.After(sessionDeliveryTimeout) }
		}
	})
}

func (r *sessionRoute) activate() {
	r.init()
	r.readyOnce.Do(func() { close(r.ready) })
}

func (r *sessionRoute) cancel() {
	r.init()
	r.stopOnce.Do(func() { close(r.stop) })
}

func (p *sharedProvider) activateRoute(handle string, s *Session) {
	p.mu.Lock()
	if route := p.sessions[handle]; route != nil && route.session == s {
		route.activate()
	}
	p.mu.Unlock()
}

func (p *sharedProvider) clearRoutingHandle(s *Session, handle string) {
	s.mu.Lock()
	if s.routingHandle == handle {
		s.routingHandle = ""
	}
	s.mu.Unlock()
}

func (p *sharedProvider) removeSession(handle string, s *Session) {
	p.mu.Lock()
	p.removeSessionLocked(handle, s)
	p.mu.Unlock()
	p.clearRoutingHandle(s, handle)
}

func (p *sharedProvider) removeSessionLocked(handle string, s *Session) {
	route := p.detachSessionLocked(handle, s)
	if route != nil {
		route.activate()
		close(route.queue)
	}
}

func (p *sharedProvider) detachSessionLocked(handle string, s *Session) *sessionRoute {
	route := p.sessions[handle]
	if route == nil || route.session != s {
		return nil
	}
	delete(p.sessions, handle)
	for id, requested := range p.requests {
		if requested == route {
			delete(p.requests, id)
		}
	}
	return route
}

// teardownRoute is the single owner for route-local delivery failures. Queue
// overflow and a timed-out writer differ only in their terminal reason: both
// detach routing, evict manager visibility, stop the worker and active writer,
// publish logical termination, and close the provider-side session.
func (p *sharedProvider) teardownRoute(route *sessionRoute, termination providerTermination) {
	route.teardownOnce.Do(func() {
		p.mu.Lock()
		p.detachSessionLocked(route.handle, route.session)
		p.mu.Unlock()

		// Eviction stays ahead of every lifecycle operation. A writer may hold
		// lifecycleMu indefinitely, but cannot keep the failed route acquirable.
		if route.session.owner != nil {
			id := route.session.ID()
			route.session.owner.evictSession(route.session)
			route.session.owner.logWarn("session route torn down", "session", id, "kind", termination.kind.String(), "summary", termination.summary)
		}
		route.abort(termination)
		go func() {
			_ = p.closeSessionHandle(route.handle, route.session)
			if route.session.owner != nil {
				route.session.owner.releaseProviderIfIdle()
			}
		}()
	})
}

// installOpenRouteLocked installs the ephemeral handle before the correlated
// response wakes openSession. The initial identity is queued as the route's
// first task, so a frame emitted immediately after open_session cannot overtake
// it or be dropped.
func (p *sharedProvider) installOpenRouteLocked(s *Session, ev Event) {
	var resp struct {
		Success   bool            `json:"success"`
		SessionID string          `json:"sessionId"`
		Data      json.RawMessage `json:"data"`
	}
	if json.Unmarshal(ev.Raw, &resp) != nil || !resp.Success {
		return
	}
	var data struct {
		SessionID string          `json:"sessionId"`
		State     json.RawMessage `json:"state"`
	}
	if json.Unmarshal(resp.Data, &data) != nil {
		return
	}
	handle := data.SessionID
	if handle == "" {
		handle = resp.SessionID
	}
	if handle == "" {
		return
	}
	route := &sessionRoute{session: s, handle: handle, queue: make(chan sessionDelivery, sessionQueueSize), ready: make(chan struct{}), provider: p}
	s.mu.Lock()
	s.shared = p
	s.routingHandle = handle
	s.mu.Unlock()
	p.sessions[handle] = route
	go route.run()
}

func (r *sessionRoute) run() {
	r.init()
	defer close(r.stopped)
	select {
	case <-r.ready:
	case <-r.stop:
		return
	}
	for {
		var delivery sessionDelivery
		var ok bool
		select {
		case delivery, ok = <-r.queue:
			if !ok {
				return
			}
		case <-r.stop:
			return
		}

		delivered := make(chan struct{})
		go func() {
			switch {
			case delivery.initialState != nil:
				r.session.capturePiSessionID(delivery.initialState)
			case delivery.event != nil:
				r.session.dispatch(*delivery.event)
			case delivery.termination != nil:
				r.session.providerExited(*delivery.termination)
			}
			close(delivered)
		}()
		select {
		case <-delivered:
		case <-r.stop:
			return
		case <-r.deliveryDeadline():
			termination := providerTermination{kind: providerTerminationDeliveryTimeout, summary: "session delivery timed out"}
			if r.provider != nil {
				r.provider.teardownRoute(r, termination)
			} else {
				r.abort(termination)
			}
			return
		}
	}
}

func (r *sessionRoute) terminate(termination providerTermination) {
	r.activate()
	select {
	case r.queue <- sessionDelivery{termination: &termination}:
		close(r.queue)
	case <-r.stop:
	case <-r.stopped:
	}
}

func (r *sessionRoute) abort(termination providerTermination) {
	r.cancel()
	// Closing only the writer currently executing WriteJSON preserves healthy
	// attachments and actively releases the delivery goroutine that timed out.
	if r.session.frames != nil {
		r.session.frames.cancelActive()
	}
	go r.session.providerExited(termination)
}

func (p *sharedProvider) sessionSnapshot() []*Session {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := make([]*Session, 0, len(p.sessions))
	for _, route := range p.sessions {
		out = append(out, route.session)
	}
	return out
}
