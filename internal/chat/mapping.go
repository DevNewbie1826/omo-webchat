package chat

import "encoding/json"

func (s *Session) forwardApproval(raw json.RawMessage) {
	var req struct {
		ID          string   `json:"id"`
		Method      string   `json:"method"`
		Title       string   `json:"title"`
		Message     string   `json:"message"`
		Options     []string `json:"options"`
		Prefill     string   `json:"prefill"`
		Placeholder string   `json:"placeholder"`
		Timeout     int      `json:"timeout"`
	}
	if json.Unmarshal(raw, &req) != nil {
		return
	}
	switch req.Method {
	case "select", "confirm", "input", "editor":
	case "notify":
		payload, err := json.Marshal(noticePayload{ID: req.ID, Message: req.Message, Title: req.Title})
		if err != nil {
			return
		}
		s.forwardNotice("extension_notify", payload)
		return
	default:
		return
	}
	s.send(&ApprovalFrame{
		Type:        "approval",
		SessionID:   s.id,
		ID:          req.ID,
		Method:      req.Method,
		Title:       req.Title,
		Message:     req.Message,
		Options:     req.Options,
		Prefill:     req.Prefill,
		Placeholder: req.Placeholder,
		Timeout:     req.Timeout,
	})
}

// noticePayload is the extension_notify notice body: only the fields the
// request actually carries appear in the marshaled payload.
type noticePayload struct {
	ID      string `json:"id,omitempty"`
	Message string `json:"message,omitempty"`
	Title   string `json:"title,omitempty"`
}

func (s *Session) forwardMessageDelta(raw json.RawMessage) {
	var ev struct {
		AssistantMessageEvent struct {
			Type         string          `json:"type"`
			ContentIndex int             `json:"contentIndex"`
			Delta        string          `json:"delta"`
			Content      string          `json:"content"`
			Reason       string          `json:"reason"`
			Partial      json.RawMessage `json:"partial"`
		} `json:"assistantMessageEvent"`
	}
	if json.Unmarshal(raw, &ev) != nil {
		return
	}
	d := ev.AssistantMessageEvent
	s.send(&MessageDeltaFrame{
		Type:      "messageDelta",
		SessionID: s.id,
		Delta: AssistantDelta{
			Kind:         d.Type,
			ContentIndex: d.ContentIndex,
			Delta:        d.Delta,
			Content:      d.Content,
			Reason:       d.Reason,
			Partial:      d.Partial,
		},
	})
}

func (s *Session) forwardMessage(raw json.RawMessage) {
	var ev struct {
		Message struct {
			Role       string          `json:"role"`
			CustomType string          `json:"customType"`
			Content    json.RawMessage `json:"content"`
			Model      string          `json:"model"`
			Usage      json.RawMessage `json:"usage"`
			StopReason string          `json:"stopReason"`
			TS         int64           `json:"timestamp"`
		} `json:"message"`
	}
	if json.Unmarshal(raw, &ev) != nil {
		return
	}
	m := ev.Message
	if m.StopReason != "" {
		s.mu.Lock()
		s.lastStop = m.StopReason
		s.mu.Unlock()
	}
	s.send(&MessageFrame{
		Type:      "message",
		SessionID: s.id,
		Message: AssistantMsg{
			Role:       m.Role,
			CustomType: m.CustomType,
			Blocks:     normalizeBlocks(m.Content),
			Model:      m.Model,
			Usage:      m.Usage,
			TS:         m.TS,
		},
	})
}

func normalizeBlocks(content json.RawMessage) []ContentBlock {
	if len(content) == 0 {
		return nil
	}
	var asString string
	if json.Unmarshal(content, &asString) == nil {
		return []ContentBlock{{Kind: "text", Text: asString}}
	}
	var raws []json.RawMessage
	if json.Unmarshal(content, &raws) != nil {
		return nil
	}
	out := make([]ContentBlock, 0, len(raws))
	for _, r := range raws {
		var b struct {
			Type     string          `json:"type"`
			Text     string          `json:"text"`
			Thinking string          `json:"thinking"`
			ID       string          `json:"id"`
			Name     string          `json:"name"`
			Args     json.RawMessage `json:"arguments"`
		}
		if json.Unmarshal(r, &b) != nil {
			continue
		}
		out = append(out, ContentBlock{Kind: b.Type, Text: b.Text, Thinking: b.Thinking, ID: b.ID, Name: b.Name, Args: b.Args})
	}
	return out
}

func (s *Session) forwardTool(raw json.RawMessage, phase string) {
	var ev struct {
		ToolCallID string          `json:"toolCallId"`
		ToolName   string          `json:"toolName"`
		Args       json.RawMessage `json:"args"`
		Partial    json.RawMessage `json:"partialResult"`
		Result     json.RawMessage `json:"result"`
		IsError    bool            `json:"isError"`
	}
	if json.Unmarshal(raw, &ev) != nil {
		return
	}
	s.send(&ToolFrame{
		Type:       "tool",
		SessionID:  s.id,
		ToolCallID: ev.ToolCallID,
		ToolName:   ev.ToolName,
		Phase:      phase,
		Args:       ev.Args,
		Partial:    ev.Partial,
		Result:     ev.Result,
		IsError:    ev.IsError,
	})
}
