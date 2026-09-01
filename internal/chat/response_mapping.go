package chat

import (
	"encoding/json"
	"time"
)

func (s *Session) forwardResponse(raw json.RawMessage) {
	var resp struct {
		Command   string          `json:"command"`
		Success   bool            `json:"success"`
		Data      json.RawMessage `json:"data"`
		Error     string          `json:"error"`
		ID        string          `json:"id"`
		SessionID string          `json:"sessionId"`
	}
	if json.Unmarshal(raw, &resp) != nil {
		return
	}
	if resp.Command == "switch_session" && s.finishResume(resp.Success, resp.Data, resp.Error) {
		return
	}
	if resp.Command == "set_model" || resp.Command == "set_thinking_level" {
		s.sendControlResult(resp.Command, resp.ID, resp.Success, resp.Error)
		return
	}
	if resp.Command == "set_session_name" {
		return
	}
	if !resp.Success {
		message := resp.Error
		if message == "" {
			message = "provider request failed"
		}
		switch resp.Command {
		case "prompt":
			s.failPrompt(message, resp.ID)
			return
		case "compact":
			s.finishCompactTransaction(resp.ID, false, message)
			return
		}
		s.send(&ErrorFrame{Type: "error", SessionID: s.id, Code: "provider_error", Message: message, Command: resp.Command, RequestID: resp.ID})
		return
	}
	switch resp.Command {
	case "close_session":
		// Responses to webchat-requested closes carry an id and are consumed by
		// sharedProvider.route's pending-request path before session dispatch.
		// A dispatched close is therefore the engine's unsolicited idle-eviction
		// notice. Detach it locally: the engine has already deleted the session.
		s.mu.Lock()
		provider := s.shared
		handle := s.routingHandle
		s.mu.Unlock()
		if provider == nil || handle == "" || resp.SessionID != handle {
			return
		}
		var route *sessionRoute
		if s.owner != nil {
			route = s.owner.evictRoutedSession(provider, handle, s)
		} else {
			provider.mu.Lock()
			route = provider.detachSessionLocked(handle, s)
			provider.mu.Unlock()
		}
		if route == nil {
			return
		}
		route.activate()
		close(route.queue)
		provider.clearRoutingHandle(s, handle)
		s.providerExited(providerTermination{kind: providerTerminationIdleEviction, summary: "provider unloaded idle session"})
	case "prompt":
		s.completeLocalCommand()
	case "compact":
		s.finishCompactTransaction(resp.ID, true, "")
	case "get_state":
		s.sendState(resp.Data)
	case "get_session_stats":
		s.sendStats(resp.Data)
	case "get_commands":
		s.sendCommands(resp.Data)
	case "get_available_models":
		s.sendModels(resp.Data)
	case "get_entries":
		s.sendEntries(resp.Data)
	case "new_session", "switch_session":
		s.capturePiSessionID(resp.Data)
	}
}

// completeLocalCommand finishes a prompt that was consumed by an omo
// extension-local command. Such commands emit command_invocation{source:
// "extension"} and no agent lifecycle, so the successful prompt response is
// the authoritative completion. Every other successful prompt response is
// only preflight acceptance: the run starts at agent_start and completes at
// agent_settled.
func (s *Session) completeLocalCommand() {
	s.lifecycleMu.Lock()
	defer s.lifecycleMu.Unlock()
	s.mu.Lock()
	if !s.localCommandActive {
		s.mu.Unlock()
		return
	}
	reason, completed := s.completeRunLocked()
	s.mu.Unlock()
	if completed {
		s.send(&RunDoneFrame{Type: "run.done", SessionID: s.id, Reason: reason})
	}
}

// failPrompt publishes the provider rejection in the same lifecycle critical
// section that rolls back the prompt latch. A new prompt cannot overtake the
// terminal error and make it appear to reject the newer operation.
func (s *Session) failPrompt(message, requestID string) {
	s.lifecycleMu.Lock()
	defer s.lifecycleMu.Unlock()
	s.mu.Lock()
	if s.promptInFlight {
		s.promptInFlight = false
		s.localCommandActive = false
		s.runDone = true
		s.finishedAt = time.Now()
	}
	s.mu.Unlock()
	s.send(&ErrorFrame{Type: "error", SessionID: s.id, Code: "provider_error", Message: message, Command: "prompt", RequestID: requestID})
}

func (s *Session) finishResume(success bool, data json.RawMessage, responseError string) bool {
	s.mu.Lock()
	pending := s.resumePending
	if pending {
		s.resumePending = false
	}
	s.mu.Unlock()
	if !pending {
		return false
	}
	var result struct {
		Cancelled bool `json:"cancelled"`
	}
	_ = json.Unmarshal(data, &result)
	if !success || result.Cancelled {
		s.clearResumeIdentity()
		message := responseError
		if message == "" {
			message = "provider declined the persisted session"
		}
		s.send(&ErrorFrame{Type: "error", SessionID: s.id, Code: "resume_failed", Message: message})
		if err := s.queryInitialState(); err != nil {
			s.send(&ErrorFrame{Type: "error", SessionID: s.id, Code: "initialize_failed", Message: err.Error()})
		}
		return true
	}
	s.capturePiSessionID(data)
	if err := s.queryInitialState(); err != nil {
		s.send(&ErrorFrame{Type: "error", SessionID: s.id, Code: "initialize_failed", Message: err.Error()})
	}
	return true
}

func (s *Session) sendState(data json.RawMessage) {
	var d struct {
		Model         json.RawMessage `json:"model"`
		ThinkingLevel string          `json:"thinkingLevel"`
		IsStreaming   bool            `json:"isStreaming"`
		IsCompacting  bool            `json:"isCompacting"`
		SessionName   string          `json:"sessionName"`
		MessageCount  int             `json:"messageCount"`
	}
	if json.Unmarshal(data, &d) != nil {
		return
	}
	s.capturePiSessionID(data)
	s.send(&StateFrame{
		Type:          "state",
		SessionID:     s.id,
		Model:         normalizeModel(d.Model),
		ThinkingLevel: d.ThinkingLevel,
		IsStreaming:   d.IsStreaming,
		IsCompacting:  d.IsCompacting,
		SessionName:   d.SessionName,
		MessageCount:  d.MessageCount,
	})
}

func (s *Session) sendStats(data json.RawMessage) {
	var d struct {
		Tokens       json.RawMessage `json:"tokens"`
		Cost         float64         `json:"cost"`
		ContextUsage json.RawMessage `json:"contextUsage"`
	}
	if json.Unmarshal(data, &d) != nil {
		return
	}
	s.send(&StatsFrame{Type: "stats", SessionID: s.id, Tokens: d.Tokens, Cost: d.Cost, ContextUsage: d.ContextUsage})
}

func (s *Session) sendCommands(data json.RawMessage) {
	var d struct {
		Commands []CommandEntry `json:"commands"`
	}
	if json.Unmarshal(data, &d) != nil {
		return
	}
	s.send(&CommandsFrame{Type: "commands", SessionID: s.id, Commands: d.Commands})
}

func (s *Session) sendEntries(data json.RawMessage) {
	var d struct {
		Entries json.RawMessage `json:"entries"`
		LeafID  string          `json:"leafId"`
	}
	if json.Unmarshal(data, &d) != nil {
		s.sendEntriesPaged(nil, "")
		return
	}
	var entries []json.RawMessage
	if json.Unmarshal(d.Entries, &entries) != nil {
		return
	}
	s.sendEntriesPaged(entries, d.LeafID)
}

func normalizeModel(raw json.RawMessage) *ModelOption {
	var model struct {
		Provider string   `json:"provider"`
		ID       string   `json:"id"`
		ModelID  string   `json:"modelId"`
		Name     string   `json:"name"`
		Input    []string `json:"input"`
	}
	if json.Unmarshal(raw, &model) != nil {
		return nil
	}
	if model.ModelID == "" {
		model.ModelID = model.ID
	}
	if model.Provider == "" && model.ModelID == "" && model.Name == "" {
		return nil
	}
	return &ModelOption{Provider: model.Provider, ModelID: model.ModelID, Name: model.Name, Input: model.Input}
}

func (s *Session) sendModels(data json.RawMessage) {
	var d struct {
		Models []json.RawMessage `json:"models"`
	}
	if json.Unmarshal(data, &d) != nil {
		return
	}
	models := make([]ModelOption, 0, len(d.Models))
	for _, raw := range d.Models {
		if model := normalizeModel(raw); model != nil {
			models = append(models, *model)
		}
	}
	s.send(&ModelsFrame{Type: "models", SessionID: s.id, Models: models})
}

func (s *Session) capturePiSessionID(data json.RawMessage) {
	var d struct {
		SessionID   string `json:"sessionId"`
		SessionFile string `json:"sessionFile"`
		SessionPath string `json:"sessionPath"`
		Path        string `json:"path"`
	}
	if json.Unmarshal(data, &d) != nil {
		return
	}
	identity := d.SessionFile
	if identity == "" {
		identity = d.SessionPath
	}
	if identity == "" {
		identity = d.Path
	}
	if identity == "" {
		identity = d.SessionID
	}
	if identity == "" {
		return
	}
	s.mu.Lock()
	changed := identity != s.piSessionID
	s.piSessionID = identity
	callback := s.onResumeIdentity
	suppressed := s.identityPersistSuppressed
	s.mu.Unlock()
	if !suppressed && changed && callback != nil {
		if err := callback(s, ResumeIdentity{Provider: s.provider, Value: identity}); err != nil {
			s.send(&ErrorFrame{Type: "error", SessionID: s.id, Code: "persist_failed", Message: err.Error()})
		}
	}
}
