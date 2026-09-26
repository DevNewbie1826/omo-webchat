package session

// DeleteChatIdentity fences activity while removing stopped chat metadata.
// The caller supplies the current stored durable ID, even if its activity was
// evicted. Store I/O runs without Manager.mu; a failed removal lifts the fence
// without retiring the identity.
func (m *Manager) DeleteChatIdentity(chatID, durableID string, remove func() error) error {
	m.mu.Lock()
	owned := make(map[string]struct{})
	if durableID != "" {
		owned[durableID] = struct{}{}
	}
	for durable, owner := range m.durableToChat {
		if owner == chatID {
			owned[durable] = struct{}{}
		}
	}
	for durable, entry := range m.overviewCache {
		if entry.chatID == chatID {
			owned[durable] = struct{}{}
		}
	}
	if m.deletingDurable == nil {
		m.deletingDurable = make(map[string]int)
	}
	durables := make([]string, 0, len(owned))
	for durable := range owned {
		durables = append(durables, durable)
		m.deletingDurable[durable]++
	}
	m.mu.Unlock()
	defer func() {
		m.mu.Lock()
		defer m.mu.Unlock()
		for _, durable := range durables {
			m.deletingDurable[durable]--
			if m.deletingDurable[durable] == 0 {
				delete(m.deletingDurable, durable)
			}
		}
	}()
	if err := remove(); err != nil {
		return err
	}
	m.RetireIdentity(chatID, durables...)
	return nil
}
