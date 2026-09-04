package session

import (
	"encoding/json"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

func (s *Session) dispatchEpoch(epoch omorpc.EpochToken, ev *omorpc.Event) {
	if epoch != s.epoch {
		return
	}
	s.dispatch(ev)
}

func (s *Session) dispatch(ev *omorpc.Event) {
	var raw map[string]any
	if json.Unmarshal(ev.Raw, &raw) != nil {
		return
	}
	if ev.Type == "session_info_changed" {
		name, _ := raw["name"].(string)
		s.applyProviderName(name)
		return
	}
	if ev.Type == omorpc.EventQueueUpdate {
		update, err := omorpc.ParseQueueUpdate(ev)
		if err != nil {
			return
		}
		s.lifecycleMu.Lock()
		if !s.closed && !s.resumable {
			s.engineQueue = EngineQueueSnapshot{PendingMessageCount: update.PendingMessageCount, Ordered: append([]omorpc.QueuedMessage(nil), update.Ordered...)}
		}
		s.lifecycleMu.Unlock()
		if s.manager != nil {
			if callback := s.manager.cfg.OnQueueUpdate; callback != nil {
				callback(s.chatID, s)
			}
		}
		return
	}
	s.lifecycleMu.Lock()
	defer s.lifecycleMu.Unlock()
	if s.closed || s.resumable {
		return
	}
	if s.closing {
		if ev.Type == "agent_settled" && !s.closeRunSettled && (s.providerRunActive || s.promptInFlight || s.localCommandActive) {
			s.closeRunSettled = true
			s.closeRunReason, _ = raw["reason"].(string)
		}
		return
	}

	switch ev.Type {
	case "agent_start":
		if !s.providerRunActive {
			s.providerRunActive = true
			s.cancelIdleLocked()
			s.publishLocked(Frame{Kind: FrameRunStarted, SessionID: s.durableID})
		}
	case "agent_end":
		// agent_settled is the sole provider-run terminal.
	case "agent_settled":
		if !s.providerRunActive && !s.promptInFlight {
			return
		}
		reason, _ := raw["reason"].(string)
		s.completeProviderRunLocked(reason)
	case "command_invocation":
		if commandSource(raw) == "extension" && s.promptInFlight {
			s.localCommandActive = true
			s.localCommandSeq = s.promptSeq
			if s.promptResponse {
				s.completeLocalCommandLocked(s.promptSeq)
			}
		}
	case "message_delta", "message_update":
		s.publishLocked(Frame{Kind: FrameMessageDelta, SessionID: s.durableID, Data: messageDeltaPayload(raw)})
	case "message", "message_end":
		s.publishLocked(Frame{Kind: FrameMessage, SessionID: s.durableID, Data: messagePayload(raw)})
	case "tool", "tool_execution_start", "tool_execution_update", "tool_execution_end":
		payload := eventPayload(raw)
		if partial, ok := payload["partialResult"]; ok {
			payload["partial"] = partial
			delete(payload, "partialResult")
		}
		if _, ok := payload["phase"]; !ok {
			switch ev.Type {
			case "tool_execution_start":
				payload["phase"] = "start"
			case "tool_execution_update":
				payload["phase"] = "update"
			case "tool_execution_end":
				payload["phase"] = "end"
			}
		}
		s.publishLocked(Frame{Kind: FrameTool, SessionID: s.durableID, Data: payload})
	case "compaction_start":
		s.beginCompactionLocked(raw)
	case "compaction_end", "compaction_done":
		s.endCompactionLocked(raw)
	case "session_unloaded":
		s.markProviderUnloadedLocked()
		s.publishLocked(Frame{Kind: FrameError, SessionID: s.durableID, Data: ErrorInfo{Code: "session_unloaded", Message: "provider unloaded the session"}})
	case "state", "state_changed":
		payload := eventPayload(raw)
		if model, ok := payload["model"].(map[string]any); ok {
			model = cloneAnyMap(model)
			if id, ok := model["id"]; ok {
				model["modelId"] = id
				delete(model, "id")
			}
			payload["model"] = model
		}
		payload["isStreaming"] = s.promptInFlight || s.providerRunActive || s.localCommandActive
		payload["isCompacting"] = s.compactionActive
		s.publishLocked(Frame{Kind: FrameState, SessionID: s.durableID, Data: payload})
	case "commands_changed":
		s.publishLocked(Frame{Kind: FrameCommands, SessionID: s.durableID, Data: eventPayload(raw)})
	case "extension_event":
		s.forwardExtensionEventLocked(raw)
	case "extension_ui_request":
		s.publishLocked(Frame{Kind: FrameApproval, SessionID: s.durableID, RequestID: stringValue(raw["requestId"]), ApprovalID: stringValue(raw["id"]), Data: eventPayload(raw)})
	case "entries.stream":
		s.deliverStreamedEntriesLocked(raw)
	case "high_reasoning_warning", "retry_fallback_applied", "retry_fallback_reverted", "retry_fallback_succeeded", "retry_fallback_exhausted", "server_fallback_aborted", "auto_retry_start", "auto_retry_end", "extension_notify":
		payload := eventPayload(raw)
		payload["kind"] = ev.Type
		s.publishLocked(Frame{Kind: FrameNotice, SessionID: s.durableID, Data: payload})
	}
}

func (s *Session) completeProviderRunLocked(reason string) {
	s.reconcileActivityCacheLocked(s.activitySnapshots[activitySnapshotOrder[1]])
	// Provider-run settlement bounds automatic compaction only. Manual
	// compaction remains owned by its correlated RPC completion.
	if s.compactionActive && s.compactRPCID == "" {
		s.finishCompactionLocked("", "")
	}
	s.providerRunActive = false
	s.promptInFlight = false
	s.localCommandActive = false
	s.promptResponse = false
	s.publishLocked(Frame{Kind: FrameRunDone, SessionID: s.durableID, Data: RunInfo{Reason: reason}})
	s.scheduleIdleLocked()
	s.notifyRunSettledLocked()
}

func (s *Session) reconcileFailedCloseLocked() {
	if !s.closeRunSettled {
		return
	}
	reason := s.closeRunReason
	s.closeRunSettled = false
	s.closeRunReason = ""
	s.completeProviderRunLocked(reason)
}

func (s *Session) beginCompactionLocked(raw map[string]any) {
	id, _ := raw["requestId"].(string)
	phase, _ := raw["reason"].(string)
	if phase == "" {
		phase = "manual"
	}
	if id != "" {
		if _, done := s.completedCompactions[id]; done {
			return
		}
		// Only a manual-eligible start can pair with the oldest unpaired manual
		// tombstone; threshold and overflow always latch their own transaction.
		if phase == "manual" && len(s.completedUnpaired) > 0 {
			s.completedUnpaired = s.completedUnpaired[1:]
			s.rememberCompletedCompactionLocked(id)
			return
		}
	}
	if s.compactionActive {
		if s.compactProviderID == "" {
			s.compactProviderID = id
		}
		return
	}
	// A manual transaction is opened synchronously by Compact. A manual start
	// arriving after its correlated response is therefore a delayed duplicate.
	if phase == "manual" {
		return
	}
	s.compactionActive = true
	s.compactSeq++
	s.compactProviderID = id
	s.compactRPCID = ""
	s.compactPhase = phase
	s.cancelIdleLocked()
	s.publishLocked(Frame{Kind: FrameCompactionStart, SessionID: s.durableID, RequestID: id, Data: CompactionInfo{Phase: phase}})
}

func (s *Session) endCompactionLocked(raw map[string]any) {
	id, _ := raw["requestId"].(string)
	if id != "" {
		if _, done := s.completedCompactions[id]; done {
			return
		}
	}
	if !s.compactionActive {
		return
	}
	// An empty requestId is only a safe fallback for provider-initiated
	// compaction. It cannot correlate a manual compaction RPC and may belong
	// to an older transaction.
	if id == "" && s.compactRPCID != "" {
		return
	}
	if id != "" && s.compactProviderID != "" && id != s.compactProviderID {
		return
	}
	errText, _ := raw["errorMessage"].(string)
	s.finishCompactionLocked(id, errText)
}

func (s *Session) finishCompactionLocked(requestID, errText string) {
	if requestID == "" {
		requestID = s.compactRPCID
	}
	if requestID == "" {
		requestID = s.compactProviderID
	}
	s.rememberCompletedCompactionLocked(s.compactRPCID, s.compactProviderID, requestID)
	phase := s.compactPhase
	s.compactionActive = false
	s.compactRPCID = ""
	s.compactProviderID = ""
	s.publishLocked(Frame{Kind: FrameCompactionDone, SessionID: s.durableID, RequestID: requestID, Data: CompactionInfo{Phase: phase, Error: errText}})
	s.scheduleIdleLocked()
	if !s.promptInFlight && !s.providerRunActive && !s.localCommandActive {
		s.notifyRunSettledLocked()
	}
}

func (s *Session) forwardExtensionEventLocked(raw map[string]any) {
	name, _ := raw["name"].(string)
	if name == "" {
		return
	}
	dataBytes, err := json.Marshal(raw["data"])
	if err != nil {
		return
	}
	var parent struct {
		ParentSessionID string `json:"parent_session_id"`
	}
	_ = json.Unmarshal(dataBytes, &parent)
	if parent.ParentSessionID != "" && parent.ParentSessionID != s.durableID {
		return
	}
	if name == activitySnapshotOrder[0] || name == activitySnapshotOrder[1] {
		oversized := len(dataBytes) > maxActivitySnapshotBytes
		s.activityOversized[name] = oversized
		if !oversized {
			s.activitySnapshots[name] = append(json.RawMessage(nil), dataBytes...)
		}
		// Digests retain at most maxActivityDigestEntries rows, including when
		// the raw payload is too large for the 64 KiB replay cache.
		switch name {
		case activitySnapshotOrder[0]:
			if digest, ok := parseTaskDigest(dataBytes); ok {
				s.taskDigest = digest
			}
		case activitySnapshotOrder[1]:
			if digest, ok := parseDagDigest(dataBytes); ok {
				s.dagDigest = digest
			}
			s.reconcileActivityCacheLocked(dataBytes)
		}
	}
	s.publishLocked(Frame{Kind: FrameExtensionEvent, SessionID: s.durableID, Data: extensionFrameData(name, dataBytes, s.activityOversized[name])})
	if (name == activitySnapshotOrder[0] || name == activitySnapshotOrder[1]) && s.manager != nil {
		s.manager.notifySessionOverviewLocked(s)
	}
}

func (s *Session) deliverStreamedEntriesLocked(raw map[string]any) {
	entries, leaf, final := decodeEntries(raw)
	s.publishEntriesPageLocked(entries, leaf, final)
}

func messageDeltaPayload(raw map[string]any) map[string]any {
	if nested, ok := raw["assistantMessageEvent"].(map[string]any); ok {
		delta := cloneAnyMap(nested)
		if kind, ok := delta["type"]; ok {
			delta["kind"] = kind
			delete(delta, "type")
		}
		out := map[string]any{"delta": delta}
		if id, ok := raw["messageId"].(string); ok && id != "" {
			out["messageId"] = id
		}
		return out
	}
	return eventPayload(raw)
}

func messagePayload(raw map[string]any) map[string]any {
	message, ok := raw["message"].(map[string]any)
	if !ok {
		return eventPayload(raw)
	}
	message = cloneAnyMap(message)
	if content, ok := message["content"].([]any); ok {
		blocks := make([]any, 0, len(content))
		for _, item := range content {
			if block, ok := item.(map[string]any); ok {
				block = cloneAnyMap(block)
				if kind, ok := block["type"]; ok {
					block["kind"] = kind
					delete(block, "type")
				}
				blocks = append(blocks, block)
			} else {
				blocks = append(blocks, item)
			}
		}
		message["blocks"] = blocks
		delete(message, "content")
	}
	return map[string]any{"message": message}
}

func cloneAnyMap(in map[string]any) map[string]any {
	out := make(map[string]any, len(in))
	for key, value := range in {
		out[key] = value
	}
	return out
}

func eventPayload(raw map[string]any) map[string]any {
	out := make(map[string]any, len(raw))
	for k, v := range raw {
		if k != "type" && k != "sessionId" {
			out[k] = v
		}
	}
	return out
}
func commandSource(raw map[string]any) string {
	c, _ := raw["command"].(map[string]any)
	x, _ := c["source"].(string)
	return x
}
func stringValue(v any) string { x, _ := v.(string); return x }
func decodeEntries(raw map[string]any) ([]json.RawMessage, string, bool) {
	b, _ := json.Marshal(raw["entries"])
	var entries []json.RawMessage
	_ = json.Unmarshal(b, &entries)
	leaf, _ := raw["leafId"].(string)
	final, _ := raw["final"].(bool)
	return entries, leaf, final
}
