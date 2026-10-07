package session

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

// ErrEnrolledAttach leaves the enrolled cursor intact for a later Acquire.
// A failed attach must never implicitly acquire the external route on main.
type ErrEnrolledAttach struct{ Cause error }

func (e *ErrEnrolledAttach) Error() string { return "session: enrolled attach: " + e.Cause.Error() }
func (e *ErrEnrolledAttach) Unwrap() error { return e.Cause }

func (m *Manager) epochCurrent(token omorpc.EpochToken) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.epochCurrentLocked(token)
}

// epochCurrentLocked is the same resolver for publication while Manager.mu
// already owns the epoch invalidation barrier.
func (m *Manager) epochCurrentLocked(token omorpc.EpochToken) bool {
	if m.cfg.Client != nil && m.cfg.Client.EpochCurrent(token) {
		return true
	}
	c := m.attachClients[token]
	return c != nil && c.EpochCurrent(token)
}

func (m *Manager) openEnrolled(ctx context.Context, cwd string, cur Cursor, listed omorpc.OpenSessionData) (data omorpc.OpenSessionData, client *omorpc.Client, epoch omorpc.EpochToken, events <-chan *omorpc.Event, err error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	client, err = m.cfg.DialAttach(ctx)
	if err != nil {
		return data, nil, epoch, nil, &ErrEnrolledAttach{Cause: err}
	}
	epoch, events = client.CurrentEpoch() // Subscribe BEFORE open's snapshot replay.
	m.mu.Lock()
	m.attachClients[epoch] = client
	m.mu.Unlock()
	accepted := false
	defer func() {
		if !accepted {
			m.releaseAttachClient(epoch, client)
			client = nil
		}
	}()
	path := listed.State.SessionFile
	if path == "" {
		path = cur.SessionFile
	}
	resp, _, callErr := client.CallInEpochToken(ctx, epoch, omorpc.OpenSession{CWD: cwd, SessionPath: path})
	if callErr != nil {
		return data, client, epoch, events, &ErrEnrolledAttach{Cause: callErr}
	}
	if decodeErr := json.Unmarshal(resp.Data, &data); decodeErr != nil {
		return data, client, epoch, events, &ErrEnrolledAttach{Cause: fmt.Errorf("decode open_session: %w", decodeErr)}
	}
	if !data.Attached {
		// The listed session closed before open. Disconnect the fresh opener
		// and let the ordinary owned path resume it on main.
		return data, client, epoch, events, nil
	}
	if data.SessionID != listed.SessionID {
		return data, client, epoch, events, &ErrEnrolledAttach{Cause: fmt.Errorf("route mismatch: provider %q, listed %q", data.SessionID, listed.SessionID)}
	}
	if validationErr := validateOpen(data, cur, true); validationErr != nil {
		return data, client, epoch, events, &ErrEnrolledAttach{Cause: validationErr}
	}
	accepted = true
	return data, client, epoch, events, nil
}

func (m *Manager) releaseAttachClient(epoch omorpc.EpochToken, client *omorpc.Client) {
	m.mu.Lock()
	if m.attachClients[epoch] == client {
		delete(m.attachClients, epoch)
	}
	m.mu.Unlock()
	if err := client.Close(); err != nil {
		slog.Warn("closing enrolled attachment", "error", err)
	}
}

// releaseAttach is idempotent across close, replacement, invalidation and
// acquire failure. No manager lock is held while closing the transport.
func (s *Session) releaseAttach() {
	s.lifecycleMu.Lock()
	client := s.attachClient
	if client != nil {
		s.attachClient = nil
		close(s.attachStop)
	}
	s.lifecycleMu.Unlock()
	if client != nil {
		s.manager.releaseAttachClient(s.epoch, client)
	}
}

func (s *Session) startAttachPump(events <-chan *omorpc.Event) {
	if events == nil {
		return
	}
	m := s.manager
	m.eventWG.Add(1)
	go func() {
		defer m.eventWG.Done()
		defer s.releaseAttach()
		for {
			select {
			case <-m.done:
				return
			case <-s.attachStop:
				return
			case ev, ok := <-events:
				if !ok {
					s.lifecycleMu.Lock()
					closing := s.closed || s.closing || s.attachClient == nil
					s.lifecycleMu.Unlock()
					if !closing {
						m.invalidateEpoch(s.epoch)
					}
					return
				}
				m.ingestClientEvent(s.client, s.epoch, ev)
			}
		}
	}()
}

// Both pumps use the same ingestion/publication path. The immutable client
// binding lets main skip dedicated routes without nesting lifecycleMu under mu.
func (m *Manager) ingestClientEvent(client *omorpc.Client, token omorpc.EpochToken, ev *omorpc.Event) {
	if ev == nil || ev.SessionID == "" || !client.EpochCurrent(token) {
		return
	}
	if client == m.cfg.Client {
		m.mu.Lock()
		if ev.Type == "session_closed" {
			delete(m.mainAttachedResiduals, retiringRoute{route: ev.SessionID, epoch: token})
		}
		s := m.byRoute[ev.SessionID]
		dedicated := s != nil && s.client != m.cfg.Client
		m.mu.Unlock()
		if dedicated {
			return
		}
	}
	if !m.beginEpochIngestion(token) {
		return
	}
	s, snapshot, subscribers := m.ingestEpochEvent(token, ev)
	if s != nil {
		s.dispatchEpoch(token, ev)
	} else {
		deliverOverview(subscribers, snapshot)
	}
	m.endEpochIngestion(token)
}

func (m *Manager) mainAttached(route string, epoch omorpc.EpochToken) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	_, ok := m.mainAttachedResiduals[retiringRoute{route: route, epoch: epoch}]
	return ok
}

func (m *Manager) rememberMainAttached(data omorpc.OpenSessionData, epoch omorpc.EpochToken) {
	if !data.Attached || data.SessionID == "" {
		return
	}
	m.mu.Lock()
	m.mainAttachedResiduals[retiringRoute{route: data.SessionID, epoch: epoch}] = struct{}{}
	m.mu.Unlock()
	slog.Warn("main connection attached an external session; leaving attachment until disconnect", "routing_id", data.SessionID)
}
