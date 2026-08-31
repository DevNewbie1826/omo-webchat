package chat

import (
	"encoding/json"
	"time"
)

func (s *Session) dispatch(ev Event) {
	switch ev.Type {
	case "extension_ui_request":
		s.forwardApproval(ev.Raw)
	case "high_reasoning_warning",
		"retry_fallback_applied",
		"retry_fallback_reverted",
		"retry_fallback_succeeded",
		"retry_fallback_exhausted",
		"server_fallback_aborted",
		"auto_retry_start",
		"auto_retry_end",
		"summarization_retry_attempt_start",
		"summarization_retry_scheduled",
		"summarization_retry_finished",
		"settings_source_selected":
		// Advisory events are transient: forward the raw payload as a notice,
		// kinded by the omo event type verbatim, never cached for replay.
		s.forwardNotice(ev.Type, advisoryNoticePayload(ev.Raw))
	case "message_update":
		s.forwardMessageDelta(ev.Raw)
	case "message_end":
		s.forwardMessage(ev.Raw)
	case "tool_execution_start":
		s.forwardTool(ev.Raw, "start")
	case "tool_execution_update":
		s.forwardTool(ev.Raw, "update")
	case "tool_execution_end":
		s.forwardTool(ev.Raw, "end")
	case "agent_start":
		s.beginProviderRun()
	case "agent_end":
		// Deliberately non-terminal: even willRetry:false can be followed by
		// compaction or a queued continuation. Only agent_settled completes a
		// run (omo contract REPORT.md, consequence 2).
	case "command_invocation":
		s.markLocalCommand(ev.Raw)
	case "agent_settled":
		s.completeRun()
	case "compaction_start":
		s.beginCompaction(ev.Raw)
	case "compaction_end":
		s.endCompaction(ev.Raw)
	case "commands_changed":
		s.refreshCommands(ev.Raw)
	case "session_info_changed":
		s.applySessionInfoChanged(ev.Raw)
	case "extension_event":
		s.forwardExtensionEvent(ev.Raw)
	case "response":
		s.forwardResponse(ev.Raw)
	case "entries.stream":
		s.deliverStreamedPage(ev.Page, ev.LeafID, ev.Final)
	case "decode_error":
		s.send(&ErrorFrame{Type: "error", SessionID: s.id, Code: "decode_failed", Message: rawString(ev.Raw)})
	}
}

// beginProviderRun arms a run for a provider-initiated turn (an omo wake or
// triggerTurn continuation) so its agent_settled emits run.done and the UI
// reflects responding. User-initiated turns (promptInFlight) are skipped:
// their run was already armed by SendPrompt, and a duplicate agent_start must
// not emit a second run.started.
func (s *Session) beginProviderRun() {
	s.lifecycleMu.Lock()
	defer s.lifecycleMu.Unlock()
	s.mu.Lock()
	if s.promptInFlight || s.providerRunActive {
		s.mu.Unlock()
		return
	}
	s.providerRunActive = true
	s.runDone = false
	s.finishedAt = time.Time{}
	s.mu.Unlock()
	s.send(&RunStartedFrame{Type: "run.started", SessionID: s.id})
}

// markLocalCommand records that the in-flight prompt was consumed by an
// extension-local command: omo handles it without an agent run, so the
// correlated prompt response — not agent_settled — completes the request.
// prompt/skill invocations dispatch into the agent and stay armed until
// agent_settled.
func (s *Session) markLocalCommand(raw json.RawMessage) {
	var ev struct {
		Command struct {
			Source string `json:"source"`
		} `json:"command"`
	}
	if json.Unmarshal(raw, &ev) != nil || ev.Command.Source != "extension" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.promptInFlight {
		s.localCommandActive = true
	}
}

// completeRun clears the in-flight run state and emits run.done exactly once
// per armed run. lifecycleMu stays held through frame delivery, so admission
// cannot arm the next run before the prior terminal frame is observable.
// Snapshot persistence is registered before frame delivery, then runs after
// lifecycleMu is released: store I/O never delays admission or run.done, while
// Close can drain every attempt whose completion was observable.
func (s *Session) completeRun() {
	s.lifecycleMu.Lock()
	s.mu.Lock()
	reason, completed := s.completeRunLocked()
	s.mu.Unlock()
	if completed {
		s.activityPersistence.Add(1)
		s.send(&RunDoneFrame{Type: "run.done", SessionID: s.id, Reason: reason})
	}
	s.lifecycleMu.Unlock()
	if completed {
		defer s.activityPersistence.Done()
		s.reconcileCachedActivity()
		s.persistActivitySnapshot()
	}
}

// completeRunLocked applies the run terminal transition. The caller holds
// lifecycleMu and mu, in that order.
func (s *Session) completeRunLocked() (string, bool) {
	if s.done || s.runDone || (!s.promptInFlight && !s.providerRunActive) {
		return "", false
	}
	s.runDone = true
	s.promptInFlight = false
	s.providerRunActive = false
	s.localCommandActive = false
	s.finishedAt = time.Now()
	return s.lastStop, true
}

// beginCompaction pairs each lifecycle with Omo's provider-generated
// requestId. A manual compact is already latched by Compact and learns its
// requestId here; an automatic compaction latches here. Duplicate, completed,
// and overlapping starts are ignored, so each accepted request emits one
// compaction.started frame.
func (s *Session) beginCompaction(raw json.RawMessage) {
	var ev struct {
		Reason    string `json:"reason"`
		RequestID string `json:"requestId"`
	}
	if json.Unmarshal(raw, &ev) != nil || ev.RequestID == "" {
		return
	}

	s.lifecycleMu.Lock()
	defer s.lifecycleMu.Unlock()
	s.mu.Lock()
	if _, completed := s.completedCompactionRequests[ev.RequestID]; completed {
		s.mu.Unlock()
		return
	}
	if s.compactionActive {
		// A manual RPC is latched before its start event. Once an active
		// requestId is known, every further start is duplicate or overlapping.
		if s.compactionRequestID != "" || s.compactRPCID == "" || ev.Reason != "manual" {
			s.mu.Unlock()
			return
		}
		s.compactionRequestID = ev.RequestID
	} else {
		// Omo emits reason:"manual" only for our Compact RPC. Once that RPC
		// has terminated, a delayed manual start must not create a new latch.
		if ev.Reason == "manual" {
			s.mu.Unlock()
			return
		}
		s.compactionActive = true
		s.compactionRequestID = ev.RequestID
		s.finishedAt = time.Time{}
	}
	s.mu.Unlock()
	s.send(&CompactionStartedFrame{Type: "compaction.started", SessionID: s.id})
}

// endCompaction accepts only the requestId bound by compaction_start. The
// state transition and terminal frame are serialized under lifecycleMu, so a
// stale or duplicate end cannot clear a newer operation or race admission.
func (s *Session) endCompaction(raw json.RawMessage) {
	var ev struct {
		RequestID    string `json:"requestId"`
		ErrorMessage string `json:"errorMessage"`
	}
	if json.Unmarshal(raw, &ev) != nil || ev.RequestID == "" {
		return
	}

	s.lifecycleMu.Lock()
	defer s.lifecycleMu.Unlock()
	s.mu.Lock()
	if !s.compactionActive || s.compactionRequestID != ev.RequestID {
		s.mu.Unlock()
		return
	}
	s.completeCompactionLocked()
	s.mu.Unlock()
	s.send(&CompactionDoneFrame{Type: "compaction.done", SessionID: s.id, Error: ev.ErrorMessage})
}

// finishCompactTransaction consumes exactly one response for a generated
// manual RPC id. Normally compaction_end has already closed the lifecycle; if
// it is absent, a matching response supplies the terminal fallback. A late A
// response may still publish A's correlated provider error, but can never
// mutate an active B transaction.
func (s *Session) finishCompactTransaction(responseID string, success bool, responseError string) {
	message := responseError
	if !success && message == "" {
		message = "provider request failed"
	}

	s.lifecycleMu.Lock()
	defer s.lifecycleMu.Unlock()
	s.mu.Lock()
	if _, handled := s.handledCompactRPCResponses[responseID]; responseID != "" && handled {
		s.mu.Unlock()
		return
	}
	if responseID != "" {
		if s.handledCompactRPCResponses == nil {
			s.handledCompactRPCResponses = make(map[string]struct{})
		}
		s.handledCompactRPCResponses[responseID] = struct{}{}
	}
	_, pending := s.pendingCompactRPCs[responseID]
	if pending {
		delete(s.pendingCompactRPCs, responseID)
	}
	matched := pending && s.compactionActive && s.compactRPCID == responseID
	if matched {
		s.completeCompactionLocked()
	}
	s.mu.Unlock()

	if matched {
		s.send(&CompactionDoneFrame{Type: "compaction.done", SessionID: s.id, Error: message})
	}
	if !success {
		s.send(&ErrorFrame{Type: "error", SessionID: s.id, Code: "provider_error", Message: message, Command: "compact", RequestID: responseID})
	}
}

// completeCompactionLocked closes the active compaction. The caller holds
// lifecycleMu and mu, in that order.
func (s *Session) completeCompactionLocked() {
	s.rememberCompletedCompactionLocked(s.compactionRequestID)
	s.compactionActive = false
	s.compactRPCID = ""
	s.compactionRequestID = ""
	if s.runDone && !s.promptInFlight && !s.providerRunActive {
		s.finishedAt = time.Now()
	}
}

func (s *Session) rememberCompletedCompactionLocked(requestID string) {
	if requestID == "" {
		return
	}
	if s.completedCompactionRequests == nil {
		s.completedCompactionRequests = make(map[string]struct{})
	}
	s.completedCompactionRequests[requestID] = struct{}{}
}

// refreshCommands forwards the authoritative command inventory carried by
// commands_changed through the normal commands frame path.
func (s *Session) refreshCommands(raw json.RawMessage) {
	s.sendCommands(raw)
}

func (s *Session) applySessionInfoChanged(raw json.RawMessage) {
	var ev struct {
		Name string `json:"name"`
	}
	if json.Unmarshal(raw, &ev) != nil || ev.Name == "" {
		return
	}
	s.mu.Lock()
	callback := s.onProviderName
	s.mu.Unlock()
	s.send(&NameFrame{Type: "chat.name", SessionID: s.id, Name: ev.Name, Origin: "provider"})
	if callback != nil {
		callback(s, ev.Name)
	}
}

// forwardExtensionEvent maps a provider extension_event to the client's
// extensionEvent frame. A nameless event cannot be routed by consumers and
// is dropped; name and data are otherwise passed through verbatim. The
// frame is delivered through the delivery barrier with the snapshot cache
// commit (rememberActivitySnapshot), so cache and broadcast are atomic.
func (s *Session) forwardExtensionEvent(raw json.RawMessage) {
	var ev struct {
		Name string          `json:"name"`
		Data json.RawMessage `json:"data"`
	}
	if json.Unmarshal(raw, &ev) != nil || ev.Name == "" {
		return
	}
	b, err := json.Marshal(&ExtensionEventFrame{Type: "extensionEvent", SessionID: s.id, Name: ev.Name, Data: ev.Data})
	if err != nil {
		return
	}
	s.barrier.Lock()
	defer s.barrier.Unlock()
	s.rememberActivitySnapshot(ev.Name, ev.Data)
	s.writeFrame(b)
}
