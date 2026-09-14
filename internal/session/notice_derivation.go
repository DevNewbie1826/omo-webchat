package session

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"math"
	"math/big"
	"strings"
)

// All derivations mirror the observed engine contract. lifecycleMu guards state.
type transcriptNoticeState struct {
	initialized        bool
	restored           bool
	source             string
	previous           *cacheRequest
	continuityDisabled bool
}

type cacheRequest struct {
	PromptTokens  float64 `json:"promptTokens"`
	ModelKey      string  `json:"modelKey"`
	Timestamp     float64 `json:"timestamp"`
	ReportedCache bool    `json:"reportedCache"`
}

// A checkpoint is scoped to the durable conversation, not its disposable RPC
// route. A nil Previous is meaningful: a real content boundary reset it.
type persistedTranscriptNoticeState struct {
	Previous           *cacheRequest `json:"previous,omitempty"`
	ContinuityDisabled bool          `json:"continuityDisabled,omitempty"`
	Source             string        `json:"source,omitempty"`
}

func (s *Session) restoreTranscriptNoticesLocked() {
	journal := s.manager.noticeJournal(s.chatID)
	journal.mu.Lock()
	defer journal.mu.Unlock()
	if state, ok := journal.transcripts[s.durableID]; ok {
		s.transcriptNotices = transcriptNoticeState{initialized: true, restored: true, source: state.Source, previous: state.Previous, continuityDisabled: state.ContinuityDisabled}
	}
}

func (s *Session) persistTranscriptNoticesLocked() {
	s.transcriptNotices.initialized = true
	s.transcriptNotices.restored = false
	journal := s.manager.noticeJournal(s.chatID)
	journal.mu.Lock()
	defer journal.mu.Unlock()
	if journal.retired {
		return
	}
	if journal.transcripts == nil {
		journal.transcripts = make(map[string]persistedTranscriptNoticeState)
	}
	journal.transcripts[s.durableID] = persistedTranscriptNoticeState{Previous: s.transcriptNotices.previous, ContinuityDisabled: s.transcriptNotices.continuityDisabled, Source: s.transcriptNotices.source}
	journal.persistLocked()
}

// Record even silent messages and boundaries; journal ring eviction must not
// make their source identities eligible for derivation again.
func (s *Session) admitTranscriptIdentityLocked(kind, identity string) bool {
	key := fmt.Sprintf("transcript:%x", sha256.Sum256([]byte(s.durableID+"\x00"+kind+"\x00"+identity)))
	journal := s.manager.noticeJournal(s.chatID)
	journal.mu.Lock()
	defer journal.mu.Unlock()
	if journal.retired || journal.derivations[key] {
		return false
	}
	if journal.derivations == nil {
		journal.derivations = make(map[string]bool)
	}
	journal.derivations[key] = true
	return true
}

func noticeNumber(value any) float64 { n, _ := value.(float64); return n }

// Decimal ties round upward in the observed engine contract, rather than
// Go's ties-to-even formatting. Preserve the exact binary value before rounding.
func noticeFixed(n float64, decimals int) string {
	value := new(big.Rat).SetFloat64(n)
	value.Mul(value, new(big.Rat).SetInt64(int64(math.Pow10(decimals))))
	whole, remainder := new(big.Int), new(big.Int)
	whole.QuoRem(value.Num(), value.Denom(), remainder)
	if remainder.Lsh(remainder, 1).Cmp(value.Denom()) >= 0 {
		whole.Add(whole, big.NewInt(1))
	}
	digits := whole.String()
	if decimals == 0 {
		return digits
	}
	if len(digits) <= decimals {
		digits = strings.Repeat("0", decimals+1-len(digits)) + digits
	}
	return digits[:len(digits)-decimals] + "." + digits[len(digits)-decimals:]
}

func noticeTokens(n float64) string {
	unit := ""
	for _, suffix := range []string{"K", "M", "B"} {
		if n < 1000 {
			break
		}
		n /= 1000
		unit = suffix
	}
	if unit != "" && n < 10 {
		return strings.TrimSuffix(noticeFixed(n, 1), ".0") + unit
	}
	return noticeFixed(n, 0) + unit
}

func noticeBytes(n float64) string {
	if n < 1024 {
		return noticeFixed(n, 0) + "B"
	}
	if n < 1024*1024 {
		return noticeFixed(n/1024, 1) + "KB"
	}
	return noticeFixed(n/(1024*1024), 1) + "MB"
}

func (s *Session) publishNoticeTextLocked(kind, text string) {
	s.publishLocked(Frame{Kind: FrameNotice, SessionID: s.durableID, Data: map[string]any{"kind": kind, "text": text}})
}

// The key lives beside the journal, not in the public payload, so rehydration
// cannot stamp a second identity for the same persisted entry after reopening.
func (s *Session) publishNoticeOnceLocked(key, kind, text string) {
	journal := s.manager.noticeJournal(s.chatID)
	journal.mu.Lock()
	defer journal.mu.Unlock()
	if journal.retired || journal.derivations[key] {
		return
	}
	if journal.derivations == nil {
		journal.derivations = make(map[string]bool)
	}
	journal.derivations[key] = true
	frame, admitted := stampNotice(s.chatID, journal, Frame{Kind: FrameNotice, SessionID: s.durableID, Data: map[string]any{"kind": kind, "text": text}})
	if admitted {
		s.broadcast.publish(frame)
	}
}

func (s *Session) deriveCompactionNoticesLocked(raw map[string]any) {
	result, ok := raw["result"].(map[string]any)
	if !ok || raw["accepted"] == false {
		return
	}
	s.transcriptNotices.previous = nil
	// This event has no entry identity. Until an identified source arrives,
	// older history cannot prove that it follows this live reset.
	s.transcriptNotices.source = ""
	s.persistTranscriptNoticesLocked()
	s.publishLocked(Frame{Kind: FrameNotice, SessionID: s.durableID, Data: map[string]any{"kind": "compaction_summary", "tokensBefore": result["tokensBefore"], "summary": result["summary"]}})
	usage, ok := result["usage"].(map[string]any)
	if !ok {
		return
	}
	total := noticeNumber(usage["input"]) + noticeNumber(usage["output"]) + noticeNumber(usage["cacheRead"]) + noticeNumber(usage["cacheWrite"])
	text := "Compaction: " + noticeTokens(total) + " tokens billed"
	cost, _ := usage["cost"].(map[string]any)
	if n := noticeNumber(cost["total"]); n >= 0.01 {
		text += " (~$" + noticeFixed(n, 2) + ")"
	}
	s.publishNoticeTextLocked("compaction_cost", text)
}

func (s *Session) deriveMessageNoticesLocked(raw map[string]any) {
	message, ok := raw["message"].(map[string]any)
	if !ok || message["role"] != "assistant" {
		return
	}
	// Completed messages need not have an ID on the wire. The complete payload
	// provides stable duplicate identity without conflating timestamps alone.
	identity, _ := json.Marshal(message)
	if id := stringValue(raw["messageId"]); id != "" {
		identity = []byte("messageId:" + id)
	} else if id := stringValue(message["id"]); id != "" {
		identity = []byte("id:" + id)
	}
	if !s.admitTranscriptIdentityLocked("message", string(identity)) {
		return
	}
	defer s.persistTranscriptNoticesLocked()
	s.transcriptNotices.source = transcriptMessageSource(message)
	diagnostics, _ := message["diagnostics"].([]any)
	s.deriveContinuityNoticeLocked(diagnostics)
	s.deriveCacheNoticeLocked(message)
	if message["stopReason"] == "aborted" || message["stopReason"] == "error" {
		return
	}
	var reasons []string
	for _, item := range diagnostics {
		diagnostic, _ := item.(map[string]any)
		if diagnostic["type"] != "anthropic_input_transformations" {
			continue
		}
		details, _ := diagnostic["details"].(map[string]any)
		transformations, _ := details["transformations"].([]any)
		for _, item := range transformations {
			transformation, _ := item.(map[string]any)
			if transformation["type"] != "thinking_dropped" {
				continue
			}
			reason, ok := transformation["reason"].(string)
			if !ok {
				reason = "unknown reason"
			}
			if path, ok := transformation["path"].(string); ok {
				reason += " at " + path
			}
			reasons = append(reasons, reason)
		}
	}
	if len(reasons) == 0 {
		return
	}
	label := "Anthropic dropped thinking block: "
	if len(reasons) > 1 {
		label = fmt.Sprintf("Anthropic dropped %d thinking blocks: ", len(reasons))
	}
	s.publishNoticeTextLocked("thinking_dropped", label+strings.Join(reasons, "; "))
}

func (s *Session) deriveContinuityNoticeLocked(diagnostics []any) {
	for _, item := range diagnostics {
		diagnostic, _ := item.(map[string]any)
		details, _ := diagnostic["details"].(map[string]any)
		text := ""
		switch diagnostic["type"] {
		case "claude_sdk_oauth_resume_fallback":
			text = "Session continuity lost - resume failed, resent the full conversation"
		case "claude_sdk_oauth_session_continuity":
			switch details["kind"] {
			case "flatten":
				text = "Session continuity lost - resent the full conversation"
			case "disabled":
				if s.transcriptNotices.continuityDisabled {
					return
				}
				s.transcriptNotices.continuityDisabled = true
				text = "Session continuity disabled (resumeMode: off) - resending the conversation each turn"
			}
		}
		if text == "" {
			continue
		}
		if reason, ok := details["reason"].(string); ok {
			text += " (" + reason + ")"
		}
		if size, ok := details["payloadBytes"].(float64); ok {
			text += " - sent " + noticeBytes(size)
		}
		if n := noticeNumber(details["collapsedDirectives"]); n > 0 {
			text += fmt.Sprintf(", %.0f duplicate ultrawork blocks collapsed", n)
		}
		s.publishNoticeTextLocked("continuity_notice", text)
		return
	}
}

// Fold usage without publishing; history reconstruction uses the same sticky
// cache rules in a candidate, never in the live detector.
func (state *transcriptNoticeState) foldCacheRequest(message map[string]any) *cacheRequest {
	usage, ok := message["usage"].(map[string]any)
	if !ok {
		return nil
	}
	read, write := noticeNumber(usage["cacheRead"]), noticeNumber(usage["cacheWrite"])
	prev := state.previous
	current := &cacheRequest{PromptTokens: noticeNumber(usage["input"]) + read + write, ModelKey: stringValue(message["provider"]) + "/" + stringValue(message["model"]), Timestamp: noticeNumber(message["timestamp"]), ReportedCache: read+write > 0}
	if prev != nil {
		current.ReportedCache = current.ReportedCache || prev.ReportedCache
	}
	state.previous = current
	return prev
}

func (s *Session) deriveCacheNoticeLocked(message map[string]any) {
	usage, ok := message["usage"].(map[string]any)
	if !ok {
		return
	}
	input, read, write := noticeNumber(usage["input"]), noticeNumber(usage["cacheRead"]), noticeNumber(usage["cacheWrite"])
	prompt := input + read + write
	prev := s.transcriptNotices.foldCacheRequest(message)
	current := s.transcriptNotices.previous
	if prev == nil || prompt <= 0 || !current.ReportedCache {
		return
	}
	missed := math.Min(prev.PromptTokens, prompt) - read
	if missed <= 1024 {
		return
	}
	cost, _ := usage["cost"].(map[string]any)
	paidRate := 0.0
	if input+write > 0 {
		paidRate = (noticeNumber(cost["input"]) + noticeNumber(cost["cacheWrite"])) / (input + write)
	}
	// Observed engine contract uses a catalog read rate without cache reads;
	// no catalog is on the wire, so this mirror's documented fallback is zero.
	readRate := 0.0
	if read > 0 {
		readRate = noticeNumber(cost["cacheRead"]) / read
	}
	missedCost := missed * (paidRate - readRate)
	if missed < 20000 && missedCost < 0.1 {
		return
	}
	label := "Cache miss"
	idle := math.Max(0, current.Timestamp-prev.Timestamp)
	if current.ModelKey != prev.ModelKey {
		label += " after model switch"
	} else if idle >= 300000 {
		label += fmt.Sprintf(" after %.0fm idle", math.Round(idle/60000))
	}
	text := label + ": " + noticeTokens(missed) + " tokens re-billed"
	if missedCost >= 0.01 {
		text += "(~$" + noticeFixed(missedCost, 2) + ")"
	}
	s.publishNoticeTextLocked("cache_miss", text)
}

func (s *Session) deriveEntryNoticeLocked(entry map[string]any) {
	switch entry["type"] {
	case "compaction", "branch_summary":
		if s.admitTranscriptIdentityLocked("boundary", stringValue(entry["id"])) {
			s.transcriptNotices.previous = nil
			s.transcriptNotices.source = "entry:" + stringValue(entry["id"])
			s.persistTranscriptNoticesLocked()
		}
	case "model_change_rejected":
		text, ok := entry["detail"].(string)
		if !ok {
			text = stringValue(entry["reason"])
		}
		if id := stringValue(entry["id"]); id != "" {
			s.publishNoticeOnceLocked("warning:"+id, "engine_warning", text)
		}
	}
}

// Process hydrated entry diagnostics and count compactions in a page. The
// complete disk count replaces active-branch totals before adding the live tail.
func (s *Session) deriveHistoryPageLocked(entries []json.RawMessage) int {
	count := 0
	for _, raw := range entries {
		var entry map[string]any
		if json.Unmarshal(raw, &entry) != nil {
			continue
		}
		s.deriveEntryNoticeLocked(entry)
		if entry["type"] == "compaction" {
			count++
		}
	}
	return count
}

// Message payloads are shared by completed events and persisted entries even
// when the enclosing event and entry use different IDs.
func transcriptMessageSource(message map[string]any) string {
	raw, _ := json.Marshal(message)
	return fmt.Sprintf("message:%x", sha256.Sum256(raw))
}

type transcriptNoticeReplay struct {
	transcriptNoticeState
	checkpointSeen bool
	boundaries     []string
}

// Reconstruct privately until the complete validated history succeeds. A
// restored checkpoint anchors the fold: only its suffix may advance state.
// An absent anchor means the checkpoint may be newer than hydrated history.
func (s *Session) deriveReplayPageLocked(entries []json.RawMessage, candidate *transcriptNoticeReplay) int {
	count := 0
	for _, raw := range entries {
		var entry map[string]any
		if json.Unmarshal(raw, &entry) != nil {
			continue
		}
		switch entry["type"] {
		case "compaction", "branch_summary":
			candidate.previous = nil
			candidate.source = "entry:" + stringValue(entry["id"])
			candidate.boundaries = append(candidate.boundaries, stringValue(entry["id"]))
			if entry["type"] == "compaction" {
				count++
			}
		case "message":
			if message, ok := entry["message"].(map[string]any); ok && message["role"] == "assistant" {
				candidate.foldCacheRequest(message)
				candidate.source = transcriptMessageSource(message)
			}
		default:
			s.deriveEntryNoticeLocked(entry)
		}
		if !candidate.checkpointSeen && s.transcriptNotices.restored && s.transcriptNotices.source != "" && candidate.source == s.transcriptNotices.source {
			candidate.transcriptNoticeState = s.transcriptNotices
			candidate.checkpointSeen = true
		}
	}
	return count
}

func (s *Session) deriveCompactionHistoryLocked(count int) {
	if count == 0 {
		return
	}
	unit := "times"
	if count == 1 {
		unit = "time"
	}
	s.publishNoticeOnceLocked("compaction_history", "compaction_history", fmt.Sprintf("Session compacted %d %s", count, unit))
}
