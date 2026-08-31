package chat

import (
	"errors"
	"sync"
)

// identityGate makes resume-identity delivery safe against providers that
// announce their identity before Manager.Start has registered the session.
// Early identities are buffered and replayed in arrival order once the gate
// opens; afterwards the gate is a pass-through. The mutex is held across
// every callback invocation, so replay can never interleave with a
// concurrent delivery, the callback never runs concurrently with itself,
// and a buffered identity can never overtake or be overtaken by a newer one.
type identityGate struct {
	mu      sync.Mutex
	opened  bool
	pending []bufferedIdentity
	next    ResumeIdentityCallback
}

type bufferedIdentity struct {
	source   *Session
	identity ResumeIdentity
}

func newIdentityGate(next ResumeIdentityCallback) *identityGate {
	return &identityGate{next: next}
}

func (g *identityGate) deliver(source *Session, identity ResumeIdentity) error {
	g.mu.Lock()
	defer g.mu.Unlock()
	if !g.opened {
		g.pending = append(g.pending, bufferedIdentity{source: source, identity: identity})
		return nil
	}
	return g.next(source, identity)
}

// open replays buffered identities in FIFO order and returns the callback
// errors joined, so a persistence failure during replay reaches
// Manager.Start instead of being discarded.
func (g *identityGate) open() error {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.opened = true
	var errs []error
	for _, buffered := range g.pending {
		if err := g.next(buffered.source, buffered.identity); err != nil {
			errs = append(errs, err)
		}
	}
	g.pending = nil
	return errors.Join(errs...)
}
