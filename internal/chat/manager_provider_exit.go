package chat

// providerExited publishes the provider replacement point and evicts every
// route atomically. AcquireAttach can therefore see either the old provider
// with all of its sessions, or a nil provider with none of them, never a
// dead route paired with a freshly available provider slot.
//
// Every session that still pointed at the dying provider drops shared and
// its routing handle before Manager.mu is released, so a later provider
// cannot inherit a stale route. Lock order: Manager.mu -> Session.mu.
func (m *Manager) providerExited(provider *sharedProvider, termination providerTermination) {
	m.mu.Lock()
	if m.provider != provider {
		m.mu.Unlock()
		return
	}
	m.provider = nil
	routed := make(map[*Session]struct{}, len(termination.sessions))
	for _, session := range termination.sessions {
		routed[session] = struct{}{}
	}
	var unrouted []*Session
	detached := make(map[*Session]struct{})
	detach := func(session *Session) {
		session.mu.Lock()
		owned := session.shared == provider
		handle := session.routingHandle
		if owned {
			session.shared = nil
		}
		session.mu.Unlock()
		if !owned {
			return
		}
		provider.clearRoutingHandle(session, handle)
		detached[session] = struct{}{}
	}
	for id, session := range m.sessions {
		detach(session)
		if _, ok := detached[session]; !ok {
			continue
		}
		delete(m.sessions, id)
		if _, ok := routed[session]; !ok {
			unrouted = append(unrouted, session)
		}
	}
	for _, session := range termination.sessions {
		if _, ok := detached[session]; ok {
			continue
		}
		detach(session)
	}
	m.mu.Unlock()
	// Route workers own both the lifecycle transition and ordered terminal
	// delivery. In particular, do not acquire lifecycleMu on the shared pump:
	// a client writer may currently hold it while blocked in frame delivery.
	// A defensive fallback for an already-registered session whose provider
	// has no route (possible in tests and during partial setup): no route worker
	// exists to carry its final delivery.
	for _, session := range unrouted {
		session.prepareProviderExit()
		go session.providerExited(termination)
	}
}
