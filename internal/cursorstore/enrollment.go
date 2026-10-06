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

// RefreshEnrollment updates a re-observed identity and the stored display
// name, without overwriting a concurrent user rename or changing native
// provenance. A creation placeholder is filled from the daemon name as
// before, and a name already sourced from the automatic path is replaced by
// the daemon's newer one: a rename made through rpc must reach a chat that is
// not open in webchat, or opening it later would start from the stale name.
// A webchat user rename (NameSourceUser) and a legacy name whose source is
// unknown are never replaced. It reports whether the stored display name
// changed.
func (s *Store) RefreshEnrollment(id, path, durableID, name string) (bool, error) {
	replaced := false
	err := s.updateChatFields(id, func(c *Chat) error {
		if c.AutoEnrolled || c.DurableSessionID == "" {
			c.SessionFile, c.DurableSessionID = path, durableID
		}
		if name == "" || c.NameSource == NameSourceUser {
			return nil
		}
		if c.TitleIsPlaceholder {
			// The pre-identity default is replaced even by the name it already
			// shows, because observing a daemon name establishes the title.
			replaced = c.Name != name
			c.Name, c.NameSource, c.TitleIsPlaceholder = name, NameSourceAuto, false
			return nil
		}
		if c.NameSource == NameSourceAuto && c.Name != name {
			c.Name, c.TitleIsPlaceholder = name, false
			replaced = true
		}
		return nil
	})
	return replaced && err == nil, err
}
