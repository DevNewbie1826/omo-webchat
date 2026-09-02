package session

import (
	"encoding/json"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

func (s *Session) dispatch(ev *omorpc.Event) {
	var raw map[string]any
	if json.Unmarshal(ev.Raw, &raw) != nil {
		return
	}
	s.lifecycleMu.Lock()
	defer s.lifecycleMu.Unlock()
	if s.closed || s.closing || s.resumable {
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
		s.providerRunActive = false
		s.promptInFlight = false
		s.localCommandActive = false
		s.promptResponse = false
		s.publishLocked(Frame{Kind: FrameRunDone, SessionID: s.durableID, Data: RunInfo{Reason: reason}})
		s.scheduleIdleLocked()
	case "command_invocation":
		if commandSource(raw) == "extension" && s.promptInFlight {
			s.localCommandActive = true
			s.localCommandSeq = s.promptSeq
			if s.promptResponse {
				s.completeLocalCommandLocked(s.promptSeq)
			}
		}
	case "message_delta", "message_update":
		s.publishLocked(Frame{Kind: FrameMessageDelta, SessionID: s.durableID, Data: eventPayload(raw)})
	case "message", "message_end":
		s.publishLocked(Frame{Kind: FrameMessage, SessionID: s.durableID, Data: eventPayload(raw)})
	case "tool", "tool_execution_start", "tool_execution_update", "tool_execution_end":
		payload := eventPayload(raw)
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
		s.invalidated = true
		s.resumable = true
		s.promptInFlight = false
		s.providerRunActive = false
		s.compactionActive = false
		s.localCommandActive = false
		s.cancelIdleLocked()
		s.publishLocked(Frame{Kind: FrameError, SessionID: s.durableID, Data: ErrorInfo{Code: "session_unloaded", Message: "provider unloaded the session"}})
	case "state", "state_changed":
		s.publishLocked(Frame{Kind: FrameState, SessionID: s.durableID, Data: eventPayload(raw)})
	case "session_info_changed":
		if name, _ := raw["name"].(string); name != "" {
			s.publishLocked(Frame{Kind: FrameName, SessionID: s.durableID, Data: map[string]any{"name": name, "origin": "provider"}})
		}
	case "commands_changed":
		s.publishLocked(Frame{Kind: FrameCommands, SessionID: s.durableID, Data: eventPayload(raw)})
	case "extension_event":
		s.forwardExtensionEventLocked(raw)
	case "extension_ui_request":
		s.publishLocked(Frame{Kind: FrameApproval, SessionID: s.durableID, RequestID: stringValue(raw["id"]), Data: eventPayload(raw)})
	case "entries.stream":
		s.deliverStreamedEntriesLocked(raw)
	case "high_reasoning_warning", "retry_fallback_applied", "retry_fallback_reverted", "retry_fallback_succeeded", "retry_fallback_exhausted", "server_fallback_aborted", "auto_retry_start", "auto_retry_end", "extension_notify":
		payload := eventPayload(raw)
		payload["kind"] = ev.Type
		s.publishLocked(Frame{Kind: FrameNotice, SessionID: s.durableID, Data: payload})
	}
}

func (s *Session) beginCompactionLocked(raw map[string]any) {
	id, _ := raw["requestId"].(string)
	if id != "" {
		if _, done := s.completedCompactions[id]; done {
			return
		}
	}
	phase, _ := raw["reason"].(string)
	if phase == "" {
		phase = "manual"
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
	if s.compactProviderID != "" && id != s.compactProviderID {
		return
	}
	errText, _ := raw["errorMessage"].(string)
	requestID := id
	if requestID == "" {
		requestID = s.compactRPCID
	}
	s.rememberCompletedCompactionLocked(s.compactRPCID, id)
	phase := s.compactPhase
	s.compactionActive = false
	s.compactRPCID = ""
	s.compactProviderID = ""
	s.publishLocked(Frame{Kind: FrameCompactionDone, SessionID: s.durableID, RequestID: requestID, Data: CompactionInfo{Phase: phase, Error: errText}})
	s.scheduleIdleLocked()
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
	}
	s.publishLocked(Frame{Kind: FrameExtensionEvent, SessionID: s.durableID, Data: extensionFrameData(name, dataBytes, s.activityOversized[name])})
}

func (s *Session) deliverStreamedEntriesLocked(raw map[string]any) {
	entries, leaf, final := decodeEntries(raw)
	pages := chunkEntries(entries)
	if len(pages) == 0 {
		pages = [][]json.RawMessage{{}}
	}
	for i, page := range pages {
		pageFinal := final && i == len(pages)-1
		pageLeaf := ""
		if pageFinal {
			pageLeaf = leaf
		}
		s.publishLocked(Frame{Kind: FrameEntries, SessionID: s.durableID, Data: EntriesFrame{Entries: page, LeafID: pageLeaf, Final: pageFinal}})
	}
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
