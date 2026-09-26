package session

// DeleteChatIdentity fences activity while removing stopped chat metadata.
// The caller supplies the current stored durable ID, even if its activity was
// evicted. Store I/O runs without Manager.mu; a failed removal lifts the fence
// without retiring the identity.
func (m *Manager) DeleteChatIdentity(chatID, durableID string, remove func() error) error {
	return m.DeleteChatIdentities(map[string]string{chatID: durableID}, remove)
}

// DeleteChatIdentities fences every affected chat before a workspace metadata
// transaction. Callers capture current cursors after stopping all acquisitions.
func (m *Manager) DeleteChatIdentities(chats map[string]string, remove func() error) error {
	m.mu.Lock()
	owned := make(map[string]string)
	for chatID, durableID := range chats {
		if durableID != "" {
			owned[durableID] = chatID
		}
	}
	for durable, owner := range m.durableToChat {
		if _, affected := chats[owner]; affected {
			owned[durable] = owner
		}
	}
	for durable, owner := range m.overviewOwners {
		if _, affected := chats[owner]; affected {
			owned[durable] = owner
		}
	}
	if m.deletingDurable == nil {
		m.deletingDurable = make(map[string]int)
	}
	durables := make([]string, 0, len(owned))
	for durable := range owned {
		if current, _ := m.currentOverviewOwnerLocked(durable, ""); current != "" {
			if _, affected := chats[current]; !affected {
				delete(owned, durable)
				continue
			}
		}
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
	for chatID := range chats {
		var affected []string
		for durable, owner := range owned {
			if owner == chatID {
				affected = append(affected, durable)
			}
		}
		m.RetireIdentity(chatID, affected...)
	}
	return nil
}
