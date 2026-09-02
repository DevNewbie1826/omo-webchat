package session

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

type Session struct {
	manager                           *Manager
	client                            *omorpc.Client
	chatID, cwd                       string
	durableID, routingID, sessionFile string
	resumed                           bool
	queueSize                         int
	idleAfter                         time.Duration

	lifecycleMu                                                             sync.Mutex
	closed, resumable, invalidated                                          bool
	readyPublished                                                          bool
	promptInFlight, providerRunActive, compactionActive, localCommandActive bool
	promptSeq, compactSeq                                                   uint64
	compactRPCID, compactProviderID, compactPhase                           string
	completedCompactions                                                    map[string]struct{}
	idleTimer                                                               *time.Timer

	broadcast broadcaster
}

func newSession(m *Manager, chatID, cwd string, data omorpc.OpenSessionData, resumed bool) *Session {
	return &Session{manager: m, client: m.cfg.Client, chatID: chatID, cwd: cwd,
		durableID: data.State.SessionID, routingID: data.SessionID, sessionFile: data.State.SessionFile,
		resumed: resumed, queueSize: m.cfg.QueueSize, idleAfter: m.cfg.IdleAfter,
		completedCompactions: make(map[string]struct{})}
}

func (s *Session) ChatID() string      { return s.chatID }
func (s *Session) ID() string          { return s.durableID }
func (s *Session) RoutingID() string   { return s.routingID }
func (s *Session) SessionFile() string { return s.sessionFile }
func (s *Session) Resumable() bool {
	s.lifecycleMu.Lock()
	defer s.lifecycleMu.Unlock()
	return s.resumable
}

func (s *Session) routeLocked() (string, error) {
	if s.closed {
		return "", errors.New("session: closed")
	}
	if s.resumable {
		return "", errors.New("session: provider session is resumable")
	}
	return s.routingID, nil
}

func (s *Session) SendPrompt(ctx context.Context, msg string, images []map[string]string) error {
	s.lifecycleMu.Lock()
	if s.compactionActive {
		s.lifecycleMu.Unlock()
		return ErrCompactionInFlight
	}
	if s.promptInFlight || s.providerRunActive || s.localCommandActive {
		s.lifecycleMu.Unlock()
		return ErrPromptInFlight
	}
	route, err := s.routeLocked()
	if err != nil {
		s.lifecycleMu.Unlock()
		return err
	}
	s.promptSeq++
	seq := s.promptSeq
	s.promptInFlight = true
	s.cancelIdleLocked()
	s.lifecycleMu.Unlock()

	_, err = s.client.Call(ctx, omorpc.Prompt{SessionID: route, Message: msg, Images: images})
	s.lifecycleMu.Lock()
	if s.promptSeq == seq {
		if err != nil && !s.providerRunActive {
			s.promptInFlight = false
			s.localCommandActive = false
			s.scheduleIdleLocked()
		}
		if err == nil && s.localCommandActive {
			s.promptInFlight = false
			s.localCommandActive = false
			s.scheduleIdleLocked()
		}
	}
	s.lifecycleMu.Unlock()
	return err
}

func (s *Session) Abort(ctx context.Context) error {
	s.lifecycleMu.Lock()
	route, err := s.routeLocked()
	s.lifecycleMu.Unlock()
	if err != nil {
		return err
	}
	go func() { _, _ = s.client.Call(ctx, omorpc.Abort{SessionID: route}) }()
	return nil
}

func (s *Session) Compact(ctx context.Context) error {
	s.lifecycleMu.Lock()
	if s.promptInFlight || s.providerRunActive || s.compactionActive || s.localCommandActive {
		s.lifecycleMu.Unlock()
		return ErrCompactionInFlight
	}
	route, err := s.routeLocked()
	if err != nil {
		s.lifecycleMu.Unlock()
		return err
	}
	s.compactSeq++
	seq := s.compactSeq
	s.compactionActive = true
	s.compactRPCID = fmt.Sprintf("compact-%d", seq)
	s.compactProviderID = ""
	s.compactPhase = "manual"
	s.cancelIdleLocked()
	s.publishLocked(Frame{Kind: FrameCompactionStart, SessionID: s.durableID, RequestID: s.compactRPCID, Data: CompactionInfo{Phase: "manual"}})
	s.lifecycleMu.Unlock()

	_, callErr := s.client.Call(ctx, omorpc.Compact{SessionID: route})
	s.lifecycleMu.Lock()
	if s.compactSeq == seq && s.compactionActive {
		s.compactionActive = false
		s.completedCompactions[s.compactRPCID] = struct{}{}
		info := CompactionInfo{Phase: "manual"}
		if callErr != nil {
			info.Error = callErr.Error()
		}
		s.publishLocked(Frame{Kind: FrameCompactionDone, SessionID: s.durableID, RequestID: s.compactRPCID, Data: info})
		s.scheduleIdleLocked()
	}
	s.lifecycleMu.Unlock()
	return callErr
}

func (s *Session) SetModel(ctx context.Context, provider, modelID, requestID string) error {
	return s.control(ctx, "set_model", requestID, func(route string) (any, error) {
		_, err := s.client.Call(ctx, omorpc.SetModel{SessionID: route, Provider: provider, ModelID: modelID})
		return nil, err
	})
}

func (s *Session) SetThinking(ctx context.Context, level, requestID string) error {
	return s.control(ctx, "set_thinking", requestID, func(route string) (any, error) {
		_, err := s.client.Call(ctx, omorpc.SetThinkingLevel{SessionID: route, Level: level})
		return nil, err
	})
}

func (s *Session) control(_ context.Context, command, requestID string, call func(string) (any, error)) error {
	s.lifecycleMu.Lock()
	route, err := s.routeLocked()
	s.lifecycleMu.Unlock()
	if err != nil {
		return err
	}
	_, err = call(route)
	s.lifecycleMu.Lock()
	data := map[string]any{"success": err == nil}
	if err != nil {
		data["message"] = err.Error()
	}
	s.publishLocked(Frame{Kind: FrameControlResult, SessionID: s.durableID, Command: command, RequestID: requestID, Data: data})
	s.lifecycleMu.Unlock()
	return err
}

func (s *Session) QueryState(ctx context.Context) (*omorpc.SessionState, error) {
	s.lifecycleMu.Lock()
	route, err := s.routeLocked()
	s.lifecycleMu.Unlock()
	if err != nil {
		return nil, err
	}
	resp, err := s.client.Call(ctx, omorpc.GetState{SessionID: route})
	if err != nil {
		s.noteTransportError(err)
		return nil, err
	}
	var out omorpc.SessionState
	if err := json.Unmarshal(resp.Data, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (s *Session) Models(ctx context.Context) ([]Model, error) {
	s.lifecycleMu.Lock()
	route, err := s.routeLocked()
	s.lifecycleMu.Unlock()
	if err != nil {
		return nil, err
	}
	resp, err := s.client.Call(ctx, omorpc.GetAvailableModels{SessionID: route})
	if err != nil {
		return nil, err
	}
	var wire struct {
		Models []struct {
			Provider string `json:"provider"`
			ModelID  string `json:"modelId"`
			Name     string `json:"name"`
		} `json:"models"`
	}
	if err := json.Unmarshal(resp.Data, &wire); err != nil {
		return nil, err
	}
	out := make([]Model, len(wire.Models))
	for i, x := range wire.Models {
		out[i] = Model{x.Provider, x.ModelID, x.Name}
	}
	return out, nil
}

func (s *Session) Commands(ctx context.Context) ([]CommandInfo, error) {
	s.lifecycleMu.Lock()
	route, err := s.routeLocked()
	s.lifecycleMu.Unlock()
	if err != nil {
		return nil, err
	}
	resp, err := s.client.Call(ctx, omorpc.GetCommands{SessionID: route})
	if err != nil {
		return nil, err
	}
	var wire struct {
		Commands []struct {
			Name        string `json:"name"`
			Description string `json:"description"`
			Source      string `json:"source"`
			Syntax      string `json:"syntax"`
			SourceInfo  string `json:"sourceInfo"`
		} `json:"commands"`
	}
	if err := json.Unmarshal(resp.Data, &wire); err != nil {
		return nil, err
	}
	out := make([]CommandInfo, len(wire.Commands))
	for i, x := range wire.Commands {
		out[i] = CommandInfo{x.Name, x.Description, x.Source, x.Syntax, x.SourceInfo}
	}
	return out, nil
}

func (s *Session) Stats(ctx context.Context) (*Stats, error) {
	s.lifecycleMu.Lock()
	route, err := s.routeLocked()
	s.lifecycleMu.Unlock()
	if err != nil {
		return nil, err
	}
	resp, err := s.client.Call(ctx, omorpc.GetSessionStats{SessionID: route})
	if err != nil {
		return nil, err
	}
	var out Stats
	if len(resp.Data) != 0 {
		if err := json.Unmarshal(resp.Data, &out); err != nil {
			return nil, err
		}
	}
	return &out, nil
}

func (s *Session) SetSessionName(ctx context.Context, name string) error {
	s.lifecycleMu.Lock()
	route, err := s.routeLocked()
	s.lifecycleMu.Unlock()
	if err != nil {
		return err
	}
	_, err = s.client.Call(ctx, omorpc.SetSessionName{SessionID: route, Name: name})
	return err
}

func (s *Session) Attach(sub Subscriber) func() {
	s.lifecycleMu.Lock()
	s.cancelIdleLocked()
	var initial []Frame
	if s.readyPublished {
		initial = []Frame{{Kind: FrameReady, SessionID: s.durableID, Resumed: s.resumed}}
	}
	id, rawDetach := s.broadcast.attach(sub, s.queueSize, initial)
	s.lifecycleMu.Unlock()
	var once sync.Once
	return func() {
		once.Do(func() {
			rawDetach()
			if id != 0 {
				s.lifecycleMu.Lock()
				s.scheduleIdleLocked()
				s.lifecycleMu.Unlock()
			}
		})
	}
}

func (s *Session) Close() error { return s.closeContext(context.Background()) }

func (s *Session) closeContext(ctx context.Context) error {
	s.lifecycleMu.Lock()
	if s.closed {
		s.lifecycleMu.Unlock()
		return nil
	}
	s.closed = true
	s.cancelIdleLocked()
	route := s.routingID
	s.manager.mu.Lock()
	if s.manager.byChat[s.chatID] == s {
		delete(s.manager.byChat, s.chatID)
		delete(s.manager.byRoute, route)
	}
	s.manager.mu.Unlock()
	s.lifecycleMu.Unlock()
	_, err := s.client.Call(ctx, omorpc.CloseSession{SessionID: route})
	if err != nil {
		var stable *omorpc.StableError
		if errors.As(err, &stable) && stable.Code == omorpc.ErrCodeUnknownSession {
			return nil
		}
	}
	return err
}

func (s *Session) noteTransportError(err error) {
	if errors.Is(err, omorpc.ErrDisconnected) {
		s.manager.invalidateEpoch()
	}
}

func (s *Session) activeLocked() bool {
	return s.promptInFlight || s.providerRunActive || s.compactionActive || s.localCommandActive
}
func (s *Session) summary() (Summary, bool) {
	s.lifecycleMu.Lock()
	defer s.lifecycleMu.Unlock()
	if s.closed || s.resumable {
		return Summary{}, false
	}
	return Summary{ChatID: s.chatID, DurableSessionID: s.durableID, SessionFile: s.sessionFile, CWD: s.cwd, Active: s.activeLocked(), Attachments: s.broadcast.count()}, true
}

func (s *Session) publishLocked(f Frame) {
	if f.Kind == FrameReady {
		s.readyPublished = true
	}
	s.broadcast.publish(f)
}

func (s *Session) invalidate(code, message string) {
	s.lifecycleMu.Lock()
	if s.closed || s.invalidated {
		s.lifecycleMu.Unlock()
		return
	}
	s.invalidated = true
	s.resumable = true
	s.promptInFlight = false
	s.providerRunActive = false
	s.compactionActive = false
	s.localCommandActive = false
	s.cancelIdleLocked()
	s.publishLocked(Frame{Kind: FrameError, SessionID: s.durableID, Data: ErrorInfo{Code: code, Message: message}})
	s.lifecycleMu.Unlock()
}

func (s *Session) cancelIdleLocked() {
	if s.idleTimer != nil {
		s.idleTimer.Stop()
		s.idleTimer = nil
	}
}
func (s *Session) scheduleIdleLocked() {
	if s.closed || s.resumable || s.activeLocked() || s.broadcast.count() != 0 {
		return
	}
	s.cancelIdleLocked()
	s.idleTimer = time.AfterFunc(s.idleAfter, func() { s.manager.evict(s) })
}

func (s *Session) loadEntries(ctx context.Context) {
	s.lifecycleMu.Lock()
	route, err := s.routeLocked()
	s.lifecycleMu.Unlock()
	if err != nil {
		return
	}
	resp, err := s.client.Call(ctx, omorpc.GetEntries{SessionID: route})
	if err != nil {
		return
	}
	var wire struct {
		Entries []json.RawMessage `json:"entries"`
		LeafID  string            `json:"leafId"`
	}
	if json.Unmarshal(resp.Data, &wire) != nil {
		return
	}
	s.lifecycleMu.Lock()
	if !s.closed && !s.resumable {
		s.publishLocked(Frame{Kind: FrameEntries, SessionID: s.durableID, Data: EntriesFrame{Entries: wire.Entries, LeafID: wire.LeafID, Final: true}})
	}
	s.lifecycleMu.Unlock()
}
