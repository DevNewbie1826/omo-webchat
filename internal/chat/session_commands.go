package chat

import (
	"strconv"
	"time"
)

func (s *Session) SendPrompt(message string, images []map[string]string) error {
	cmd := map[string]any{"type": "prompt", "message": message}
	if len(images) > 0 {
		cmd["images"] = images
	}
	s.lifecycleMu.Lock()
	s.mu.Lock()
	// Reject while any run is active: a user prompt cannot start during an
	// in-flight user run (promptInFlight) or a provider-initiated run
	// (providerRunActive, e.g. an omo wake turn). The provider refuses prompts
	// mid-turn; refusing here keeps the provider run's agent_settled able to
	// complete instead of leaking the run state. A live compaction owns the
	// session the same way.
	if s.promptInFlight || s.providerRunActive {
		s.mu.Unlock()
		s.lifecycleMu.Unlock()
		return ErrPromptInFlight
	}
	if s.compactionActive {
		s.mu.Unlock()
		s.lifecycleMu.Unlock()
		return ErrCompactionInFlight
	}
	s.promptSequence++
	promptSequence := s.promptSequence
	s.promptInFlight = true
	s.localCommandActive = false
	s.runDone = false
	s.finishedAt = time.Time{}
	s.lastStop = "stop"
	s.mu.Unlock()
	s.lifecycleMu.Unlock()
	if err := s.sendProvider(cmd); err != nil {
		s.lifecycleMu.Lock()
		s.mu.Lock()
		if s.promptInFlight && s.promptSequence == promptSequence {
			s.promptInFlight = false
			s.localCommandActive = false
			s.runDone = true
			s.finishedAt = time.Now()
		}
		s.mu.Unlock()
		s.lifecycleMu.Unlock()
		return err
	}
	return nil
}

func (s *Session) Steer(message string) error {
	return s.sendProvider(map[string]any{"type": "steer", "message": message})
}

func (s *Session) FollowUp(message string) error {
	return s.sendProvider(map[string]any{"type": "follow_up", "message": message})
}

func (s *Session) Abort() { _ = s.sendProvider(map[string]any{"type": "abort"}) }

// Compact invokes Omo's dedicated compaction RPC ({"type":"compact"}), never
// a "/compact" prompt. The generated RPC id correlates the eventual response;
// Omo's separate provider requestId is learned from compaction_start. The
// check-and-latch is atomic under lifecycleMu, but the provider write is not:
// a provider that stopped reading stdin must never block Close or reaping.
func (s *Session) Compact() error {
	s.lifecycleMu.Lock()
	s.mu.Lock()
	if s.promptInFlight || s.providerRunActive {
		s.mu.Unlock()
		s.lifecycleMu.Unlock()
		return ErrPromptInFlight
	}
	if s.compactionActive {
		s.mu.Unlock()
		s.lifecycleMu.Unlock()
		return ErrCompactionInFlight
	}
	s.nextCompactRPCSequence++
	rpcID := "compact-" + strconv.FormatUint(s.nextCompactRPCSequence, 10)
	s.compactionActive = true
	s.compactRPCID = rpcID
	if s.pendingCompactRPCs == nil {
		s.pendingCompactRPCs = make(map[string]struct{})
	}
	s.pendingCompactRPCs[rpcID] = struct{}{}
	s.compactionRequestID = ""
	s.finishedAt = time.Time{}
	s.mu.Unlock()
	s.lifecycleMu.Unlock()

	if err := s.sendProvider(map[string]any{"type": "compact", "id": rpcID}); err != nil {
		s.lifecycleMu.Lock()
		s.mu.Lock()
		delete(s.pendingCompactRPCs, rpcID)
		if s.compactionActive && s.compactRPCID == rpcID {
			s.rememberCompletedCompactionLocked(s.compactionRequestID)
			s.compactionActive = false
			s.compactRPCID = ""
			s.compactionRequestID = ""
			s.finishedAt = time.Now()
		}
		s.mu.Unlock()
		s.lifecycleMu.Unlock()
		return err
	}
	return nil
}

func (s *Session) RespondApproval(id, value string, confirmed, cancelled *bool, ack []byte) error {
	resp := map[string]any{"type": "extension_ui_response", "id": id}
	if cancelled != nil {
		resp["cancelled"] = *cancelled
	} else if confirmed != nil {
		resp["confirmed"] = *confirmed
	} else {
		resp["value"] = value
	}
	return s.sendControl(resp, ack)
}

func (s *Session) QueryCommands() error {
	return s.sendProvider(map[string]any{"type": "get_commands"})
}

func (s *Session) QueryStats() error {
	return s.sendProvider(map[string]any{"type": "get_session_stats"})
}

func (s *Session) QueryState() error { return s.sendProvider(map[string]any{"type": "get_state"}) }

func (s *Session) SetSessionName(name string) error {
	return s.sendProvider(map[string]any{"type": "set_session_name", "name": name})
}

func (s *Session) QueryModels() error {
	return s.sendProvider(map[string]any{"type": "get_available_models"})
}

// Initialize resumes the persisted provider session when one is known and
// bootstraps a fresh one otherwise.
func (s *Session) Initialize() error {
	s.mu.Lock()
	if s.shared != nil {
		s.mu.Unlock()
		return s.queryInitialState()
	}
	identity := s.piSessionID
	if identity != "" {
		s.resumePending = true
	}
	s.mu.Unlock()
	if identity != "" {
		if err := s.sendProvider(map[string]any{"type": "switch_session", "sessionPath": identity}); err != nil {
			s.mu.Lock()
			s.resumePending = false
			s.mu.Unlock()
			return err
		}
		return nil
	}
	return s.queryInitialState()
}

func (s *Session) queryInitialState() error {
	queries := []func() error{s.QueryState, s.QueryModels, s.QueryCommands, func() error { return s.Resume("") }}
	for _, query := range queries {
		if err := query(); err != nil {
			return err
		}
	}
	return nil
}

// clearResumeIdentity drops the stored provider identity in memory and asks
// the persistence callback to drop it from the store too, so a dead persisted
// session is never retried on the next reconnect.
func (s *Session) clearResumeIdentity() {
	s.mu.Lock()
	changed := s.piSessionID != ""
	s.piSessionID = ""
	callback := s.onResumeIdentity
	provider := s.provider
	s.mu.Unlock()
	if changed && callback != nil {
		if err := callback(s, ResumeIdentity{Provider: provider}); err != nil {
			s.send(&ErrorFrame{Type: "error", SessionID: s.id, Code: "persist_failed", Message: err.Error()})
		}
	}
}

func (s *Session) Resume(since string) error {
	cmd := map[string]any{"type": "get_entries"}
	s.mu.Lock()
	shared := s.shared
	s.mu.Unlock()
	if shared != nil {
		cmd["id"] = shared.requestID("entries")
	}
	if since != "" {
		cmd["since"] = since
	}
	return s.sendProvider(cmd)
}

func (s *Session) SetModel(provider, modelID, requestID string, ack []byte) error {
	cmd := map[string]any{"type": "set_model", "provider": provider, "modelId": modelID}
	if requestID != "" {
		cmd["id"] = requestID
	}
	return s.sendControl(cmd, ack)
}

func (s *Session) SetThinking(level, requestID string, ack []byte) error {
	cmd := map[string]any{"type": "set_thinking_level", "level": level}
	if requestID != "" {
		cmd["id"] = requestID
	}
	return s.sendControl(cmd, ack)
}
