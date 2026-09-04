// Package omorpc is the typed client-side protocol surface for the omo
// agent's Unix-socket RPC engine (v2 replacement of the stdio engine).
//
// Transport facts this package encodes:
//
//   - The agent listens on a Unix domain socket at <agentDir>/rpc/rpc.sock,
//     where agentDir defaults to ~/.omo/agent (env OMO_CODING_AGENT_DIR
//     overrides).
//   - Framing is UTF-8 newline-delimited JSON: one object per line,
//     LF-terminated. Decoders tolerate CRLF and fragmented reads.
//   - The client assigns a unique id per two-way request; the inbound record
//     carrying that id settles exactly that request. extension_ui_response
//     is one-way and its id is the native dialog id, passed through
//     unchanged.
//   - get_protocol_info, open_session, and list_sessions carry no sessionId.
//     close_session and every other session command are session-scoped;
//     responses, events, and extension_ui_request echo sessionId at top level.
//   - success:false responses carry an "error" string; stable codes are in
//     errors.go. There is no separate error frame.
package omorpc

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

const defaultMaxLineBytes = 4 << 20

// ErrFrameTooLarge reports a wire record larger than the configured decoder
// limit. The connection cannot be resynchronized safely after this error.
var ErrFrameTooLarge = errors.New("omorpc: frame exceeds maximum line length")

// Wire command names, verbatim on the socket.
const (
	CmdGetProtocolInfo = "get_protocol_info"
	CmdOpenSession     = "open_session"
	CmdCloseSession    = "close_session"
	CmdListSessions    = "list_sessions"

	CmdPrompt             = "prompt"
	CmdSteer              = "steer"
	CmdFollowUp           = "follow_up"
	CmdAbort              = "abort"
	CmdGetState           = "get_state"
	CmdGetAvailableModels = "get_available_models"
	CmdGetEntries         = "get_entries"
	CmdGetMessages        = "get_messages"
	CmdGetCommands        = "get_commands"
	CmdGetSessionStats    = "get_session_stats"
	CmdSetSessionName     = "set_session_name"
	CmdSetModel           = "set_model"
	CmdSetThinkingLevel   = "set_thinking_level"
	CmdCompact            = "compact"
	CmdSetAutoCompaction  = "set_auto_compaction"
	CmdExtensionRequest   = "extension_request"

	CmdExtensionUIResponse = "extension_ui_response"
)

// Prompt streaming behaviors: deliver the text while a run is active
// (steer) or queue it for when the run settles (followUp).
const (
	StreamingSteer    = "steer"
	StreamingFollowUp = "followUp"
)

// UnknownEventType is the normalized type of an unrecognized inbound event,
// with the original wire type preserved in UnknownEvent.EventType.
const UnknownEventType = "unknown"

// Response is the two-way reply envelope. Exactly one of Data (success) or
// Error (failure) is meaningful; Error is mapped to stable codes via Err.
type Response struct {
	ID        string          `json:"id"`
	SessionID string          `json:"sessionId,omitempty"`
	Command   string          `json:"command"`
	Success   bool            `json:"success"`
	Data      json.RawMessage `json:"data,omitempty"`
	Error     string          `json:"error,omitempty"`
	// Raw is the complete wire record this response was decoded from.
	Raw json.RawMessage `json:"-"`
}

// Event is an unsolicited inbound record: an agent lifecycle, streaming, or
// extension event that does not correlate with a pending request id. The
// event family is open-ended, so Type is the wire type verbatim (forward
// compatibility: never error on an unrecognized type — normalize via
// AsUnknownEvent) and Raw preserves the full record for typed unpacking.
type Event struct {
	Type      string `json:"type"`
	SessionID string `json:"sessionId,omitempty"`
	// Raw is the complete wire record this event was decoded from.
	Raw json.RawMessage `json:"-"`
}

// UnknownEvent is the forward-compatible envelope for an event type this
// client does not model: the original type and payload are preserved
// verbatim so nothing is lost across server upgrades.
type UnknownEvent struct {
	Type      string          `json:"type"` // always UnknownEventType
	EventType string          `json:"eventType"`
	Payload   json.RawMessage `json:"payload,omitempty"`
}

// AsUnknownEvent normalizes an unrecognized event into the UnknownEvent
// envelope, keeping the original wire type and record as the payload.
func AsUnknownEvent(ev *Event) *UnknownEvent {
	return &UnknownEvent{
		Type:      UnknownEventType,
		EventType: ev.Type,
		Payload:   json.RawMessage(append([]byte(nil), ev.Raw...)),
	}
}

// Inbound is one decoded wire record: either a correlated Response or an
// unsolicited Event. Exactly one field is non-nil.
type Inbound struct {
	Response *Response
	Event    *Event
}

// Command is the closed union of outbound commands. Concrete structs carry
// their own JSON-tagged fields; EncodeRequest flattens them with the
// correlation id and command type into one wire object.
type Command interface {
	commandName() string
}

// Notification is the closed union of one-way outbound records.
type Notification interface {
	Command
	notification()
}

// ---- Control commands (no sessionId) ----

// GetProtocolInfo is the handshake command; the reply's data payload is a
// ProtocolInfo.
type GetProtocolInfo struct{}

func (GetProtocolInfo) commandName() string { return CmdGetProtocolInfo }

// OpenSession opens a fresh session rooted at CWD or, when SessionPath is
// set, resumes the session stored at that file (durable id = file UUID).
// Observed engine contract: CWD is always sent when known, including on
// resume alongside SessionPath — session-scoped state keyed by working
// directory follows the explicit open_session cwd when present and falls
// back to the shared host process startup cwd when absent. An empty CWD
// stays omitted via omitempty. The reply's data payload is an
// OpenSessionData.
type OpenSession struct {
	CWD         string `json:"cwd,omitempty"`
	SessionPath string `json:"sessionPath,omitempty"`
}

func (OpenSession) commandName() string { return CmdOpenSession }

// CloseSession closes the session addressed by its epoch-local routing
// handle ("rpc-N").
type CloseSession struct {
	SessionID string `json:"sessionId"`
}

func (CloseSession) commandName() string { return CmdCloseSession }

// ListSessions enumerates the agent's live sessions.
type ListSessions struct{}

func (ListSessions) commandName() string { return CmdListSessions }

// ---- Session-scoped commands (required sessionId) ----

// Prompt sends a user message. StreamingBehavior optionally marks it as an
// in-run steer or a follow-up queued until the run settles.
type Prompt struct {
	SessionID         string              `json:"sessionId"`
	Message           string              `json:"message"`
	Images            []map[string]string `json:"images,omitempty"`
	StreamingBehavior string              `json:"streamingBehavior,omitempty"`
}

func (Prompt) commandName() string { return CmdPrompt }

// Steer injects a message into the active run without queuing it.
type Steer struct {
	SessionID string              `json:"sessionId"`
	Message   string              `json:"message"`
	Images    []map[string]string `json:"images,omitempty"`
}

func (Steer) commandName() string { return CmdSteer }

// FollowUp queues a message to run after the active run settles.
type FollowUp struct {
	SessionID string              `json:"sessionId"`
	Message   string              `json:"message"`
	Images    []map[string]string `json:"images,omitempty"`
}

func (FollowUp) commandName() string { return CmdFollowUp }

// Abort cancels the session's active run.
type Abort struct {
	SessionID string `json:"sessionId"`
}

func (Abort) commandName() string { return CmdAbort }

// GetState snapshots the session state (model, thinking level, message
// count, durable session file, ...).
type GetState struct {
	SessionID string `json:"sessionId"`
}

func (GetState) commandName() string { return CmdGetState }

// GetAvailableModels lists the models selectable for the session.
type GetAvailableModels struct {
	SessionID string `json:"sessionId"`
}

func (GetAvailableModels) commandName() string { return CmdGetAvailableModels }

// GetEntries returns the session's transcript entries. Since requests only
// entries after that cursor; the optional parameter is supported according to
// live protocol probing.
type GetEntries struct {
	SessionID string `json:"sessionId"`
	Since     string `json:"since,omitempty"`
}

func (GetEntries) commandName() string { return CmdGetEntries }

// GetMessages returns the session's messages.
type GetMessages struct {
	SessionID string `json:"sessionId"`
}

func (GetMessages) commandName() string { return CmdGetMessages }

// GetCommands lists the slash/dollar commands available to the session.
type GetCommands struct {
	SessionID string `json:"sessionId"`
}

func (GetCommands) commandName() string { return CmdGetCommands }

// GetSessionStats returns token and context statistics for the session.
type GetSessionStats struct {
	SessionID string `json:"sessionId"`
}

func (GetSessionStats) commandName() string { return CmdGetSessionStats }

// SetSessionName updates the durable display name of the session.
type SetSessionName struct {
	SessionID string `json:"sessionId"`
	Name      string `json:"name"`
}

func (SetSessionName) commandName() string { return CmdSetSessionName }

// SetModel switches the session's model.
type SetModel struct {
	SessionID string `json:"sessionId"`
	Provider  string `json:"provider"`
	ModelID   string `json:"modelId"`
}

func (SetModel) commandName() string { return CmdSetModel }

// SetThinkingLevel switches the session's thinking level (e.g. off, medium,
// high).
type SetThinkingLevel struct {
	SessionID string `json:"sessionId"`
	Level     string `json:"level"`
}

func (SetThinkingLevel) commandName() string { return CmdSetThinkingLevel }

// Compact triggers manual context compaction for the session.
type Compact struct {
	SessionID string `json:"sessionId"`
}

func (Compact) commandName() string { return CmdCompact }

// SetAutoCompaction enables or disables threshold/overflow auto compaction.
// Enabled must serialize even when false, so it carries no omitempty.
type SetAutoCompaction struct {
	SessionID string `json:"sessionId"`
	Enabled   bool   `json:"enabled"`
}

func (SetAutoCompaction) commandName() string { return CmdSetAutoCompaction }

// ExtensionRequest invokes a session extension method.
type ExtensionRequest struct {
	SessionID string          `json:"sessionId"`
	Name      string          `json:"name"`
	Data      json.RawMessage `json:"data,omitempty"`
}

func (ExtensionRequest) commandName() string { return CmdExtensionRequest }

// ExtensionUIResponse answers an inbound extension_ui_request. It is
// one-way: the server never replies to it and ID is the native dialog id,
// sent unchanged — never replaced with a client correlation id. Send it
// with EncodeNotification.
type ExtensionUIResponse struct {
	SessionID string          `json:"sessionId"`
	ID        string          `json:"id"`
	Value     json.RawMessage `json:"value,omitempty"`
	Confirmed *bool           `json:"confirmed,omitempty"`
	Cancelled bool            `json:"cancelled,omitempty"`
}

func (ExtensionUIResponse) commandName() string { return CmdExtensionUIResponse }
func (ExtensionUIResponse) notification()       {}

// ---- Typed data payloads ----

// ProtocolInfo is the data payload of the get_protocol_info response.
type ProtocolInfo struct {
	ProtocolVersion int      `json:"protocolVersion"`
	ServerVersion   string   `json:"serverVersion"`
	Capabilities    []string `json:"capabilities"`
	Mode            string   `json:"mode"`
}

// SessionState mirrors the durable state inside open_session's data payload.
// SessionID is the durable UUID stored in SessionFile — distinct from the
// epoch-local "rpc-N" routing handle the response envelope addresses.
type SessionState struct {
	SessionID     string          `json:"sessionId"`
	SessionFile   string          `json:"sessionFile,omitempty"`
	Model         json.RawMessage `json:"model,omitempty"`
	ThinkingLevel string          `json:"thinkingLevel,omitempty"`
	SessionName   string          `json:"sessionName,omitempty"`
	Entries       json.RawMessage `json:"entries,omitempty"`
	MessageCount  int             `json:"messageCount,omitempty"`
}

// OpenSessionData is the data payload of the open_session response.
type OpenSessionData struct {
	// SessionID is the epoch-local routing handle ("rpc-N") that all
	// subsequent session-scoped commands and replies address.
	SessionID string       `json:"sessionId"`
	State     SessionState `json:"state"`
}

// ---- Encoding ----

// EncodeFrame renders v as one wire frame: compact JSON terminated by
// exactly one LF.
func EncodeFrame(v any) ([]byte, error) {
	b, err := json.Marshal(v)
	if err != nil {
		return nil, fmt.Errorf("omorpc: encode frame: %w", err)
	}
	return append(b, '\n'), nil
}

// EncodeRequest renders a two-way request: the client-assigned correlation
// id, the command type, and the command's own fields flattened into one
// JSON object, LF-terminated.
func EncodeRequest(id string, cmd Command) ([]byte, error) {
	return encodeCommand(map[string]any{"id": id}, cmd)
}

// EncodeNotification renders a one-way record: no correlation id is
// injected, so a command like ExtensionUIResponse travels with its own
// native id untouched. LF-terminated.
func EncodeNotification(cmd Command) ([]byte, error) {
	return encodeCommand(map[string]any{}, cmd)
}

func encodeCommand(extra map[string]any, cmd Command) ([]byte, error) {
	raw, err := json.Marshal(cmd)
	if err != nil {
		return nil, fmt.Errorf("omorpc: encode %s: %w", cmd.commandName(), err)
	}
	m := make(map[string]any, len(extra)+8)
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, fmt.Errorf("omorpc: encode %s: %w", cmd.commandName(), err)
	}
	for k, v := range extra {
		m[k] = v
	}
	m["type"] = cmd.commandName()
	return EncodeFrame(m)
}

// NewRequestID returns a fresh correlation id for a two-way request.
func NewRequestID() string {
	var b [12]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(fmt.Sprintf("omorpc: request id entropy: %v", err))
	}
	return hex.EncodeToString(b[:])
}

// ---- Decoding ----

// DecodeLine classifies one wire record (a single JSON object; any
// surrounding CR/LF whitespace is tolerated). Records with
// type "response" become Inbound.Response; every other record — known or
// not — is an unsolicited Inbound.Event with its raw record preserved.
func DecodeLine(data []byte) (*Inbound, error) {
	data = bytes.Trim(data, "\r\n")
	if len(data) == 0 {
		return nil, errEmptyFrame
	}
	var probe struct {
		Type      string          `json:"type"`
		ID        string          `json:"id"`
		SessionID string          `json:"sessionId"`
		Command   json.RawMessage `json:"command"`
		Success   bool            `json:"success"`
		Data      json.RawMessage `json:"data"`
		Error     string          `json:"error"`
	}
	if err := json.Unmarshal(data, &probe); err != nil {
		return nil, fmt.Errorf("omorpc: decode frame: %w", err)
	}
	raw := json.RawMessage(append([]byte(nil), data...))
	if probe.Type == "response" {
		var command string
		if len(probe.Command) > 0 {
			if err := json.Unmarshal(probe.Command, &command); err != nil {
				return nil, fmt.Errorf("omorpc: decode frame: %w", err)
			}
		}
		return &Inbound{Response: &Response{
			ID:        probe.ID,
			SessionID: probe.SessionID,
			Command:   command,
			Success:   probe.Success,
			Data:      probe.Data,
			Error:     probe.Error,
			Raw:       raw,
		}}, nil
	}
	return &Inbound{Event: &Event{
		Type:      probe.Type,
		SessionID: probe.SessionID,
		Raw:       raw,
	}}, nil
}

// Decoder reads wire records from a stream, buffering fragmented reads and
// tolerating CRLF line endings.
//
// Buffering semantics for a stream that ends without a final LF: a trailing
// record that parses as a complete JSON object is accepted (the LF was lost,
// the record was not); a truncated record is reported as a
// "truncated trailing record" error rather than silently dropped.
type Decoder struct {
	br           *bufio.Reader
	maxLineBytes int
}

// NewDecoder wraps r with the default 4 MiB line limit.
func NewDecoder(r io.Reader) *Decoder {
	return NewDecoderWithLimit(r, defaultMaxLineBytes)
}

// NewDecoderWithLimit wraps r and rejects records larger than maxLineBytes.
func NewDecoderWithLimit(r io.Reader, maxLineBytes int) *Decoder {
	if maxLineBytes <= 0 {
		maxLineBytes = defaultMaxLineBytes
	}
	return &Decoder{br: bufio.NewReader(r), maxLineBytes: maxLineBytes}
}

// Decode returns the next record or io.EOF at a clean end of stream.
func (d *Decoder) Decode() (*Inbound, error) {
	line := make([]byte, 0, min(d.maxLineBytes, 64<<10))
	for {
		fragment, err := d.br.ReadSlice('\n')
		if len(line)+len(fragment) > d.maxLineBytes {
			return nil, ErrFrameTooLarge
		}
		line = append(line, fragment...)
		switch {
		case err == nil:
			return DecodeLine(line)
		case errors.Is(err, bufio.ErrBufferFull):
			continue
		case errors.Is(err, io.EOF) && len(line) > 0:
			in, derr := DecodeLine(line)
			if derr != nil {
				return nil, errUnexpectedTail(derr)
			}
			return in, nil
		default:
			return nil, err
		}
	}
}
