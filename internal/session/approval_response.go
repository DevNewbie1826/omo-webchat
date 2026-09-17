package session

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/wscontract"
)

// RespondApprovalFrame forwards both structured questions and legacy approvals.
func (s *Session) RespondApprovalFrame(ctx context.Context, frame wscontract.ApprovalRespondFrame) error {
	value := ""
	if frame.Value != nil {
		value = *frame.Value
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return err
	}
	requestID := ""
	if frame.RequestID != nil {
		requestID = *frame.RequestID
	}
	response := omorpc.ExtensionUIResponse{
		ID: frame.ID, Value: encoded, Confirmed: frame.Confirmed,
		Cancelled: frame.Cancelled != nil && *frame.Cancelled,
		Answers:   frame.Answers, Comment: frame.Comment,
	}
	// Structured answers travel as fields, not as a JSON-encoded legacy value.
	if frame.Answers != nil && frame.Value == nil {
		response.Value = nil
	}
	return s.respondExtensionUI(ctx, requestID, response)
}

var errApprovalExpired = errors.New("This question has expired. Ask the assistant to request it again.")

func (s *Session) respondExtensionUI(ctx context.Context, requestID string, response omorpc.ExtensionUIResponse) error {
	if err := s.prepareWrite(ctx); err != nil {
		s.lifecycleMu.Lock()
		s.resolveApprovalLocked(response.ID, requestID, "expired", errApprovalExpired.Error())
		s.lifecycleMu.Unlock()
		return err
	}
	s.lifecycleMu.Lock()
	defer s.lifecycleMu.Unlock()
	route, err := s.routeLocked()
	_, active := s.activeApprovals[response.ID]
	if err == nil && !active {
		err = errApprovalExpired
	}
	if err == nil {
		response.SessionID = route
		// Serialize lifecycle dispatch with the write: a resumed engine stream
		// cannot overtake the ack, and failed writes never receive a success ack.
		// Notify is one-way; success proves a write, not engine acceptance.
		err = s.client.Notify(ctx, response)
	}
	if err != nil {
		s.resolveApprovalLocked(response.ID, requestID, "expired", errApprovalExpired.Error())
		return err
	}
	delete(s.activeApprovals, response.ID)
	if s.pendingApproval != nil && s.pendingApproval.ApprovalID == response.ID {
		s.pendingApproval = nil
	}
	s.publishLocked(Frame{Kind: FrameAck, SessionID: s.durableID, Command: omorpc.CmdExtensionUIResponse, RequestID: requestID, ApprovalID: response.ID})
	return nil
}

// A terminal outcome is distinct from a successful answer acknowledgement.
// Clear only this request; a late response must not retire its replacement.
func (s *Session) resolveApprovalLocked(id, requestID, outcome, message string) {
	delete(s.activeApprovals, id)
	if s.pendingApproval != nil && s.pendingApproval.ApprovalID == id {
		s.pendingApproval = nil
	}
	payload := map[string]any{"id": id, "outcome": outcome}
	if requestID != "" {
		payload["requestId"] = requestID
	}
	if message != "" {
		payload["message"] = message
	}
	s.publishLocked(Frame{Kind: FrameApprovalResolved, SessionID: s.durableID, Data: payload})
}
