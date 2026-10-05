package cursorstore

func recordEnrollmentTombstone(state *State, chat Chat) {
	if !chat.AutoEnrolled || chat.DurableSessionID == "" {
		return
	}
	if state.EnrollmentTombstones == nil {
		state.EnrollmentTombstones = make(map[string]bool)
	}
	state.EnrollmentTombstones[chat.DurableSessionID] = true
}

func (s *Store) EnrollmentDeleted(durableID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.data.EnrollmentTombstones[durableID]
}

// RefreshEnrollment updates a re-observed identity and a placeholder title,
// without overwriting a concurrent user rename or changing native provenance.
func (s *Store) RefreshEnrollment(id, path, durableID, name string) error {
	return s.updateChatFields(id, func(c *Chat) error {
		if c.AutoEnrolled || c.DurableSessionID == "" {
			c.SessionFile, c.DurableSessionID = path, durableID
		}
		if c.TitleIsPlaceholder && c.NameSource != NameSourceUser && name != "" {
			c.Name, c.NameSource, c.TitleIsPlaceholder = name, NameSourceAuto, false
		}
		return nil
	})
}
