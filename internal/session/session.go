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

const (
	maxCompletedCompactions  = 8
	maxActivitySnapshotBytes = 64 << 10
	entriesPageMaxBytes      = 256 << 10
	entriesPageMaxCount      = 100
)

var activitySnapshotOrder = [2]string{"omo.task.updated", "omo.dag.updated"}

type Session struct {
	manager                           *Manager
	client                            *omorpc.Client
	chatID, cwd                       string
	durableID, routingID, sessionFile string
	resumed                           bool
	queueSize                         int
	idleAfter                         time.Duration
	epoch                             omorpc.EpochToken

	lifecycleMu                                                             sync.Mutex
	nameMu                                                                  sync.Mutex
	closed, closing, resumable, invalidated                                 bool
	readyPublished                                                          bool
	promptInFlight, providerRunActive, compactionActive, localCommandActive bool
	promptResponse                                                          bool
	closeRunSettled                                                         bool
	closeRunReason                                                          string
	promptSeq, localCommandSeq, compactSeq                                  uint64
	compactRPCID, compactProviderID, compactPhase                           string
	completedCompactions                                                    map[string]struct{}
	completedCompactionFIFO                                                 [][]string
	completedUnpaired                                                       []string
	abortInFlight                                                           bool
	idleTimer                                                               *time.Timer
	activitySnapshots                                                       map[string]json.RawMessage
	activityOversized                                                       map[string]bool
	title, nameSource                                                       string
	taskDigest                                                              *TaskDigest
	dagDigest                                                               *DagDigest

	broadcast broadcaster
}

func newSession(m *Manager, chatID, cwd string, data omorpc.OpenSessionData, resumed bool, epoch omorpc.EpochToken, storedName ...string) *Session {
	var name, nameSource string
	if len(storedName) > 0 {
		name = storedName[0]
	}
	if len(storedName) > 1 {
		nameSource = storedName[1]
	}
	if nameSource == "" {
		nameSource = NameSourceAuto
	}
	if nameSource != NameSourceUser {
		name = ""
	}
	s := &Session{manager: m, client: m.cfg.Client, chatID: chatID, cwd: cwd,
		durableID: data.State.SessionID, routingID: data.SessionID, sessionFile: data.State.SessionFile,
		resumed: resumed, queueSize: m.cfg.QueueSize, idleAfter: m.cfg.IdleAfter, epoch: epoch,
		title: name, nameSource: nameSource,
		completedCompactions: make(map[string]struct{}), activitySnapshots: make(map[string]json.RawMessage), activityOversized: make(map[string]bool)}
	s.broadcast.onDetach = m.cfg.OnDetach
	return s
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
	if s.closed || s.closing {
		return "", ErrSessionClosed
	}
	if s.resumable {
		return "", ErrSessionResumable
	}
	return s.routingID, nil
}

// RunSnapshot returns the client-visible run latches atomically.
func (s *Session) RunSnapshot() RunSnapshot {
	s.lifecycleMu.Lock()
	defer s.lifecycleMu.Unlock()
	return RunSnapshot{
		Streaming:  s.promptInFlight || s.providerRunActive || s.localCommandActive,
		Compacting: s.compactionActive,
	}
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
	s.promptResponse = false
	s.localCommandActive = false
	s.cancelIdleLocked()
	s.lifecycleMu.Unlock()

	_, err = s.client.Call(ctx, omorpc.Prompt{SessionID: route, Message: msg, Images: images})
	s.noteTransportError(err)
	s.lifecycleMu.Lock()
	if s.promptSeq == seq {
		if err != nil && !s.providerRunActive {
			s.promptInFlight = false
			s.localCommandActive = false
			s.promptResponse = false
			s.scheduleIdleLocked()
		} else if err == nil {
			s.promptResponse = true
			if s.localCommandActive && s.localCommandSeq == seq {
				s.completeLocalCommandLocked(seq)
			}
		}
	}
	s.lifecycleMu.Unlock()
	if err == nil {
		s.applyAutoTitle(ctx, msg)
	}
	return err
}

func (s *Session) SendSteer(ctx context.Context, msg string) error {
	return s.sendDuringRun(ctx, func(route string) (any, error) {
		return s.client.Call(ctx, omorpc.Steer{SessionID: route, Message: msg})
	})
}

func (s *Session) SendFollowUp(ctx context.Context, msg string) error {
	return s.sendDuringRun(ctx, func(route string) (any, error) {
		return s.client.Call(ctx, omorpc.FollowUp{SessionID: route, Message: msg})
	})
}

func (s *Session) sendDuringRun(_ context.Context, call func(string) (any, error)) error {
	s.lifecycleMu.Lock()
	if s.compactionActive {
		s.lifecycleMu.Unlock()
		return ErrCompactionInFlight
	}
	if !s.promptInFlight && !s.providerRunActive {
		s.lifecycleMu.Unlock()
		return ErrPromptInFlight
	}
	route, err := s.routeLocked()
	s.lifecycleMu.Unlock()
	if err != nil {
		return err
	}
	_, err = call(route)
	s.noteTransportError(err)
	return err
}

func (s *Session) completeLocalCommandLocked(seq uint64) {
	if s.promptSeq != seq || !s.promptInFlight || !s.localCommandActive {
		return
	}
	s.promptInFlight = false
	s.providerRunActive = false
	s.localCommandActive = false
	s.promptResponse = false
	s.publishLocked(Frame{Kind: FrameRunDone, SessionID: s.durableID, Data: RunInfo{Reason: "local_command"}})
	s.scheduleIdleLocked()
}

func (s *Session) Abort(ctx context.Context) error {
	s.lifecycleMu.Lock()
	route, err := s.routeLocked()
	if err != nil {
		s.lifecycleMu.Unlock()
		return err
	}
	if s.abortInFlight {
		s.lifecycleMu.Unlock()
		return nil
	}
	s.abortInFlight = true
	s.lifecycleMu.Unlock()
	err = s.client.CallDetached(ctx, omorpc.Abort{SessionID: route}, func(_ *omorpc.Response, _ omorpc.EpochToken, callErr error) {
		s.noteTransportError(callErr)
		s.lifecycleMu.Lock()
		s.abortInFlight = false
		s.lifecycleMu.Unlock()
	})
	if err != nil {
		s.noteTransportError(err)
		s.lifecycleMu.Lock()
		s.abortInFlight = false
		s.lifecycleMu.Unlock()
	}
	return err
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
	rpcID := s.compactRPCID
	s.cancelIdleLocked()
	s.publishLocked(Frame{Kind: FrameCompactionStart, SessionID: s.durableID, RequestID: rpcID, Data: CompactionInfo{Phase: "manual"}})
	s.lifecycleMu.Unlock()

	_, callErr := s.client.Call(ctx, omorpc.Compact{SessionID: route})
	s.noteTransportError(callErr)
	s.lifecycleMu.Lock()
	if s.compactSeq == seq && s.compactionActive && s.compactRPCID == rpcID {
		providerID := s.compactProviderID
		s.compactionActive = false
		s.rememberCompletedCompactionLocked(rpcID, providerID)
		if providerID == "" {
			s.completedUnpaired = append(s.completedUnpaired, rpcID)
			if len(s.completedUnpaired) > maxCompletedCompactions {
				s.completedUnpaired = s.completedUnpaired[len(s.completedUnpaired)-maxCompletedCompactions:]
			}
		}
		info := CompactionInfo{Phase: "manual"}
		if callErr != nil {
			info.Error = callErr.Error()
		}
		s.publishLocked(Frame{Kind: FrameCompactionDone, SessionID: s.durableID, RequestID: rpcID, Data: info})
		s.compactRPCID = ""
		s.compactProviderID = ""
		s.scheduleIdleLocked()
	}
	s.lifecycleMu.Unlock()
	return callErr
}

func (s *Session) rememberCompletedCompactionLocked(ids ...string) {
	unique := make([]string, 0, len(ids))
	for _, id := range ids {
		if id == "" {
			continue
		}
		if _, exists := s.completedCompactions[id]; exists {
			continue
		}
		s.completedCompactions[id] = struct{}{}
		unique = append(unique, id)
	}
	if len(unique) == 0 {
		return
	}
	s.completedCompactionFIFO = append(s.completedCompactionFIFO, unique)
	if len(s.completedCompactionFIFO) > maxCompletedCompactions {
		old := s.completedCompactionFIFO[0]
		s.completedCompactionFIFO = s.completedCompactionFIFO[1:]
		for _, id := range old {
			delete(s.completedCompactions, id)
		}
	}
}

func (s *Session) SetModel(ctx context.Context, provider, modelID, requestID string) error {
	return s.control(ctx, "set_model", requestID, func(route string) error {
		_, err := s.client.Call(ctx, omorpc.SetModel{SessionID: route, Provider: provider, ModelID: modelID})
		return err
	})
}
func (s *Session) SetThinking(ctx context.Context, level, requestID string) error {
	return s.control(ctx, "set_thinking", requestID, func(route string) error {
		_, err := s.client.Call(ctx, omorpc.SetThinkingLevel{SessionID: route, Level: level})
		return err
	})
}
func (s *Session) control(_ context.Context, command, requestID string, call func(string) error) error {
	s.lifecycleMu.Lock()
	route, err := s.routeLocked()
	s.lifecycleMu.Unlock()
	if err != nil {
		return err
	}
	err = call(route)
	s.noteTransportError(err)
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
			ID       string `json:"id"`
			Name     string `json:"name"`
		} `json:"models"`
	}
	if err := json.Unmarshal(resp.Data, &wire); err != nil {
		return nil, err
	}
	out := make([]Model, len(wire.Models))
	for i, x := range wire.Models {
		if x.ModelID == "" {
			x.ModelID = x.ID
		}
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
	return decodeCommands(resp.Data)
}

func decodeCommands(data []byte) ([]CommandInfo, error) {
	var wire struct {
		Commands []struct {
			Name        string             `json:"name"`
			Description string             `json:"description"`
			Source      string             `json:"source"`
			Syntax      string             `json:"syntax"`
			SourceInfo  *CommandSourceInfo `json:"sourceInfo"`
		} `json:"commands"`
	}
	if err := json.Unmarshal(data, &wire); err != nil {
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
	s.nameMu.Lock()
	defer s.nameMu.Unlock()

	s.lifecycleMu.Lock()
	route, err := s.routeLocked()
	s.lifecycleMu.Unlock()
	if err != nil {
		return err
	}
	if err := s.persistName(ctx, name, NameSourceUser); err != nil {
		return err
	}
	s.lifecycleMu.Lock()
	if _, err = s.routeLocked(); err == nil {
		s.title, s.nameSource = name, NameSourceUser
		s.publishLocked(Frame{Kind: FrameName, SessionID: s.durableID, Data: map[string]any{"name": name, "origin": NameSourceUser}})
	}
	s.lifecycleMu.Unlock()
	if err != nil {
		return err
	}
	_, err = s.client.Call(ctx, omorpc.SetSessionName{SessionID: route, Name: name})
	s.noteTransportError(err)
	return err
}

func (s *Session) applyAutoTitle(ctx context.Context, prompt string) {
	name := DeriveSessionTitle(prompt)
	if name == "" {
		return
	}
	s.nameMu.Lock()
	defer s.nameMu.Unlock()

	cur, err := s.currentCursor(ctx)
	if err != nil {
		return
	}
	s.lifecycleMu.Lock()
	if cur.NameSource == NameSourceUser {
		s.title, s.nameSource = cur.Name, NameSourceUser
	}
	if s.closed || s.closing || s.resumable || s.title != "" || s.nameSource == NameSourceUser {
		s.lifecycleMu.Unlock()
		return
	}
	route := s.routingID
	s.lifecycleMu.Unlock()

	cur.Name, cur.NameSource = name, NameSourceAuto
	if err := s.manager.cfg.Store.SaveCursor(ctx, s.chatID, cur); err != nil {
		return
	}
	s.lifecycleMu.Lock()
	if !s.closed && !s.closing && !s.resumable && s.title == "" && s.nameSource != NameSourceUser {
		s.title, s.nameSource = name, NameSourceAuto
		s.publishLocked(Frame{Kind: FrameName, SessionID: s.durableID, Data: map[string]any{"name": name, "origin": NameSourceAuto}})
	}
	s.lifecycleMu.Unlock()
	_, _ = s.client.Call(ctx, omorpc.SetSessionName{SessionID: route, Name: name})
}

func (s *Session) applyProviderName(name string) {
	if name == "" {
		return
	}
	s.nameMu.Lock()
	defer s.nameMu.Unlock()

	ctx := context.Background()
	cur, err := s.currentCursor(ctx)
	if err != nil {
		return
	}
	s.lifecycleMu.Lock()
	if cur.NameSource == NameSourceUser {
		s.title, s.nameSource = cur.Name, NameSourceUser
	}
	if s.closed || s.closing || s.resumable || s.nameSource == NameSourceUser {
		s.lifecycleMu.Unlock()
		return
	}
	s.lifecycleMu.Unlock()

	cur.Name, cur.NameSource = name, NameSourceAuto
	if err := s.manager.cfg.Store.SaveCursor(ctx, s.chatID, cur); err != nil {
		return
	}
	s.lifecycleMu.Lock()
	if !s.closed && !s.closing && !s.resumable && s.nameSource != NameSourceUser {
		s.title, s.nameSource = name, NameSourceAuto
		s.publishLocked(Frame{Kind: FrameName, SessionID: s.durableID, Data: map[string]any{"name": name, "origin": "provider"}})
	}
	s.lifecycleMu.Unlock()
}

func (s *Session) currentCursor(ctx context.Context) (Cursor, error) {
	if s.manager.cfg.Store == nil {
		return Cursor{}, errors.New("session: nil cursor store")
	}
	return s.manager.cfg.Store.CursorFor(ctx, s.chatID)
}

func (s *Session) persistName(ctx context.Context, name, source string) error {
	cur, err := s.currentCursor(ctx)
	if err != nil {
		return err
	}
	cur.Name, cur.NameSource = name, source
	return s.manager.cfg.Store.SaveCursor(ctx, s.chatID, cur)
}

// RespondApproval publishes the correlated acceptance ack before notifying the
// provider, preserving ordering with any stream resumed by that response.
func (s *Session) RespondApproval(id string, value json.RawMessage, confirmed *bool, cancelled bool) error {
	return s.respondApproval(id, id, value, confirmed, cancelled)
}

// RespondApprovalRequest preserves the provider-native approval id while
// correlating the acknowledgement with the browser's request id. Value is
// encoded as a JSON string; it is never reinterpreted as client-supplied JSON.
func (s *Session) RespondApprovalRequest(ctx context.Context, id, requestID, value string, confirmed *bool, cancelled bool) error {
	encoded, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return s.respondApprovalContext(ctx, id, requestID, encoded, confirmed, cancelled)
}

func (s *Session) respondApproval(id, requestID string, value json.RawMessage, confirmed *bool, cancelled bool) error {
	return s.respondApprovalContext(context.Background(), id, requestID, value, confirmed, cancelled)
}

func (s *Session) respondApprovalContext(ctx context.Context, id, requestID string, value json.RawMessage, confirmed *bool, cancelled bool) error {
	s.lifecycleMu.Lock()
	route, err := s.routeLocked()
	if err == nil {
		s.publishLocked(Frame{Kind: FrameAck, SessionID: s.durableID, Command: omorpc.CmdExtensionUIResponse, RequestID: requestID, ApprovalID: id})
	}
	s.lifecycleMu.Unlock()
	if err != nil {
		return err
	}
	return s.client.Notify(ctx, omorpc.ExtensionUIResponse{SessionID: route, ID: id, Value: value, Confirmed: confirmed, Cancelled: cancelled})
}

func (s *Session) Attach(sub Subscriber) func() {
	detach, _ := s.attachChecked(sub)
	if detach == nil {
		return func() {}
	}
	return detach
}

// ActivitySnapshot returns a stable copy of the latest bounded activity
// projections in replay order.
func (s *Session) ActivitySnapshot() []Frame {
	s.lifecycleMu.Lock()
	defer s.lifecycleMu.Unlock()
	out := make([]Frame, 0, len(activitySnapshotOrder))
	for _, name := range activitySnapshotOrder {
		if data := s.activitySnapshots[name]; len(data) > 0 {
			out = append(out, Frame{Kind: FrameExtensionEvent, SessionID: s.durableID, Data: extensionFrameData(name, data, s.activityOversized[name])})
		}
	}
	return out
}

func (s *Session) attachChecked(sub Subscriber) (func(), error) {
	s.lifecycleMu.Lock()
	if s.closed || s.closing {
		s.lifecycleMu.Unlock()
		return nil, ErrSessionClosed
	}
	if s.resumable {
		s.lifecycleMu.Unlock()
		return nil, ErrSessionResumable
	}
	s.cancelIdleLocked()
	initial := make([]Frame, 0, 3)
	if s.readyPublished {
		initial = append(initial, Frame{Kind: FrameReady, SessionID: s.durableID, Resumed: s.resumed})
	}
	for _, name := range activitySnapshotOrder {
		if data := s.activitySnapshots[name]; len(data) > 0 {
			initial = append(initial, Frame{Kind: FrameExtensionEvent, SessionID: s.durableID, Data: extensionFrameData(name, data, s.activityOversized[name])})
		}
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
	}, nil
}

func (s *Session) Close() error { return s.closeContext(context.Background()) }
func (s *Session) closeContext(ctx context.Context) error {
	s.lifecycleMu.Lock()
	if s.closed {
		s.lifecycleMu.Unlock()
		return nil
	}
	s.closing = true
	s.cancelIdleLocked()
	route := s.routingID
	s.lifecycleMu.Unlock()

	_, err := s.client.Call(ctx, omorpc.CloseSession{SessionID: route})
	s.manager.mu.Lock()
	managerClosed := s.manager.closed
	s.manager.mu.Unlock()
	if !definitiveCloseFailure(err) && !managerClosed {
		s.lifecycleMu.Lock()
		s.closing = false
		// Provider events are otherwise suppressed while close_session owns the
		// route. Replay a buffered run terminal before reviving the session so a
		// failed close cannot leave stale in-flight latches or suppress eviction.
		s.reconcileFailedCloseLocked()
		s.scheduleIdleLocked()
		s.lifecycleMu.Unlock()
		return err
	}

	s.lifecycleMu.Lock()
	s.closed = true
	s.closing = false
	s.closeRunSettled = false
	s.closeRunReason = ""
	s.cancelIdleLocked()
	s.manager.mu.Lock()
	if s.manager.byChat[s.chatID] == s {
		delete(s.manager.byChat, s.chatID)
		delete(s.manager.byRoute, route)
		s.manager.bumpSlotGenerationLocked(s.chatID)
	}
	s.manager.mu.Unlock()
	s.lifecycleMu.Unlock()
	s.broadcast.close(ErrSubscriberSessionEnd)
	if definitiveCloseFailure(err) {
		return nil
	}
	return err
}
func definitiveCloseFailure(err error) bool {
	if err == nil {
		return true
	}
	var stable *omorpc.StableError
	return errors.As(err, &stable) && (stable.Code == omorpc.ErrCodeUnknownSession || stable.Code == omorpc.ErrCodeSessionClosing)
}

func (s *Session) retireReplaced() {
	s.lifecycleMu.Lock()
	s.closed = true
	s.cancelIdleLocked()
	s.lifecycleMu.Unlock()
	s.broadcast.close(ErrSubscriberSessionEnd)
}
func (s *Session) publishError(info ErrorInfo) {
	s.lifecycleMu.Lock()
	if !s.closed {
		s.publishLocked(Frame{Kind: FrameError, SessionID: s.durableID, Data: info})
	}
	s.lifecycleMu.Unlock()
}

func (s *Session) noteTransportError(err error) {
	if errors.Is(err, omorpc.ErrDisconnected) {
		s.manager.invalidateEpoch(s.epoch)
	}
}

func (s *Session) activeLocked() bool {
	return s.promptInFlight || s.providerRunActive || s.compactionActive || s.localCommandActive
}
func (s *Session) summary() (Summary, bool) {
	s.lifecycleMu.Lock()
	defer s.lifecycleMu.Unlock()
	if s.closed || s.closing || s.resumable {
		return Summary{}, false
	}
	return Summary{
		ChatID: s.chatID, DurableSessionID: s.durableID, SessionFile: s.sessionFile,
		CWD: s.cwd, Active: s.activeLocked(), Attachments: s.broadcast.count(), Title: s.title,
		ActivityPair: ActivityPair{
			Task: append(json.RawMessage(nil), s.activitySnapshots[activitySnapshotOrder[0]]...),
			Dag:  append(json.RawMessage(nil), s.activitySnapshots[activitySnapshotOrder[1]]...),
		},
		TaskOversized: s.activityOversized[activitySnapshotOrder[0]],
		DagOversized:  s.activityOversized[activitySnapshotOrder[1]],
		TaskDigest:    cloneTaskDigest(s.taskDigest),
		DagDigest:     cloneDagDigest(s.dagDigest),
	}, true
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
	if s.closed || s.closing || s.resumable || s.activeLocked() || s.broadcast.count() != 0 {
		return
	}
	s.cancelIdleLocked()
	s.idleTimer = time.AfterFunc(s.idleAfter, func() { s.manager.evict(s) })
}

func chunkEntries(arr []json.RawMessage) [][]json.RawMessage {
	if len(arr) == 0 {
		return nil
	}
	pages := make([][]json.RawMessage, 0, len(arr)/entriesPageMaxCount+1)
	var current []json.RawMessage
	size := 0
	flush := func() {
		if len(current) > 0 {
			pages = append(pages, current)
			current = nil
			size = 0
		}
	}
	for _, entry := range arr {
		if len(current) >= entriesPageMaxCount || (len(current) > 0 && size+len(entry) > entriesPageMaxBytes) {
			flush()
		}
		current = append(current, entry)
		size += len(entry)
	}
	flush()
	return pages
}
func (s *Session) publishEntriesLocked(entries []json.RawMessage, leaf string) {
	pages := chunkEntries(entries)
	if len(pages) == 0 {
		pages = [][]json.RawMessage{{}}
	}
	for i, page := range pages {
		final := i == len(pages)-1
		leafID := ""
		if final {
			leafID = leaf
		}
		s.publishLocked(Frame{Kind: FrameEntries, SessionID: s.durableID, Data: EntriesFrame{Entries: page, LeafID: leafID, Final: final}})
	}
}

// LoadEntries streams the provider's paged history through the regular
// bounded subscriber path. It is used when attaching to an existing session.
func (s *Session) LoadEntries(ctx context.Context) { s.loadEntries(ctx) }

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
	if !json.Valid(resp.Data) {
		return
	}
	// A valid response with malformed fields still terminates history loading;
	// json.Unmarshal preserves any entries decoded before the bad field.
	_ = json.Unmarshal(resp.Data, &wire)
	s.lifecycleMu.Lock()
	if !s.closed && !s.resumable {
		s.publishEntriesLocked(wire.Entries, wire.LeafID)
	}
	s.lifecycleMu.Unlock()
}

func extensionFrameData(name string, data json.RawMessage, oversized bool) map[string]any {
	var decoded any
	if json.Unmarshal(data, &decoded) != nil {
		decoded = json.RawMessage(append([]byte(nil), data...))
	}
	out := map[string]any{"name": name, "data": decoded}
	if oversized {
		out["oversized"] = true
	}
	return out
}
