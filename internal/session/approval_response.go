package session

import (
	"context"
	"encoding/json"

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

func (s *Session) respondExtensionUI(ctx context.Context, requestID string, response omorpc.ExtensionUIResponse) error {
	if err := s.prepareWrite(ctx); err != nil {
		return err
	}
	s.lifecycleMu.Lock()
	route, err := s.routeLocked()
	// Dismiss before the ack so live subscribers and replay agree.
	if s.pendingApproval != nil && s.pendingApproval.ApprovalID == response.ID {
		s.pendingApproval = nil
	}
	if err == nil {
		s.publishLocked(Frame{Kind: FrameAck, SessionID: s.durableID, Command: omorpc.CmdExtensionUIResponse, RequestID: requestID, ApprovalID: response.ID})
	}
	s.lifecycleMu.Unlock()
	if err != nil {
		return err
	}
	routed := response
	routed.SessionID = route
	return s.client.Notify(ctx, routed)
}
