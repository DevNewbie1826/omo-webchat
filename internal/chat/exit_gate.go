package chat

import "sync"

// exitGate holds an unexpected-exit notification until Manager.Start has
// registered the session. An EOF that arrives before registration is
// buffered and replayed right after, so the eviction callback always runs
// against the live map entry and a dead session can never stay registered.
// Exits that arrive after open pass through immediately.
type exitGate struct {
	mu     sync.Mutex
	opened bool
	source *Session
	next   ExitCallback
}

func newExitGate(next ExitCallback) *exitGate {
	return &exitGate{next: next}
}

func (g *exitGate) fire(source *Session) {
	g.mu.Lock()
	if !g.opened {
		g.source = source
		g.mu.Unlock()
		return
	}
	g.mu.Unlock()
	g.next(source)
}

func (g *exitGate) open() {
	g.mu.Lock()
	source := g.source
	g.source = nil
	g.opened = true
	g.mu.Unlock()
	if source != nil {
		g.next(source)
	}
}
