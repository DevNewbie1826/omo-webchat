package session

import (
	"bytes"
	"encoding/json"
	"slices"

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
		// Dedicated mappings keep the float64 decode above, including its
		// failure (the event is dropped). Known shown notice kinds and shown
		// custom entry_appended events still re-decode losslessly so an
		// overflowing number cannot drop a published line. Unmapped events
		// stay silent.
		if ev.Type == "entry_appended" {
			s.lifecycleMu.Lock()
			defer s.lifecycleMu.Unlock()
			if s.closed || s.resumable || s.closing {
				return
			}
			s.publishShownCustomEntryLocked(ev)
			return
		}
		if !transcriptNoticeKind(ev.Type) {
			return
		}
		s.lifecycleMu.Lock()
		defer s.lifecycleMu.Unlock()
		if s.closed || s.resumable || s.closing {
			return
		}
		s.publishVerbatimNoticeLocked(ev)
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
		s.observeLiveActivityLocked()
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
		s.observeLiveActivityLocked()
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
		if ev.Type == "message_end" {
			s.deriveMessageNoticesLocked(raw)
		}
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
		s.observeLiveActivityLocked()
		s.beginCompactionLocked(raw)
	case "compaction_end", "compaction_done":
		s.endCompactionLocked(ev.Type, raw)
		if ev.Type == "compaction_end" {
			s.deriveCompactionNoticesLocked(raw)
		}
	case "session_unloaded", "session_closed":
		// Provider lifecycle notices only invalidate the epoch-local routing
		// handle. The durable chat remains attached and reopens lazily when a
		// user-required operation next enters the per-chat flight.
		s.markProviderUnloadedLocked()
	case "response":
		command, _ := raw["command"].(string)
		success, _ := raw["success"].(bool)
		if command == omorpc.CmdCloseSession && success {
			s.markProviderUnloadedLocked()
		}
		if command == omorpc.CmdExtensionUIResponse && !success {
			// Notify has no RPC correlation. A provider rejection therefore
			// arrives as an unsolicited response, possibly after our write ack.
			s.resolveApprovalLocked(stringValue(raw["id"]), "", "expired", errApprovalExpired.Error())
			s.publishLocked(Frame{Kind: FrameError, SessionID: s.durableID, Command: command, Data: ErrorInfo{Code: "provider_error", Message: stringValue(raw["error"])}})
		}
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
	case "extension_error":
		payload := map[string]any{"kind": "extension_error", "extensionPath": raw["extensionPath"], "error": raw["error"]}
		if event, present := raw["event"]; present {
			payload["event"] = event
		}
		s.publishLocked(Frame{Kind: FrameNotice, SessionID: s.durableID, Data: payload})
	case "extension_ui_request":
		if stringValue(raw["method"]) == "notify" {
			if goalActivationNotify(raw) {
				// Observed engine behavior: goal activation belongs in the goal bar.
				return
			}
			// Fire-and-forget announcements (turn stats lines, ...) render as
			// transcript lines in the engine TUI (observed engine behavior), so
			// they mirror to exactly one journaled notice, never a pending ask.
			payload := map[string]any{"kind": "engine_notify", "message": stringValue(raw["message"])}
			if notifyType, present := raw["notifyType"]; present {
				payload["notifyType"] = notifyType
			}
			s.publishLocked(Frame{Kind: FrameNotice, SessionID: s.durableID, Data: payload})
			return
		}
		awaitsAnswer, known := approvalAwaitsAnswer(stringValue(raw["method"]))
		payload := eventPayload(raw)
		delete(payload, "awaitsAnswer")
		if known {
			payload["awaitsAnswer"] = awaitsAnswer
		}
		frame := Frame{Kind: FrameApproval, SessionID: s.durableID, RequestID: stringValue(raw["requestId"]), ApprovalID: stringValue(raw["id"]), Data: payload}
		// Interactive methods await a client answer; retain the latest one so a
		// subscriber attaching after the broadcast still sees the pending ask.
		if awaitsAnswer || !known {
			if s.activeApprovals == nil {
				s.activeApprovals = make(map[string]struct{})
			}
			s.activeApprovals[frame.ApprovalID] = struct{}{}
			s.pendingApproval = &frame
		}
		s.publishLocked(frame)
	case "question_resolved":
		id := stringValue(raw["id"])
		if _, active := s.activeApprovals[id]; active {
			outcome := stringValue(raw["outcome"])
			message := ""
			if outcome != "answered" {
				message = errApprovalExpired.Error()
			}
			s.resolveApprovalLocked(id, "", outcome, message)
		}
	case "question_updated":
		if s.pendingApproval != nil && s.pendingApproval.ApprovalID == stringValue(raw["id"]) {
			if data, ok := s.pendingApproval.Data.(map[string]any); ok {
				updated := make(map[string]any, len(data)+2)
				for key, value := range data {
					updated[key] = value
				}
				if deadline, present := raw["deadlineAtMs"]; present {
					updated["deadlineAtMs"] = deadline
				}
				if remaining, present := raw["remainingMs"]; present {
					updated["remainingMs"] = remaining
				}
				frame := *s.pendingApproval
				frame.Data = updated
				s.pendingApproval = &frame
				s.publishLocked(frame)
			}
		}
	case "entries.stream":
		s.deliverStreamedEntriesLocked(raw)
	case "turn_start", "turn_end", "agent_idle", "loaded_surfaces_changed", "message_start",
		"tool_hook_status", "thinking_level_changed":
		// Transcript-silent (observed engine behavior): lifecycle markers and
		// footer/status-only events render no transcript rows, so neither does
		// the notice feed.
	case "entry_appended":
		entry, _ := raw["entry"].(map[string]any)
		s.rememberRecentMessageEntryLocked(entry)
		s.deriveEntryNoticeLocked(entry)
		s.publishShownCustomEntryLocked(ev)
	case "continuation_error":
		// Observed wire event: the engine's continuation failure text is the
		// event payload. Publish it as a durable notice, verbatim.
		s.publishVerbatimNoticeLocked(ev)
	default:
		// Strict engine-UI mirror: only the known shown notice kinds publish.
		// Unmapped engine events stay silent.
		if transcriptNoticeKind(ev.Type) {
			s.publishVerbatimNoticeLocked(ev)
		}
	}
}

func transcriptNoticeKind(eventType string) bool {
	switch eventType {
	case "high_reasoning_warning",
		"retry_fallback_applied",
		"retry_fallback_reverted",
		"retry_fallback_succeeded",
		"retry_fallback_exhausted",
		"server_fallback_aborted",
		"auto_retry_start",
		"auto_retry_end",
		"extension_notify",
		"continuation_error":
		return true
	default:
		return false
	}
}

func decodeLosslessObject(raw json.RawMessage) (map[string]any, bool) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var lossless map[string]any
	if dec.Decode(&lossless) != nil {
		return nil, false
	}
	return lossless, true
}

func (s *Session) publishVerbatimNoticeLocked(ev *omorpc.Event) {
	lossless, ok := decodeLosslessObject(ev.Raw)
	if !ok {
		return
	}
	payload := eventPayload(lossless)
	payload["kind"] = ev.Type
	s.publishLocked(Frame{Kind: FrameNotice, SessionID: s.durableID, Data: payload})
}

func (s *Session) completeProviderRunLocked(reason string) {
	s.reconcileActivityCacheLocked()
	// Provider-run settlement bounds automatic compaction only. Manual
	// compaction remains owned by its correlated RPC completion.
	if s.compactionActive && s.compactRPCID == "" {
		s.finishCompactionLocked("", "")
	}
	s.providerRunActive = false
	s.promptInFlight = false
	s.localCommandActive = false
	s.promptResponse = false
	s.runAtLoss = false
	s.workAtLoss = s.compactionActive
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
	// A new automatic cycle renews anonymous diagnostic identity only. Named
	// failures remain identifiable replays even while a successor is active.
	s.compactionDiagnostics = slices.DeleteFunc(s.compactionDiagnostics, func(key [2]string) bool {
		return key[0] == ""
	})
	s.compactionActive = true
	s.compactSeq++
	s.compactProviderID = id
	s.compactRPCID = ""
	s.compactPhase = phase
	s.cancelIdleLocked()
	s.publishLocked(Frame{Kind: FrameCompactionStart, SessionID: s.durableID, RequestID: id, Data: CompactionInfo{Phase: phase}})
}

func (s *Session) endCompactionLocked(eventType string, raw map[string]any) {
	id, _ := raw["requestId"].(string)
	errText, _ := raw["errorMessage"].(string)
	reason, _ := raw["reason"].(string)
	willRetry, hasWillRetry := raw["willRetry"].(bool)
	exhausted := eventType == "compaction_end" && reason == "overflow" && hasWillRetry && !willRetry && errText != ""
	_, completed := s.completedCompactions[id]
	matches := s.compactionActive && !completed
	// An empty ID cannot correlate a manual RPC. Automatic recovery also
	// cannot own a manual successor, even before its provider ID is paired.
	if s.compactRPCID != "" && (id == "" || (reason != "" && reason != "manual")) {
		matches = false
	}
	if id != "" && s.compactProviderID != "" && id != s.compactProviderID {
		matches = false
	}
	if matches {
		s.observeLiveActivityLocked()
		if exhausted {
			s.rememberCompactionDiagnosticLocked(id, errText)
		}
		s.finishCompactionLocked(id, errText)
		return
	}
	// Recovery can end with an explicit error after its compaction already
	// completed for a retry. Preserve that diagnostic without completing any
	// current lifecycle; matched errors already have a compaction.done UI.
	if exhausted && s.rememberCompactionDiagnosticLocked(id, errText) {
		payload := eventPayload(raw)
		payload["kind"] = "compaction_error"
		payload["message"] = errText
		s.publishLocked(Frame{Kind: FrameNotice, SessionID: s.durableID, Data: payload})
	}
}

// rememberCompactionDiagnosticLocked records presentation independently of
// lifecycle IDs. Its callers only pass explicit exhausted-overflow terminals,
// so request ID and unchanged error text identify a replay across cycles.
// Absent IDs are cycle-local. Successful retrying ends are never recorded.
func (s *Session) rememberCompactionDiagnosticLocked(id, errText string) bool {
	key := [2]string{id, errText}
	for _, previous := range s.compactionDiagnostics {
		if previous == key {
			return false
		}
	}
	if len(s.compactionDiagnostics) == maxCompletedCompactions {
		copy(s.compactionDiagnostics, s.compactionDiagnostics[1:])
		s.compactionDiagnostics[len(s.compactionDiagnostics)-1] = key
	} else {
		s.compactionDiagnostics = append(s.compactionDiagnostics, key)
	}
	return true
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
	s.compactionAtLoss = false
	s.workAtLoss = s.workAtLoss && (s.providerRunActive || s.promptInFlight || s.localCommandActive)
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
	switch name {
	case activitySnapshotOrder[0]:
		accepted := s.taskSnapshots.merge(dataBytes, s.activitySnapshots[name], s.taskDigest)
		s.activitySnapshots[name] = accepted.replay
		s.activityOversized[name] = accepted.oversized
		s.taskDigest = accepted.digest
		dataBytes = accepted.live
	case activitySnapshotOrder[1]:
		accepted, err := s.dagSnapshots.merge(dataBytes, s.activitySnapshots[name], s.dagDigest)
		if err != nil {
			return
		}
		s.activitySnapshots[name] = accepted.replay
		s.activityOversized[name] = accepted.oversized
		s.dagDigest = accepted.digest
		dataBytes = accepted.live
		s.taskSnapshots.observe(accepted.accepted)
		s.reconcileActivityCacheLocked()
	}
	if name == activitySnapshotOrder[0] || name == activitySnapshotOrder[1] {
		running, total := s.refreshExactCountsLocked()
		dataBytes = addActivityCounts(dataBytes, name, &s.taskSnapshots, &s.dagSnapshots, running, total)
	}
	s.publishLocked(Frame{Kind: FrameExtensionEvent, SessionID: s.durableID, Data: extensionFrameData(name, dataBytes, s.activityOversized[name])})
	if (name == activitySnapshotOrder[0] || name == activitySnapshotOrder[1]) && s.manager != nil {
		s.manager.notifySessionOverviewLocked(s)
	}
}

func (s *Session) deliverStreamedEntriesLocked(raw map[string]any) {
	entries, leaf, final := decodeEntries(raw)
	s.deriveHistoryPageLocked(entries)
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

// approvalAwaitsAnswer classifies known methods for both publication and replay.
// Unknown methods carry no classification and are not retained as pending asks.
func approvalAwaitsAnswer(method string) (awaitsAnswer, known bool) {
	switch method {
	case "select", "confirm", "input", "editor", "question":
		return true, true
	case "notify",
		"setStatus",
		"setWidget":
		return false, true
	default:
		return false, false
	}
}

// transcriptShownCustomTypes documents observed engine behavior: these are the
// custom entry types the engine transcript renders, so only they mirror into
// the notice feed. Unknown customTypes stay transcript-silent.
var transcriptShownCustomTypes = []string{}

// publishShownCustomEntryLocked mirrors the engine transcript rules for a
// custom entry (observed engine behavior): a shown customType becomes exactly
// one journaled notice whose payload is the display fields. Keys from
// entry.data are hoisted to the top level; session envelope keys (type, id,
// parentId, timestamp, customType) are dropped because kind already carries
// the customType. If data is absent or not an object, remaining non-envelope
// entry fields are carried instead. Every other entry_appended payload stays
// silent. Numbers come from a lossless re-decode of ev.Raw so literals
// survive as json.Number rather than float64.
func (s *Session) publishShownCustomEntryLocked(ev *omorpc.Event) {
	raw, ok := decodeLosslessObject(ev.Raw)
	if !ok {
		return
	}
	entry, _ := raw["entry"].(map[string]any)
	if entry["type"] != "custom" {
		return
	}
	customType := stringValue(entry["customType"])
	if !slices.Contains(transcriptShownCustomTypes, customType) {
		return
	}
	payload := make(map[string]any)
	if data, ok := entry["data"].(map[string]any); ok {
		for k, v := range data {
			payload[k] = v
		}
	} else {
		for k, v := range entry {
			switch k {
			case "type", "id", "parentId", "timestamp", "customType":
				continue
			}
			payload[k] = v
		}
	}
	payload["kind"] = customType
	s.publishLocked(Frame{Kind: FrameNotice, SessionID: s.durableID, Data: payload})
}

func stringValue(v any) string { x, _ := v.(string); return x }

// rememberRecentMessageEntryLocked maps the canonical transformed message
// payload of a message entry to its durable id so the replay drain can
// recognize the live frame whose entry a history page already delivered.
// Observed engine order: message_end precedes entry persistence and
// entry_appended, so the entry id confirms which live frames a replayed page
// covers. Only ids appended while this session object observed the event are
// remembered. Engines that never emit entry_appended, or mutate the message
// between the wire event and persistence, leave frames unmatched — those
// deliver, preserving pre-dedup behavior.
func (s *Session) rememberRecentMessageEntryLocked(entry map[string]any) {
	if entry["type"] != "message" {
		return
	}
	id := stringValue(entry["id"])
	if id == "" {
		return
	}
	canonical, err := json.Marshal(messagePayload(entry))
	if err != nil {
		return
	}
	if s.recentMessageEntries == nil {
		s.recentMessageEntries = make(map[string]string)
	}
	key := string(canonical)
	// Latest append wins: an identical payload completing twice maps to the
	// newest entry, so a replayed-page match can never drop the newer frame.
	_, known := s.recentMessageEntries[key]
	s.recentMessageEntries[key] = id
	if !known {
		s.recentMessageEntryFIFO = append(s.recentMessageEntryFIFO, key)
		if len(s.recentMessageEntryFIFO) > maxRecentMessageEntries {
			oldest := s.recentMessageEntryFIFO[0]
			s.recentMessageEntryFIFO = s.recentMessageEntryFIFO[1:]
			delete(s.recentMessageEntries, oldest)
		}
	}
}

// recentMessageEntryID is the drain-time dedup decider: it canonicalizes a
// FrameMessage payload exactly as rememberRecentMessageEntryLocked
// canonicalized the entry (json.Marshal sorts map keys, so equal messages
// encode identically) and reports the appended entry id it maps to. It takes
// the lifecycle lock; callers must hold no replayMu (established order:
// lifecycleMu then replayMu, never nested the other way).
func (s *Session) recentMessageEntryID(data any) (string, bool) {
	canonical, err := json.Marshal(data)
	if err != nil {
		return "", false
	}
	s.lifecycleMu.Lock()
	defer s.lifecycleMu.Unlock()
	id, ok := s.recentMessageEntries[string(canonical)]
	return id, ok
}
func decodeEntries(raw map[string]any) ([]json.RawMessage, string, bool) {
	b, _ := json.Marshal(raw["entries"])
	var entries []json.RawMessage
	_ = json.Unmarshal(b, &entries)
	leaf, _ := raw["leafId"].(string)
	final, _ := raw["final"].(bool)
	return entries, leaf, final
}

// entryIDs extracts the durable entry ids of one history page.
func entryIDs(entries []json.RawMessage) []string {
	ids := make([]string, 0, len(entries))
	for _, raw := range entries {
		var entry struct {
			ID string `json:"id"`
		}
		if json.Unmarshal(raw, &entry) == nil && entry.ID != "" {
			ids = append(ids, entry.ID)
		}
	}
	return ids
}
