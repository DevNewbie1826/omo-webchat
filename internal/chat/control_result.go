package chat

// sendControlResult surfaces the provider's typed outcome for a control
// command, correlated by the requestId the provider echoed. Success confirms
// the optimistic setting; failure carries the provider message so the client
// can roll back exactly the correlated transaction.
func (s *Session) sendControlResult(command, requestID string, success bool, responseError string) {
	if success {
		s.send(&ControlResultFrame{Type: "control.result", SessionID: s.id, Command: command, RequestID: requestID, Success: true})
		return
	}
	message := responseError
	if message == "" {
		message = "provider request failed"
	}
	s.send(&ControlResultFrame{Type: "control.result", SessionID: s.id, Command: command, RequestID: requestID, Success: false, Message: message})
}
