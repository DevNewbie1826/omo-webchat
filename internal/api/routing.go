package api

import (
	"encoding/json"
)

// controlAckFrame confirms that a typed control command (set_model,
// set_thinking_level, extension_ui_response) was accepted and written to the
// provider in order. It is emitted immediately after the provider write, so it
// precedes every frame the command may cause and gives the client a commit
// point for optimistic setting changes. RequestID correlates the client's
// transaction; ID carries the approval id for extension_ui_response only.
type controlAckFrame struct {
	Type      string `json:"type"`
	SessionID string `json:"sessionId"`
	Command   string `json:"command"`
	ID        string `json:"id,omitempty"`
	RequestID string `json:"requestId,omitempty"`
}

func (h *connHandler) ackBytes(command, id, requestID string) []byte {
	chatID, _ := h.snapshot()
	frame, _ := json.Marshal(controlAckFrame{Type: "ack", SessionID: chatID, Command: command, ID: id, RequestID: requestID})
	return frame
}

func (s *Server) handleChatSend(h *connHandler, raw []byte) {
	h.mu.Lock()
	sess := h.session
	h.mu.Unlock()
	if sess == nil {
		h.sendError("no_session", "create a chat session first")
		return
	}
	var req struct {
		Run struct {
			Kind    string              `json:"kind"`
			Message string              `json:"message"`
			Images  []map[string]string `json:"images"`
		} `json:"run"`
	}
	if json.Unmarshal(raw, &req) != nil {
		h.sendError("bad_send", "invalid chat.send")
		return
	}
	var err error
	switch req.Run.Kind {
	case "steer":
		err = sess.Steer(req.Run.Message)
	case "follow_up":
		err = sess.FollowUp(req.Run.Message)
	default:
		if err = sess.SendPrompt(req.Run.Message, req.Run.Images); err == nil {
			s.autoTitleFromPrompt(h, req.Run.Message)
		}
	}
	if err != nil {
		h.sendError("send_failed", err.Error())
	}
}

func (s *Server) handleChatSet(h *connHandler, raw []byte, requestID string) {
	h.mu.Lock()
	sess := h.session
	h.mu.Unlock()
	if sess == nil {
		h.sendError("no_session", "create a chat session first")
		return
	}
	var req struct {
		Model *struct {
			Provider string `json:"provider"`
			ModelID  string `json:"modelId"`
		} `json:"model"`
		ThinkingLevel string `json:"thinkingLevel"`
	}
	if json.Unmarshal(raw, &req) != nil {
		h.sendError("bad_set", "invalid chat.set")
		return
	}
	if req.Model != nil {
		ack := h.ackBytes("set_model", "", requestID)
		if err := sess.SetModel(req.Model.Provider, req.Model.ModelID, requestID, ack); err != nil {
			h.sendCommandError("set_model_failed", err.Error(), "set_model", requestID)
		}
	}
	if req.ThinkingLevel != "" {
		ack := h.ackBytes("set_thinking_level", "", requestID)
		if err := sess.SetThinking(req.ThinkingLevel, requestID, ack); err != nil {
			h.sendCommandError("set_thinking_failed", err.Error(), "set_thinking_level", requestID)
		}
	}
}

func (s *Server) handleApprovalRespond(h *connHandler, raw []byte, requestID string) {
	h.mu.Lock()
	sess := h.session
	h.mu.Unlock()
	if sess == nil {
		h.sendError("no_session", "create a chat session first")
		return
	}
	var req struct {
		ID        string  `json:"id"`
		Value     *string `json:"value,omitempty"`
		Confirmed *bool   `json:"confirmed,omitempty"`
		Cancelled *bool   `json:"cancelled,omitempty"`
	}
	if json.Unmarshal(raw, &req) != nil || req.ID == "" {
		h.sendError("bad_approval", "invalid approval.respond")
		return
	}
	var value string
	if req.Value != nil {
		value = *req.Value
	}
	ack := h.ackBytes("extension_ui_response", req.ID, requestID)
	if err := sess.RespondApproval(req.ID, value, req.Confirmed, req.Cancelled, ack); err != nil {
		h.sendCommandError("approval_failed", err.Error(), "extension_ui_response", requestID)
	}
}

func (s *Server) handleChatCompact(h *connHandler, requestID string) {
	h.mu.Lock()
	sess := h.session
	h.mu.Unlock()
	if sess == nil {
		h.sendError("no_session", "create a chat session first")
		return
	}
	if err := sess.Compact(); err != nil {
		h.sendCommandError("compact_failed", err.Error(), "compact", requestID)
	}
}

func (s *Server) handleChatResume(h *connHandler, raw []byte) {
	var req struct {
		Since string `json:"since"`
	}
	if json.Unmarshal(raw, &req) != nil {
		h.sendError("bad_resume", "invalid chat.resume")
		return
	}
	h.mu.Lock()
	sess := h.session
	h.mu.Unlock()
	if sess == nil {
		h.sendError("no_session", "create a chat session first")
		return
	}
	if err := sess.Resume(req.Since); err != nil {
		h.sendCommandError("resume_failed", err.Error(), "query", "")
	}
}
