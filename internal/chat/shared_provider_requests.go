package chat

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"time"
)

const closeSessionTimeout = 5 * time.Second

type pendingProviderRequest struct {
	response chan Event
	session  *Session
	open     bool
}

func (p *sharedProvider) requestID(prefix string) string {
	return "webchat-" + prefix + "-" + strconv.FormatUint(p.nextID.Add(1), 10)
}

func (p *sharedProvider) openSession(ctx context.Context, s *Session, opts SessionOptions) error {
	id := p.requestID("open")
	response := make(chan Event, 1)
	p.mu.Lock()
	if p.state != sharedProviderStarted {
		p.mu.Unlock()
		return errors.New("chat: provider process ended")
	}
	p.pending[id] = pendingProviderRequest{response: response, session: s, open: true}
	p.mu.Unlock()

	cmd := map[string]any{"type": "open_session", "id": id}
	if opts.PiSessionID != "" {
		cmd["sessionPath"] = opts.PiSessionID
	} else {
		cmd["cwd"] = opts.Cwd
	}
	// Process.Send may block in the OS pipe or behind another blocked writer.
	// Keep both the write and response under the caller's open deadline. If the
	// write wedges, terminating the shared provider is the only way to release
	// Process.writeMu for every sibling; p.close converges on the existing pump
	// and providerExited teardown path.
	sendResult := make(chan error, 1)
	go func() { sendResult <- p.proc.Send(cmd) }()
	select {
	case err := <-sendResult:
		if err != nil {
			p.removePending(id)
			return err
		}
	case <-ctx.Done():
		p.removePending(id)
		_ = p.close()
		return ctx.Err()
	case <-p.done:
		p.removePending(id)
		return errors.New("chat: provider process ended while writing open_session")
	}

	var ev Event
	select {
	case received, ok := <-response:
		if !ok {
			return errors.New("chat: provider process ended while opening session")
		}
		ev = received
	case <-ctx.Done():
		p.removePending(id)
		_ = p.close()
		return ctx.Err()
	case <-p.done:
		// p.done closes before the exit path closes every pending response
		// channel. Wait for either a response or that final close instead of
		// racing the reader with a non-blocking receive. Context cancellation
		// remains authoritative, and the bound protects against a wedged reader.
		if err := ctx.Err(); err != nil {
			return err
		}
		if p.afterOpenDeath != nil {
			p.afterOpenDeath()
		}
		timer := time.NewTimer(closeSessionTimeout)
		defer timer.Stop()
		select {
		case received, ok := <-response:
			if err := ctx.Err(); err != nil {
				return err
			}
			if !ok {
				return errors.New("chat: provider process ended while opening session")
			}
			ev = received
		case <-ctx.Done():
			return ctx.Err()
		case <-timer.C:
			return errors.New("chat: provider process ended while opening session")
		}
	}
	var resp struct {
		Success   bool            `json:"success"`
		Error     string          `json:"error"`
		SessionID string          `json:"sessionId"`
		Data      json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(ev.Raw, &resp); err != nil {
		return fmt.Errorf("chat: decode open_session response: %w", err)
	}
	if !resp.Success {
		if resp.Error == "" {
			resp.Error = "provider request failed"
		}
		return errors.New("chat: open session: " + resp.Error)
	}
	var data struct {
		SessionID string          `json:"sessionId"`
		State     json.RawMessage `json:"state"`
	}
	if err := json.Unmarshal(resp.Data, &data); err != nil {
		return fmt.Errorf("chat: decode open_session data: %w", err)
	}
	handle := data.SessionID
	if handle == "" {
		handle = resp.SessionID
	}
	if handle == "" {
		return errors.New("chat: open_session response omitted routing handle")
	}
	// The route is already visible to the pump. Publish the authoritative
	// initial identity before releasing its worker, so immediately following
	// tagged frames retain stdout order while Acquire still observes identity
	// synchronously.
	s.capturePiSessionID(data.State)
	p.activateRoute(handle, s)
	return nil
}

func (p *sharedProvider) removePending(id string) {
	p.mu.Lock()
	delete(p.pending, id)
	p.mu.Unlock()
}

func (p *sharedProvider) send(s *Session, cmd map[string]any) error {
	s.mu.Lock()
	handle := s.routingHandle
	done := s.done
	s.mu.Unlock()
	if done || handle == "" {
		return errors.New("chat: session is closed")
	}
	cmd["sessionId"] = handle
	if rawID, ok := cmd["id"].(string); ok && rawID != "" && cmd["type"] == "get_entries" {
		p.mu.Lock()
		if route := p.sessions[handle]; route != nil && p.state == sharedProviderStarted {
			p.requests[rawID] = route
		}
		p.mu.Unlock()
	}
	if err := p.proc.Send(cmd); err != nil {
		if rawID, ok := cmd["id"].(string); ok {
			p.mu.Lock()
			delete(p.requests, rawID)
			p.mu.Unlock()
		}
		return err
	}
	return nil
}

func (p *sharedProvider) closeSession(s *Session) error {
	s.mu.Lock()
	handle := s.routingHandle
	s.mu.Unlock()
	if handle == "" {
		return nil
	}
	return p.closeSessionHandle(handle, s)
}

func (p *sharedProvider) closeSessionHandle(handle string, s *Session) error {
	id := p.requestID("close")
	response := make(chan Event, 1)
	p.mu.Lock()
	if p.state == sharedProviderDead {
		p.removeSessionLocked(handle, s)
		p.mu.Unlock()
		p.clearRoutingHandle(s, handle)
		return nil
	}
	p.pending[id] = pendingProviderRequest{response: response}
	p.mu.Unlock()

	// Every return path owns the same local cleanup. A failed or malformed
	// close response must not leave a dead route in the shared provider.
	defer func() {
		p.removePending(id)
		p.removeSession(handle, s)
	}()

	sendResult := make(chan error, 1)
	go func() {
		err := p.proc.Send(map[string]any{
			"type":      "close_session",
			"sessionId": handle,
			"id":        id,
		})
		sendResult <- err
		if p.afterCloseSend != nil {
			p.afterCloseSend()
		}
	}()

	deadline := p.closeDeadline
	if deadline == nil {
		deadline = func() <-chan time.Time { return time.After(closeSessionTimeout) }
	}
	timedOut := deadline()
	select {
	case err := <-sendResult:
		if err != nil {
			return err
		}
	case <-p.done:
		return nil
	case <-timedOut:
		// Process.Send may be holding writeMu forever. Killing the shared
		// process is the only way to release it; treating this as a local
		// session failure would wedge every sibling command. Go through the
		// provider's single shutdown owner so a concurrent idle release or
		// CloseAll cannot close the Process a second time.
		_ = p.close()
		return errors.New("chat: close_session write timed out")
	}

	select {
	case ev, ok := <-response:
		if !ok {
			return nil
		}
		var resp struct {
			Success bool   `json:"success"`
			Error   string `json:"error"`
		}
		if err := json.Unmarshal(ev.Raw, &resp); err != nil {
			return fmt.Errorf("chat: decode close_session response: %w", err)
		}
		if !resp.Success {
			if resp.Error == "" {
				resp.Error = "provider request failed"
			}
			return errors.New("chat: close session: " + resp.Error)
		}
		return nil
	case <-p.done:
		return nil
	case <-timedOut:
		return errors.New("chat: close_session response timed out")
	}
}
