package session

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sync"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/coldhistory"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

const (
	maxCompletedCompactions  = 8
	maxActivitySnapshotBytes = 64 << 10
	entriesPageMaxBytes      = 256 << 10
	entriesPageMaxCount      = 100
)

var activitySnapshotOrder = [2]string{"omo.task.updated", "omo.dag.updated"}

type closeTransaction struct {
	done chan struct{}
	err  error
	idle bool
}

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
	writePrepareMu                                                          sync.Mutex
	writePrepared                                                           bool
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
	closeTxn                                                                *closeTransaction
	idleTimer                                                               *time.Timer
	activitySnapshots                                                       map[string]json.RawMessage
	activityOversized                                                       map[string]bool
	title, nameSource                                                       string
	inPlace                                                                 bool
	sessionFileIdentity                                                     os.FileInfo
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

func (s *Session) prepareWrite(ctx context.Context) error {
	preparer, ok := s.manager.cfg.Store.(WritePreparer)
	if !ok {
		return nil
	}
	s.writePrepareMu.Lock()
	defer s.writePrepareMu.Unlock()
	if s.writePrepared {
		return nil
	}
	if err := preparer.PrepareWrite(ctx, s.chatID); err != nil {
		return err
	}
	s.writePrepared = true
	return nil
}

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
	if err := s.prepareWrite(ctx); err != nil {
		return err
	}
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

	_, err = s.client.CallRetained(ctx, omorpc.Prompt{SessionID: route, Message: msg, Images: images}, func(_ *omorpc.Response, _ omorpc.EpochToken, callErr error) {
		s.completePrompt(seq, msg, callErr)
	})
	return err
}

func (s *Session) completePrompt(seq uint64, msg string, callErr error) {
	s.noteTransportError(callErr)
	s.lifecycleMu.Lock()
	if s.promptSeq == seq {
		if callErr != nil && !s.providerRunActive {
			s.promptInFlight = false
			s.localCommandActive = false
			s.promptResponse = false
			s.scheduleIdleLocked()
		} else if callErr == nil {
			s.promptResponse = true
			if s.localCommandActive && s.localCommandSeq == seq {
				s.completeLocalCommandLocked(seq)
			}
		}
	}
	s.lifecycleMu.Unlock()
	if callErr == nil {
		s.applyAutoTitle(context.Background(), msg)
	}
}

func (s *Session) SendSteer(ctx context.Context, msg string) error {
	return s.sendDuringRun(ctx, func(route string) omorpc.Command {
		return omorpc.Steer{SessionID: route, Message: msg}
	})
}

func (s *Session) SendFollowUp(ctx context.Context, msg string) error {
	return s.sendDuringRun(ctx, func(route string) omorpc.Command {
		return omorpc.FollowUp{SessionID: route, Message: msg}
	})
}

func (s *Session) sendDuringRun(ctx context.Context, command func(string) omorpc.Command) error {
	if err := s.prepareWrite(ctx); err != nil {
		return err
	}
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
	_, err = s.client.CallRetained(ctx, command(route), func(_ *omorpc.Response, _ omorpc.EpochToken, callErr error) {
		s.noteTransportError(callErr)
	})
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
	if err := s.prepareWrite(ctx); err != nil {
		return err
	}
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
	if err := s.prepareWrite(ctx); err != nil {
		return err
	}
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

	_, callErr := s.client.CallRetained(ctx, omorpc.Compact{SessionID: route}, func(_ *omorpc.Response, _ omorpc.EpochToken, completionErr error) {
		s.completeCompact(seq, rpcID, completionErr)
	})
	return callErr
}

func (s *Session) completeCompact(seq uint64, rpcID string, callErr error) {
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
	return s.control(ctx, "set_model", requestID, func(route string) omorpc.Command {
		return omorpc.SetModel{SessionID: route, Provider: provider, ModelID: modelID}
	})
}
func (s *Session) SetThinking(ctx context.Context, level, requestID string) error {
	return s.control(ctx, "set_thinking", requestID, func(route string) omorpc.Command {
		return omorpc.SetThinkingLevel{SessionID: route, Level: level}
	})
}
func (s *Session) control(ctx context.Context, command, requestID string, build func(string) omorpc.Command) error {
	if err := s.prepareWrite(ctx); err != nil {
		return err
	}
	s.lifecycleMu.Lock()
	route, err := s.routeLocked()
	s.lifecycleMu.Unlock()
	if err != nil {
		return err
	}
	_, err = s.client.CallRetained(ctx, build(route), func(_ *omorpc.Response, _ omorpc.EpochToken, callErr error) {
		s.completeControl(command, requestID, callErr)
	})
	return err
}

func (s *Session) completeControl(command, requestID string, callErr error) {
	s.noteTransportError(callErr)
	s.lifecycleMu.Lock()
	data := map[string]any{"success": callErr == nil}
	if callErr != nil {
		data["message"] = callErr.Error()
	}
	s.publishLocked(Frame{Kind: FrameControlResult, SessionID: s.durableID, Command: command, RequestID: requestID, Data: data})
	s.lifecycleMu.Unlock()
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
	if err := s.prepareWrite(ctx); err != nil {
		return err
	}
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

	if err := s.manager.cfg.Store.UpdateName(ctx, s.chatID, name, NameSourceAuto); err != nil {
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

	if err := s.manager.cfg.Store.UpdateName(ctx, s.chatID, name, NameSourceAuto); err != nil {
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
	if s.manager.cfg.Store == nil {
		return errors.New("session: nil cursor store")
	}
	return s.manager.cfg.Store.UpdateName(ctx, s.chatID, name, source)
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
	if err := s.prepareWrite(ctx); err != nil {
		return err
	}
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
	detach, _, err := s.attachCheckedTarget(sub)
	return detach, err
}

func (s *Session) attachCheckedTarget(sub Subscriber) (func(), *subscription, error) {
	return s.attachCheckedTargetWithReplay(sub, false, nil)
}

// attachCheckedReplayTarget publishes the subscription, queues any explicit
// initial frames, and arms replay while lifecycleMu excludes live publication.
func (s *Session) attachCheckedReplayTarget(sub Subscriber, initial ...Frame) (func(), *subscription, error) {
	return s.attachCheckedTargetWithReplay(sub, true, initial)
}

func (s *Session) attachCheckedTargetWithReplay(sub Subscriber, replay bool, replayInitial []Frame) (func(), *subscription, error) {
	s.lifecycleMu.Lock()
	if s.closed || s.closing {
		s.lifecycleMu.Unlock()
		return nil, nil, ErrSessionClosed
	}
	if s.resumable {
		s.lifecycleMu.Unlock()
		return nil, nil, ErrSessionResumable
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
	id, target, rawDetach := s.broadcast.attach(sub, s.queueSize, initial)
	for _, frame := range replayInitial {
		s.publishLocked(frame)
	}
	if replay && target != nil {
		target.beginReplay()
	}
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
	}, target, nil
}

func (s *Session) Close() error { return s.closeContext(context.Background()) }
func (s *Session) closeContext(ctx context.Context) error {
	s.lifecycleMu.Lock()
	if s.closed {
		s.lifecycleMu.Unlock()
		return nil
	}
	txn := s.closeTxn
	owner := txn == nil
	if owner {
		txn = s.beginCloseLocked(false)
	}
	s.lifecycleMu.Unlock()

	if !owner {
		return waitCloseTransaction(ctx, txn)
	}
	return s.executeClose(ctx, txn)
}

func (s *Session) beginCloseLocked(idle bool) *closeTransaction {
	txn := &closeTransaction{done: make(chan struct{}), idle: idle}
	s.closeTxn = txn
	s.closing = true
	s.cancelIdleLocked()
	return txn
}

func (s *Session) executeClose(ctx context.Context, txn *closeTransaction) error {
	route := s.routingID
	_, err := s.client.CallRetained(ctx, omorpc.CloseSession{SessionID: route}, func(_ *omorpc.Response, _ omorpc.EpochToken, callErr error) {
		s.completeClose(txn, route, callErr)
	})
	return closeResult(err)
}

func waitCloseTransaction(ctx context.Context, txn *closeTransaction) error {
	select {
	case <-txn.done:
		return closeResult(txn.err)
	default:
	}
	select {
	case <-txn.done:
		return closeResult(txn.err)
	case <-ctx.Done():
		select {
		case <-txn.done:
			return closeResult(txn.err)
		default:
			return ctx.Err()
		}
	}
}

func closeResult(err error) error {
	if definitiveCloseFailure(err) {
		return nil
	}
	return err
}

func (s *Session) completeClose(txn *closeTransaction, route string, callErr error) {
	s.noteTransportError(callErr)
	s.manager.mu.Lock()
	managerClosed := s.manager.closed
	s.manager.mu.Unlock()
	accepted := definitiveCloseFailure(callErr)
	epochDead := errors.Is(callErr, omorpc.ErrDisconnected)

	s.lifecycleMu.Lock()
	if !accepted && !managerClosed {
		if !s.closed {
			s.closing = false
			s.closeTxn = nil
			if !epochDead {
				// Provider events are otherwise suppressed while close_session owns the
				// route. Replay a buffered run terminal before reviving the session so a
				// failed close cannot leave stale in-flight latches or suppress eviction.
				s.reconcileFailedCloseLocked()
				s.scheduleIdleLocked()
			}
		}
		txn.err = callErr
		close(txn.done)
		s.lifecycleMu.Unlock()
		return
	}

	newlyClosed := !s.closed
	if newlyClosed {
		s.closed = true
		s.closing = false
		s.closeTxn = nil
		s.closeRunSettled = false
		s.closeRunReason = ""
		s.cancelIdleLocked()
		if txn.idle {
			s.publishLocked(Frame{Kind: FrameError, SessionID: s.durableID, Data: ErrorInfo{Code: "session_unloaded", Message: "session unloaded after idle timeout"}})
		}
		s.manager.mu.Lock()
		s.manager.retireSessionIdentityLocked(s, true)
		s.manager.mu.Unlock()
	}
	txn.err = callErr
	close(txn.done)
	s.lifecycleMu.Unlock()
	if newlyClosed {
		s.broadcast.close(ErrSubscriberSessionEnd)
	}
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
	return s.summaryLocked(), true
}

func (s *Session) summaryLocked() Summary {
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
	}
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
func (s *Session) publishEntriesPageLocked(entries []json.RawMessage, leaf string, final bool) {
	pages := chunkEntries(entries)
	if len(pages) == 0 {
		pages = [][]json.RawMessage{{}}
	}
	for i, page := range pages {
		pageFinal := final && i == len(pages)-1
		pageLeaf := ""
		if pageFinal {
			pageLeaf = leaf
		}
		s.publishLocked(Frame{Kind: FrameEntries, SessionID: s.durableID, Data: EntriesFrame{Entries: page, LeafID: pageLeaf, Final: pageFinal}})
	}
}

// LoadEntries performs a bounded incremental refresh. An empty cursor is
// deliberately ignored: chat acquisition must never request a full transcript.
func (s *Session) LoadEntries(ctx context.Context, since string) {
	if since != "" {
		s.loadEntries(ctx, since)
	}
}

var errIncompleteHistory = errors.New("incomplete history")

type externalWriteError struct {
	knownLeaf    string
	observedLeaf string
	reason       string
}

func (e *externalWriteError) Error() string {
	return fmt.Sprintf("external write detected: %s (daemon leaf %q, disk leaf %q)", e.reason, e.knownLeaf, e.observedLeaf)
}

// hydrateEntries serves disk pages and the validated live tail only to target.
// A nil target is retained for direct callers and publishes through the normal
// broadcaster, but manager-driven attachment always supplies its subscription.
func (s *Session) hydrateEntries(ctx context.Context, sessionPath string, targets ...*subscription) {
	var target *subscription
	if len(targets) != 0 {
		target = targets[0]
	}
	emit := func(frame Frame, terminal bool) error {
		if target != nil {
			return target.enqueueReplay(ctx, frame, terminal)
		}
		s.lifecycleMu.Lock()
		defer s.lifecycleMu.Unlock()
		if s.closed || s.resumable {
			return ErrSessionResumable
		}
		s.publishLocked(frame)
		return nil
	}
	publishErr := func(err error) {
		if target != nil {
			// A history-context deadline is an expected, user-visible outcome:
			// the terminal error must still be delivered (non-blocking; the
			// pump ends replay after delivery) so the socket stays usable for
			// live frames. Only cancellation or a lost route retires the target,
			// because there terminal delivery cannot be acknowledged reliably
			// and retiring tears down replay instead of trapping live frames.
			if errors.Is(ctx.Err(), context.Canceled) || errors.Is(err, ErrSessionClosed) || errors.Is(err, ErrSessionResumable) || errors.Is(err, context.Canceled) {
				target.retire(err)
				return
			}
		} else if errors.Is(err, ErrSessionClosed) || errors.Is(err, ErrSessionResumable) || errors.Is(err, context.Canceled) {
			return
		}
		info := historyErrorInfo(err)
		frame := Frame{Kind: FrameError, SessionID: s.durableID, Data: info}
		if target != nil && errors.Is(ctx.Err(), context.DeadlineExceeded) {
			if !target.enqueueReplayTerminalNow(frame) {
				target.retire(ErrSubscriberDetached)
			}
			return
		}
		if emitErr := emit(frame, true); emitErr != nil && target != nil {
			target.retire(emitErr)
		}
	}

	metadata, err := coldhistory.Stream(ctx, sessionPath, coldhistory.Options{
		PageEntries: entriesPageMaxCount,
	}, func(metadata coldhistory.Metadata, page coldhistory.Page) error {
		if metadata.Header.ID != s.durableID {
			return fmt.Errorf("%w: disk session id %q does not match durable session %q", errIncompleteHistory, metadata.Header.ID, s.durableID)
		}
		if metadata.LeafID == "" {
			return nil
		}
		for _, entries := range chunkEntries(page.Entries) {
			if err := emit(Frame{Kind: FrameEntries, SessionID: s.durableID, Data: EntriesFrame{Entries: entries}}, false); err != nil {
				return err
			}
		}
		return nil
	})
	if err == nil {
		err = ctx.Err()
	}
	if err != nil {
		publishErr(err)
		return
	}
	if s.inPlace && s.sessionFileIdentity != nil {
		current, statErr := os.Lstat(sessionPath)
		if statErr != nil {
			publishErr(statErr)
			return
		}
		if !os.SameFile(s.sessionFileIdentity, current) {
			publishErr(&externalWriteError{observedLeaf: metadata.LeafID, reason: "session file identity changed"})
			return
		}
	}

	// A header is a durable identity but not an entry cursor. Probe the live
	// route so ignored/rejected cursor behavior is observed, then report the
	// history as incomplete rather than falling back to an unbounded dump.
	cursor := metadata.LeafID
	if cursor == "" {
		cursor = metadata.Header.ID
		if _, probeErr := s.fetchEntriesAfter(ctx, cursor); probeErr != nil && !errors.Is(probeErr, errIncompleteHistory) {
			publishErr(probeErr)
		} else {
			publishErr(fmt.Errorf("%w: durable session has no entry cursor", errIncompleteHistory))
		}
		return
	}
	wire, err := s.fetchEntriesAfter(ctx, cursor)
	if err != nil {
		publishErr(err)
		return
	}
	pages := chunkEntries(wire.Entries)
	if len(pages) == 0 {
		pages = [][]json.RawMessage{{}}
	}
	for i, entries := range pages {
		terminal := i == len(pages)-1
		leaf := ""
		if terminal {
			leaf = wire.LeafID
		}
		if err := emit(Frame{Kind: FrameEntries, SessionID: s.durableID, Data: EntriesFrame{Entries: entries, LeafID: leaf, Final: terminal}}, terminal); err != nil {
			if target != nil {
				target.retire(err)
			}
			return
		}
	}
}

type entriesTail struct {
	Entries []json.RawMessage `json:"entries"`
	LeafID  string            `json:"leafId"`
}

func (s *Session) fetchEntriesAfter(ctx context.Context, since string) (entriesTail, error) {
	s.lifecycleMu.Lock()
	route, err := s.routeLocked()
	s.lifecycleMu.Unlock()
	if err != nil {
		return entriesTail{}, err
	}
	resp, err := s.client.Call(ctx, omorpc.GetEntries{SessionID: route, Since: since})
	if err != nil {
		s.noteTransportError(err)
		return entriesTail{}, err
	}
	var wire entriesTail
	if !json.Valid(resp.Data) || json.Unmarshal(resp.Data, &wire) != nil {
		return entriesTail{}, errors.New("invalid get_entries response")
	}
	if len(wire.Entries) == 0 {
		if wire.LeafID != since {
			if s.inPlace {
				return entriesTail{}, &externalWriteError{knownLeaf: wire.LeafID, observedLeaf: since, reason: "disk leaf is not the daemon session leaf"}
			}
			return entriesTail{}, fmt.Errorf("%w: cursor %q was not retained (returned leaf %q)", errIncompleteHistory, since, wire.LeafID)
		}
		return wire, nil
	}
	parent := since
	for i, raw := range wire.Entries {
		var entry struct {
			ID       string          `json:"id"`
			ParentID json.RawMessage `json:"parentId"`
		}
		if json.Unmarshal(raw, &entry) != nil || entry.ID == "" || len(entry.ParentID) == 0 {
			return entriesTail{}, fmt.Errorf("%w: invalid tail entry %d", errIncompleteHistory, i)
		}
		var parentID string
		if json.Unmarshal(entry.ParentID, &parentID) != nil || parentID != parent {
			return entriesTail{}, fmt.Errorf("%w: tail entry %q does not chain from %q", errIncompleteHistory, entry.ID, parent)
		}
		parent = entry.ID
	}
	if wire.LeafID != parent {
		return entriesTail{}, fmt.Errorf("%w: declared leaf %q does not match tail leaf %q", errIncompleteHistory, wire.LeafID, parent)
	}
	return wire, nil
}

func (s *Session) loadEntries(ctx context.Context, since string) {
	if since == "" {
		return
	}
	wire, err := s.fetchEntriesAfter(ctx, since)
	if err != nil {
		s.publishHistoryError(err)
		return
	}
	s.lifecycleMu.Lock()
	if !s.closed && !s.resumable {
		s.publishEntriesPageLocked(wire.Entries, wire.LeafID, true)
	}
	s.lifecycleMu.Unlock()
}

func historyErrorInfo(err error) ErrorInfo {
	var drift *externalWriteError
	if errors.As(err, &drift) {
		return ErrorInfo{Code: "external-write-detected", Message: err.Error(), KnownLeaf: drift.knownLeaf, ObservedLeaf: drift.observedLeaf}
	}
	code := "decode_failed"
	if errors.Is(err, errIncompleteHistory) {
		code = "incomplete_history"
	} else if errors.Is(err, context.DeadlineExceeded) {
		code = "provider_timeout"
	} else if errors.Is(err, omorpc.ErrDisconnected) {
		code = "provider_error"
	}
	return ErrorInfo{Code: code, Message: "history load failed: " + err.Error()}
}

func (s *Session) publishHistoryError(err error) {
	if errors.Is(err, ErrSessionClosed) || errors.Is(err, ErrSessionResumable) || errors.Is(err, context.Canceled) {
		return
	}
	s.publishError(historyErrorInfo(err))
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
