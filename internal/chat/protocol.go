package chat

import "encoding/json"

type Frame struct {
	Type      string          `json:"type"`
	SessionID string          `json:"sessionId,omitempty"`
	Raw       json.RawMessage `json:"-"`
}

type ReadyFrame struct {
	Type        string `json:"type"`
	SessionID   string `json:"sessionId"`
	PiSessionID string `json:"piSessionId"`
	Resumed     bool   `json:"resumed"`
}

type MessageDeltaFrame struct {
	Type      string         `json:"type"`
	SessionID string         `json:"sessionId"`
	MessageID string         `json:"messageId,omitempty"`
	Delta     AssistantDelta `json:"delta"`
}

type AssistantDelta struct {
	Kind         string          `json:"kind"`
	ContentIndex int             `json:"contentIndex,omitempty"`
	Delta        string          `json:"delta,omitempty"`
	Content      string          `json:"content,omitempty"`
	Reason       string          `json:"reason,omitempty"`
	Partial      json.RawMessage `json:"partial,omitempty"`
}

type MessageFrame struct {
	Type      string       `json:"type"`
	SessionID string       `json:"sessionId"`
	Message   AssistantMsg `json:"message"`
}

type AssistantMsg struct {
	Role       string          `json:"role"`
	CustomType string          `json:"customType,omitempty"`
	Blocks     []ContentBlock  `json:"blocks,omitempty"`
	Model      string          `json:"model,omitempty"`
	Usage      json.RawMessage `json:"usage,omitempty"`
	TS         int64           `json:"ts,omitempty"`
}

type ContentBlock struct {
	Kind     string          `json:"kind"`
	Text     string          `json:"text,omitempty"`
	Thinking string          `json:"thinking,omitempty"`
	ID       string          `json:"id,omitempty"`
	Name     string          `json:"name,omitempty"`
	Args     json.RawMessage `json:"arguments,omitempty"`
}

type ToolFrame struct {
	Type       string          `json:"type"`
	SessionID  string          `json:"sessionId"`
	ToolCallID string          `json:"toolCallId"`
	ToolName   string          `json:"toolName"`
	Phase      string          `json:"phase"`
	Args       json.RawMessage `json:"args,omitempty"`
	Partial    json.RawMessage `json:"partial,omitempty"`
	Result     json.RawMessage `json:"result,omitempty"`
	IsError    bool            `json:"isError,omitempty"`
}

type StateFrame struct {
	Type          string       `json:"type"`
	SessionID     string       `json:"sessionId"`
	Model         *ModelOption `json:"model,omitempty"`
	ThinkingLevel string       `json:"thinkingLevel,omitempty"`
	IsStreaming   bool         `json:"isStreaming"`
	IsCompacting  bool         `json:"isCompacting"`
	SessionName   string       `json:"sessionName,omitempty"`
	MessageCount  int          `json:"messageCount,omitempty"`
}

type NameFrame struct {
	Type      string `json:"type"`
	SessionID string `json:"sessionId"`
	Name      string `json:"name"`
	Origin    string `json:"origin"`
}

type StatsFrame struct {
	Type         string          `json:"type"`
	SessionID    string          `json:"sessionId"`
	Tokens       json.RawMessage `json:"tokens,omitempty"`
	Cost         float64         `json:"cost,omitempty"`
	ContextUsage json.RawMessage `json:"contextUsage,omitempty"`
}

type ApprovalFrame struct {
	Type        string   `json:"type"`
	SessionID   string   `json:"sessionId"`
	ID          string   `json:"id"`
	Method      string   `json:"method"`
	Title       string   `json:"title,omitempty"`
	Message     string   `json:"message,omitempty"`
	Options     []string `json:"options,omitempty"`
	Prefill     string   `json:"prefill,omitempty"`
	Placeholder string   `json:"placeholder,omitempty"`
	Timeout     int      `json:"timeout,omitempty"`
}

type CommandsFrame struct {
	Type      string         `json:"type"`
	SessionID string         `json:"sessionId"`
	Commands  []CommandEntry `json:"commands"`
}

// CommandSourceInfo mirrors Omo's get_commands sourceInfo record: where the
// command was discovered and at what scope.
type CommandSourceInfo struct {
	Path    string `json:"path,omitempty"`
	BaseDir string `json:"baseDir,omitempty"`
	Source  string `json:"source,omitempty"`
	Scope   string `json:"scope,omitempty"`
	Origin  string `json:"origin,omitempty"`
}

// CommandEntry is one get_commands entry in Omo's real schema: {name,
// description, source, syntax, sourceInfo}. Extension commands are
// source:"extension",syntax:"slash"; prompt templates source:"prompt";
// skills are renamed "skill:<name>" with source:"skill",syntax:"dollar".
type CommandEntry struct {
	Name        string             `json:"name"`
	Description string             `json:"description,omitempty"`
	Source      string             `json:"source,omitempty"`
	Syntax      string             `json:"syntax,omitempty"`
	SourceInfo  *CommandSourceInfo `json:"sourceInfo,omitempty"`
}

type EntriesFrame struct {
	Type      string          `json:"type"`
	SessionID string          `json:"sessionId"`
	Entries   json.RawMessage `json:"entries"`
	LeafID    string          `json:"leafId,omitempty"`
	// Final marks the last page of a paged entries delivery. Always emitted:
	// false means more pages follow, true completes the load.
	Final bool `json:"final"`
}

type ModelOption struct {
	Provider string   `json:"provider"`
	ModelID  string   `json:"modelId"`
	Name     string   `json:"name,omitempty"`
	Input    []string `json:"input,omitempty"`
}

type ModelsFrame struct {
	Type      string        `json:"type"`
	SessionID string        `json:"sessionId"`
	Models    []ModelOption `json:"models"`
}

type RunDoneFrame struct {
	Type      string `json:"type"`
	SessionID string `json:"sessionId"`
	Reason    string `json:"reason"`
}

// ExtensionEventFrame forwards a provider extension_event to WebSocket
// clients. Omo only emits extension events to RPC clients whose
// SENPI_RPC_CLIENT_CAPABILITIES list carries extension_events (injected by
// EnsureExtensionEventsCapability); name and data pass through verbatim.
type ExtensionEventFrame struct {
	Type      string          `json:"type"` // "extensionEvent"
	SessionID string          `json:"sessionId"`
	Name      string          `json:"name"`
	Data      json.RawMessage `json:"data,omitempty"`
}

// NoticeFrame forwards an advisory to WebSocket clients. Kind is
// the omo event type verbatim (advisory family) or "extension_notify" (an
// extension_ui_request with method notify); payload is the raw event object
// passed through, null when absent. At is the server receipt time
// (RFC3339Nano) stamped for every notice: durable kinds replay it from the
// session log and persist it, transient kinds carry it once and are then
// gone.
type NoticeFrame struct {
	Type      string          `json:"type"` // "notice"
	SessionID string          `json:"sessionId"`
	Kind      string          `json:"kind"`
	Payload   json.RawMessage `json:"payload"`
	At        string          `json:"at"`
	NID       string          `json:"nid,omitempty"`
}

// CompactionStartedFrame reports a provider compaction_start (manual or
// automatic reason threshold|overflow; manual compaction uses reason manual) to
// the client's compaction surface.
type CompactionStartedFrame struct {
	Type      string `json:"type"` // "compaction.started"
	SessionID string `json:"sessionId"`
}

// CompactionDoneFrame is the terminal compaction frame: exactly one per
// compaction, carrying the provider's errorMessage when the compaction
// failed. It is emitted by compaction_end, or by the compact RPC response
// when the provider failed to emit a terminal event.
type CompactionDoneFrame struct {
	Type      string `json:"type"` // "compaction.done"
	SessionID string `json:"sessionId"`
	Error     string `json:"error,omitempty"`
}

type RunStartedFrame struct {
	Type      string `json:"type"` // "run.started"
	SessionID string `json:"sessionId"`
}

type ErrorFrame struct {
	Type      string `json:"type"`
	SessionID string `json:"sessionId,omitempty"`
	Code      string `json:"code,omitempty"`
	Message   string `json:"message"`
	Command   string `json:"command,omitempty"`
	RequestID string `json:"requestId,omitempty"`
	// Dangling reports that the failed resume used a stored identity whose
	// absolute session path no longer exists on disk. Omitted for failures
	// where the stored file is still present.
	Dangling bool `json:"dangling,omitempty"`
	// StoredIdentity echoes the stored resume identity verbatim when the
	// resume failure is dangling; never a replacement for it.
	StoredIdentity string `json:"storedIdentity,omitempty"`
	// BranchCandidates lists in-file branch sessions recovered from the
	// workspace's session files that may hold the lost conversation.
	BranchCandidates []SessionBranchCandidate `json:"branchCandidates,omitempty"`
}

// SessionBranchCandidate is one in-file branch session found while scanning
// workspace session files for a chat whose stored session file went missing:
// Omo records branch sessions as session_info lines inside another session's
// JSONL instead of standalone files, so the host path plus the record's
// id/parentId are the only recoverable coordinates.
type SessionBranchCandidate struct {
	ID       string `json:"id"`
	ParentID string `json:"parentId,omitempty"`
	Name     string `json:"name"`
	HostPath string `json:"hostPath"`
}

// ControlResultFrame reports the provider's typed outcome for a control
// command (set_model, set_thinking_level). It is correlated by the client
// requestId echoed by the provider, and—because it is delivered through the
// session barrier—always reaches the client after the acceptance ack.
type ControlResultFrame struct {
	Type      string `json:"type"`
	SessionID string `json:"sessionId"`
	Command   string `json:"command"`
	RequestID string `json:"requestId,omitempty"`
	Success   bool   `json:"success"`
	Message   string `json:"message,omitempty"`
}

type ClientFrame struct {
	Type      string          `json:"type"`
	SessionID string          `json:"sessionId,omitempty"`
	RequestID string          `json:"requestId,omitempty"`
	Raw       json.RawMessage `json:"-"`
}

func ParseClientFrame(data []byte) (*ClientFrame, error) {
	var cf ClientFrame
	if err := json.Unmarshal(data, &cf); err != nil {
		return nil, err
	}
	cf.Raw = data
	return &cf, nil
}
