package session

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/coldhistory"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

const (
	maxCompletedCompactions  = 8
	maxActivitySnapshotBytes = 64 << 10
	entriesPageMaxBytes      = 256 << 10
	entriesPageMaxCount      = 100
	// SendOperationLedgerCapacity bounds request outcomes retained for reconnect replay.
	SendOperationLedgerCapacity = 64
	// busyAgentErrorPrefix is the observed response prefix when a prompt reaches
	// a route that is already processing another run.
	busyAgentErrorPrefix = "Agent is already processing"
)

var activitySnapshotOrder = [2]string{"omo.task.updated", "omo.dag.updated"}
var streamSessionHistory = coldhistory.Stream

type closeTransaction struct {
	done chan struct{}
	err  error
	idle bool
}

type sendOperationPhase uint8

const (
	sendOperationAdmitted sendOperationPhase = iota
	sendOperationRetrying
	sendOperationTerminal
)

type sendOperation struct {
	phase                sendOperationPhase
	outcome              Frame
	err                  error
	published            bool
	preserveRunAdmission bool
}

type sendOperationOwner struct {
	mu                sync.Mutex
	operations        map[string]sendOperation
	fifo              []string
	detachedMutations int
	activeDetached    atomic.Int32
	sessions          map[*Session]struct{}
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
	quarantineErr                                                           *ExternalWriteError
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
	sendOwner                                                               *sendOperationOwner
	closeTxn                                                                *closeTransaction
	idleTimer                                                               *time.Timer
	activitySnapshots                                                       map[string]json.RawMessage
	activityOversized                                                       map[string]bool
	title, nameSource                                                       string
	inPlace, sessionFileObserved                                            bool
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
	s.sendOwner = &sendOperationOwner{operations: make(map[string]sendOperation), sessions: map[*Session]struct{}{s: {}}}
	s.broadcast.onDetach = m.cfg.OnDetach
	return s
}

func (s *Session) ChatID() string      { return s.chatID }
func (s *Session) ID() string          { return s.durableID }
func (s *Session) RoutingID() string   { return s.routingID }
func (s *Session) SessionFile() string { return s.sessionFile }

func (s *Session) prepareWrite(ctx context.Context) error {
	// Cursor preparation may mutate durable state, so it is inside the route's
	// write fence rather than preceding the quarantine check.
	s.lifecycleMu.Lock()
	_, routeErr := s.routeLocked()
	s.lifecycleMu.Unlock()
	if routeErr != nil {
		return routeErr
	}
	// Every provider mutation pays one metadata lookup. Lstat verifies the
	// acquired file identity and read permission without hashing or rereading
	// the transcript at this latency-sensitive fence.
	if err := s.verifySessionFileIdentity(s.sessionFile, ""); err != nil {
		drift := err.(*ExternalWriteError)
		s.quarantineExternalWrite(drift, nil)
		return drift
	}
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

// acquisitionError reports route state in the same priority order as writes.
// In particular, quarantine remains terminal even if transport invalidation
// subsequently marks the provider route resumable.
func (s *Session) acquisitionError() error {
	s.lifecycleMu.Lock()
	defer s.lifecycleMu.Unlock()
	_, err := s.routeLocked()
	return err
}

func (s *Session) operationOwner() *sendOperationOwner {
	if s.sendOwner == nil {
		s.sendOwner = &sendOperationOwner{operations: make(map[string]sendOperation), sessions: map[*Session]struct{}{s: {}}}
	}
	return s.sendOwner
}

func (s *Session) inheritSendOperations(prior *Session) {
	if prior == nil || prior == s {
		return
	}
	owner := prior.operationOwner()
	owner.mu.Lock()
	delete(s.sendOwner.sessions, s)
	s.sendOwner = owner
	owner.sessions[s] = struct{}{}
	owner.mu.Unlock()
}

func (s *Session) releaseSendOperations() {
	if s.sendOwner == nil {
		return
	}
	s.sendOwner.mu.Lock()
	delete(s.sendOwner.sessions, s)
	s.sendOwner.mu.Unlock()
}

func (o *sendOperationOwner) rearmIdle() {
	if o.activeDetached.Load() != 0 {
		return
	}
	o.mu.Lock()
	sessions := make([]*Session, 0, len(o.sessions))
	for s := range o.sessions {
		sessions = append(sessions, s)
	}
	o.mu.Unlock()
	for _, s := range sessions {
		s.lifecycleMu.Lock()
		s.scheduleIdleLocked()
		s.lifecycleMu.Unlock()
	}
}

func (s *Session) routeLocked() (string, error) {
	if s.quarantineErr != nil {
		return "", s.quarantineErr
	}
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
	return s.sendPrompt(ctx, msg, images, false, "")
}

// SendPromptDetached admits a prompt through the provider write and leaves
// response completion to the session callback.
func (s *Session) SendPromptDetached(ctx context.Context, msg string, images []map[string]string) error {
	return s.SendPromptDetachedWithRequestID(ctx, msg, images, "")
}

// SendPromptDetachedWithRequestID preserves browser operation identity through
// detached response completion.
func (s *Session) SendPromptDetachedWithRequestID(ctx context.Context, msg string, images []map[string]string, requestID string) error {
	return s.SendPromptDetachedWithRequestIDAndCompletion(ctx, msg, images, requestID, nil)
}

// SendPromptDetachedWithRequestIDAndCompletion transfers terminal outcome
// ownership to complete while retaining the ordinary admission ledger entry.
func (s *Session) SendPromptDetachedWithRequestIDAndCompletion(ctx context.Context, msg string, images []map[string]string, requestID string, complete func(error)) error {
	if prior, duplicate := s.beginSendOperation(requestID); duplicate {
		return prior
	}
	err := s.sendPrompt(ctx, msg, images, true, requestID, complete)
	s.recordSendOperation(requestID, err)
	return err
}

func (s *Session) sendPrompt(ctx context.Context, msg string, images []map[string]string, detached bool, requestID string, detachedComplete ...func(error)) error {
	var sendComplete func(error)
	if len(detachedComplete) != 0 {
		sendComplete = detachedComplete[0]
	}
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

	complete := func(_ *omorpc.Response, _ omorpc.EpochToken, callErr error) {
		if callErr != nil && strings.HasPrefix(callErr.Error(), busyAgentErrorPrefix) {
			s.lifecycleMu.Lock()
			ownsPrompt := s.promptSeq == seq && s.promptInFlight
			s.lifecycleMu.Unlock()
			if !ownsPrompt {
				s.completePrompt(seq, msg, callErr)
				if detached {
					s.finishDetachedSend(callErr, "chat.send", requestID, sendComplete)
				}
				return
			}
			steerComplete := func(_ *omorpc.Response, _ omorpc.EpochToken, steerErr error) {
				s.completePrompt(seq, msg, steerErr)
				if detached {
					s.finishDetachedSend(steerErr, "chat.send", requestID, sendComplete)
				}
			}
			if detached {
				if steerErr := s.callDetachedMutation(ctx, omorpc.Steer{SessionID: route, Message: msg, Images: images}, steerComplete); steerErr != nil {
					s.completePrompt(seq, msg, steerErr)
					s.finishDetachedSend(steerErr, "chat.send", requestID, sendComplete)
				}
				return
			}
			_, _ = s.client.CallRetained(ctx, omorpc.Steer{SessionID: route, Message: msg, Images: images}, steerComplete)
			return
		}
		s.completePrompt(seq, msg, callErr)
		if detached {
			s.finishDetachedSend(callErr, "chat.send", requestID, sendComplete)
		}
	}
	if detached {
		err = s.callDetachedMutation(ctx, omorpc.Prompt{SessionID: route, Message: msg, Images: images}, complete)
		if err != nil {
			s.completePrompt(seq, msg, err)
		}
		return err
	}

	var retryErr error
	_, err = s.client.CallRetained(ctx, omorpc.Prompt{SessionID: route, Message: msg, Images: images}, func(resp *omorpc.Response, epoch omorpc.EpochToken, callErr error) {
		if callErr != nil && strings.HasPrefix(callErr.Error(), busyAgentErrorPrefix) {
			s.lifecycleMu.Lock()
			ownsPrompt := s.promptSeq == seq && s.promptInFlight
			s.lifecycleMu.Unlock()
			if !ownsPrompt {
				retryErr = callErr
				s.completePrompt(seq, msg, callErr)
				return
			}
			_, retryErr = s.client.CallRetained(ctx, omorpc.Steer{SessionID: route, Message: msg, Images: images}, func(_ *omorpc.Response, _ omorpc.EpochToken, steerErr error) {
				s.completePrompt(seq, msg, steerErr)
			})
			return
		}
		retryErr = callErr
		complete(resp, epoch, callErr)
	})
	if err != nil && strings.HasPrefix(err.Error(), busyAgentErrorPrefix) {
		return retryErr
	}
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
	return s.sendDuringRun(ctx, false, "", func(route string) omorpc.Command {
		return omorpc.Steer{SessionID: route, Message: msg}
	})
}

// SendSteerDetached admits an in-run steer without waiting for its response.
func (s *Session) SendSteerDetached(ctx context.Context, msg string) error {
	return s.SendSteerDetachedWithRequestID(ctx, msg, "")
}

// SendSteerDetachedWithRequestID preserves browser operation identity through
// detached response completion.
func (s *Session) SendSteerDetachedWithRequestID(ctx context.Context, msg, requestID string) error {
	return s.SendSteerDetachedWithRequestIDAndCompletion(ctx, msg, requestID, nil)
}

func (s *Session) SendSteerDetachedWithRequestIDAndCompletion(ctx context.Context, msg, requestID string, complete func(error)) error {
	if prior, duplicate := s.beginSendOperation(requestID); duplicate {
		return prior
	}
	err := s.sendDuringRun(ctx, true, requestID, func(route string) omorpc.Command {
		return omorpc.Steer{SessionID: route, Message: msg}
	}, complete)
	s.recordSendOperation(requestID, err)
	return err
}

func (s *Session) SendFollowUp(ctx context.Context, msg string, images []map[string]string) error {
	return s.sendDuringRun(ctx, false, "", func(route string) omorpc.Command {
		return omorpc.FollowUp{SessionID: route, Message: msg, Images: images}
	})
}

// SendFollowUpDetached admits an in-run follow-up without waiting for its response.
func (s *Session) SendFollowUpDetached(ctx context.Context, msg string, images []map[string]string) error {
	return s.SendFollowUpDetachedWithRequestID(ctx, msg, images, "")
}

// SendFollowUpDetachedWithRequestID preserves browser operation identity
// through detached response completion.
func (s *Session) SendFollowUpDetachedWithRequestID(ctx context.Context, msg string, images []map[string]string, requestID string) error {
	return s.SendFollowUpDetachedWithRequestIDAndCompletion(ctx, msg, images, requestID, nil)
}

func (s *Session) SendFollowUpDetachedWithRequestIDAndCompletion(ctx context.Context, msg string, images []map[string]string, requestID string, complete func(error)) error {
	if prior, duplicate := s.beginSendOperation(requestID); duplicate {
		return prior
	}
	err := s.sendDuringRun(ctx, true, requestID, func(route string) omorpc.Command {
		return omorpc.FollowUp{SessionID: route, Message: msg, Images: images}
	}, complete)
	s.recordSendOperation(requestID, err)
	return err
}

func (s *Session) sendDuringRun(ctx context.Context, detached bool, requestID string, command func(string) omorpc.Command, detachedComplete ...func(error)) error {
	var sendComplete func(error)
	if len(detachedComplete) != 0 {
		sendComplete = detachedComplete[0]
	}
	if err := s.prepareWrite(ctx); err != nil {
		return err
	}
	retryAdmission := s.consumeRetryRunAdmission(requestID)
	s.lifecycleMu.Lock()
	// Steer and follow-up are accepted while a prompt, provider run, or
	// standalone compaction is active and queue with that work. A replacement
	// route may not have observed the original run events, so an admitted retry
	// carries exactly one authoritative in-run admission across that boundary.
	active := s.promptInFlight || s.providerRunActive || s.compactionActive
	if !active && !retryAdmission {
		s.lifecycleMu.Unlock()
		return ErrPromptInFlight
	}
	route, err := s.routeLocked()
	s.lifecycleMu.Unlock()
	if err != nil {
		return err
	}
	complete := func(_ *omorpc.Response, _ omorpc.EpochToken, callErr error) {
		s.noteTransportError(callErr)
		if detached {
			s.finishDetachedSend(callErr, "chat.send", requestID, sendComplete)
		}
	}
	if detached {
		err = s.callDetachedMutation(ctx, command(route), complete)
		if err != nil {
			s.noteTransportError(err)
		}
		return err
	}
	_, err = s.client.CallRetained(ctx, command(route), complete)
	return err
}

func (s *Session) callDetachedMutation(ctx context.Context, command omorpc.Command, complete func(*omorpc.Response, omorpc.EpochToken, error)) error {
	owner := s.operationOwner()
	owner.mu.Lock()
	if owner.detachedMutations >= DetachedMutationLimit {
		owner.mu.Unlock()
		return fmt.Errorf("%w: maximum %d outstanding operations", ErrSendBackpressure, DetachedMutationLimit)
	}
	owner.detachedMutations++
	owner.activeDetached.Add(1)
	owner.mu.Unlock()

	err := s.client.CallDetached(ctx, command, func(resp *omorpc.Response, epoch omorpc.EpochToken, callErr error) {
		owner.mu.Lock()
		owner.detachedMutations--
		owner.mu.Unlock()
		complete(resp, epoch, callErr)
		owner.activeDetached.Add(-1)
		owner.rearmIdle()
	})
	if err != nil {
		owner.mu.Lock()
		owner.detachedMutations--
		owner.mu.Unlock()
		owner.activeDetached.Add(-1)
		owner.rearmIdle()
	}
	return err
}

func (s *Session) finishDetachedSend(err error, command, requestID string, complete func(error)) {
	if complete != nil {
		if err != nil {
			s.lifecycleMu.Lock()
			switch {
			case s.quarantineErr != nil:
				err = s.quarantineErr
			case s.resumable:
				err = ErrSessionResumable
			case s.closed || s.closing:
				err = ErrSessionClosed
			}
			s.lifecycleMu.Unlock()
		}
		complete(err)
		return
	}
	s.publishDetachedOutcome(err, command, requestID)
}

// PrepareDetachedSendRetry atomically claims the one retry owned by an
// admitted operation. A completion that wins first leaves a terminal outcome
// and prevents the provider mutation from being repeated.
func (s *Session) PrepareDetachedSendRetry(requestID string, preserveRunAdmission bool) bool {
	if requestID == "" {
		return true
	}
	owner := s.operationOwner()
	owner.mu.Lock()
	defer owner.mu.Unlock()
	operation, ok := owner.operations[requestID]
	if !ok || operation.phase != sendOperationAdmitted {
		return false
	}
	operation.phase = sendOperationRetrying
	operation.preserveRunAdmission = preserveRunAdmission
	owner.operations[requestID] = operation
	return true
}

// CompleteDetachedSend publishes and retains a terminal outcome owned by a
// transport completion callback.
func (s *Session) CompleteDetachedSend(requestID string, err error) {
	s.publishDetachedOutcome(err, "chat.send", requestID)
}

// PublishSendOperationError publishes an acquisition failure as the terminal
// outcome for the original request, replacing a synchronous admission error.
func (s *Session) PublishSendOperationError(requestID string, info ErrorInfo) {
	frame := Frame{Kind: FrameError, SessionID: s.durableID, Command: "chat.send", RequestID: requestID, Data: info}
	owner := s.operationOwner()
	owner.mu.Lock()
	if requestID != "" {
		operation, ok := owner.operations[requestID]
		if !ok || operation.published {
			owner.mu.Unlock()
			return
		}
		operation.phase = sendOperationTerminal
		operation.outcome = frame
		operation.err = errors.New(info.Message)
		operation.published = true
		owner.operations[requestID] = operation
	}
	owner.publishLocked(frame)
	owner.mu.Unlock()
}

func (s *Session) publishDetachedOutcome(err error, command, requestID string) {
	if err == nil && requestID == "" {
		return
	}
	owner := s.operationOwner()
	owner.mu.Lock()
	if requestID == "" {
		frame := s.sendOperationFrameLocked("", err)
		frame.Command = command
		owner.publishLocked(frame)
		owner.mu.Unlock()
		return
	}
	_, _ = s.completeSendOperationLocked(requestID, err)
	operation, ok := owner.operations[requestID]
	if ok && operation.phase == sendOperationTerminal && !operation.published {
		operation.outcome.Command = command
		operation.published = true
		owner.operations[requestID] = operation
		owner.publishLocked(operation.outcome)
	}
	owner.mu.Unlock()
}

func (o *sendOperationOwner) publishLocked(frame Frame) {
	for target := range o.sessions {
		target.lifecycleMu.Lock()
		if !target.closed {
			target.publishLocked(frame)
		}
		target.lifecycleMu.Unlock()
	}
}

func (s *Session) beginSendOperation(requestID string) (error, bool) {
	if requestID == "" {
		return nil, false
	}
	owner := s.operationOwner()
	owner.mu.Lock()
	defer owner.mu.Unlock()
	if operation, ok := owner.operations[requestID]; ok {
		if operation.phase == sendOperationRetrying {
			operation.phase = sendOperationAdmitted
			owner.operations[requestID] = operation
			return nil, false
		}
		return operation.err, true
	}
	if len(owner.fifo) >= SendOperationLedgerCapacity {
		terminal := -1
		for i, id := range owner.fifo {
			if owner.operations[id].phase == sendOperationTerminal {
				terminal = i
				break
			}
		}
		if terminal < 0 {
			return fmt.Errorf("%w: maximum %d operations are still in flight", ErrSendBackpressure, SendOperationLedgerCapacity), true
		}
		delete(owner.operations, owner.fifo[terminal])
		copy(owner.fifo[terminal:], owner.fifo[terminal+1:])
		owner.fifo = owner.fifo[:len(owner.fifo)-1]
	}
	owner.operations[requestID] = sendOperation{phase: sendOperationAdmitted}
	owner.fifo = append(owner.fifo, requestID)
	return nil, false
}

// recordSendOperation stores the synchronous admission outcome. A failed
// admission is terminal because no provider response remains outstanding. Its
// broadcast remains separately claimable by the transport completion path.
func (s *Session) recordSendOperation(requestID string, err error) {
	if requestID == "" {
		return
	}
	owner := s.operationOwner()
	owner.mu.Lock()
	if operation, ok := owner.operations[requestID]; ok && operation.phase != sendOperationTerminal {
		operation.outcome = s.sendOperationFrameLocked(requestID, err)
		operation.err = err
		if err != nil && !errors.Is(err, ErrSessionResumable) && !errors.Is(err, ErrSessionClosed) {
			operation.phase = sendOperationTerminal
		}
		owner.operations[requestID] = operation
	}
	owner.mu.Unlock()
}

// completeSendOperation records the provider response as the terminal outcome.
func (s *Session) completeSendOperation(requestID string, err error) {
	if requestID == "" {
		return
	}
	owner := s.operationOwner()
	owner.mu.Lock()
	s.completeSendOperationLocked(requestID, err)
	owner.mu.Unlock()
}

// completeSendOperationLocked returns the retained terminal snapshot and
// whether this caller won completion. sendOwner.mu is held.
func (s *Session) completeSendOperationLocked(requestID string, err error) (Frame, bool) {
	frame := s.sendOperationFrameLocked(requestID, err)
	operation, ok := s.sendOwner.operations[requestID]
	if !ok || operation.phase == sendOperationTerminal {
		return frame, false
	}
	operation.phase = sendOperationTerminal
	operation.outcome = frame
	if err == nil {
		operation.outcome.Phase = "completed"
	}
	operation.err = err
	s.sendOwner.operations[requestID] = operation
	return operation.outcome, true
}

func (s *Session) consumeRetryRunAdmission(requestID string) bool {
	if requestID == "" {
		return false
	}
	owner := s.operationOwner()
	owner.mu.Lock()
	defer owner.mu.Unlock()
	operation, ok := owner.operations[requestID]
	if !ok || !operation.preserveRunAdmission {
		return false
	}
	operation.preserveRunAdmission = false
	owner.operations[requestID] = operation
	return true
}

func (s *Session) sendOperationFrameLocked(requestID string, err error) Frame {
	if err == nil {
		return Frame{Kind: FrameAck, SessionID: s.durableID, Command: "chat.send", RequestID: requestID}
	}
	info := ErrorInfo{Code: "provider_error", Message: err.Error()}
	switch {
	case errors.Is(err, ErrPromptInFlight):
		info.Code = "prompt_in_flight"
	case errors.Is(err, ErrCompactionInFlight):
		info.Code = "compaction_in_flight"
	case errors.Is(err, ErrSendBackpressure):
		info.Code = "send_backpressure"
	default:
		var drift *ExternalWriteError
		if errors.As(err, &drift) {
			info.Code = "external-write-detected"
			info.KnownLeaf = drift.KnownLeaf
			info.ObservedLeaf = drift.ObservedLeaf
		}
	}
	return Frame{Kind: FrameError, SessionID: s.durableID, Command: "chat.send", RequestID: requestID, Data: info}
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
		s.publishDetachedOutcome(callErr, "chat.abort", "")
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
	return s.compact(ctx, false)
}

// CompactDetached admits compaction through the provider write and leaves
// response completion to the session callback.
func (s *Session) CompactDetached(ctx context.Context) error {
	return s.compact(ctx, true)
}

func (s *Session) compact(ctx context.Context, detached bool) error {
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

	complete := func(_ *omorpc.Response, _ omorpc.EpochToken, completionErr error) {
		s.completeCompact(seq, rpcID, completionErr)
	}
	if detached {
		callErr := s.callDetachedMutation(ctx, omorpc.Compact{SessionID: route}, complete)
		if callErr != nil {
			s.completeCompact(seq, rpcID, callErr)
		}
		return callErr
	}
	_, callErr := s.client.CallRetained(ctx, omorpc.Compact{SessionID: route}, complete)
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
	if err := s.prepareWrite(ctx); err != nil {
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
	if s.closed || s.closing || s.resumable || s.quarantineErr != nil || s.title != "" || s.nameSource == NameSourceUser {
		s.lifecycleMu.Unlock()
		return
	}
	s.lifecycleMu.Unlock()

	if err := s.manager.cfg.Store.UpdateName(ctx, s.chatID, name, NameSourceAuto); err != nil {
		return
	}
	if err := s.prepareWrite(ctx); err != nil {
		return
	}
	s.lifecycleMu.Lock()
	route, err := s.routeLocked()
	committed := err == nil && s.title == "" && s.nameSource != NameSourceUser
	if committed {
		s.title, s.nameSource = name, NameSourceAuto
		s.publishLocked(Frame{Kind: FrameName, SessionID: s.durableID, Data: map[string]any{"name": name, "origin": NameSourceAuto}})
	}
	s.lifecycleMu.Unlock()
	if committed {
		_, _ = s.client.Call(ctx, omorpc.SetSessionName{SessionID: route, Name: name})
	}
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
	if s.closed || s.closing || s.resumable || s.quarantineErr != nil || s.nameSource == NameSourceUser {
		s.lifecycleMu.Unlock()
		return
	}
	s.lifecycleMu.Unlock()

	if err := s.manager.cfg.Store.UpdateName(ctx, s.chatID, name, NameSourceAuto); err != nil {
		return
	}
	s.lifecycleMu.Lock()
	if !s.closed && !s.closing && !s.resumable && s.quarantineErr == nil && s.nameSource != NameSourceUser {
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
	owner := s.operationOwner()
	owner.mu.Lock()
	defer owner.mu.Unlock()
	s.lifecycleMu.Lock()
	if s.closed || s.closing {
		s.lifecycleMu.Unlock()
		return nil, nil, ErrSessionClosed
	}
	if s.quarantineErr != nil {
		err := s.quarantineErr
		s.lifecycleMu.Unlock()
		return nil, nil, err
	}
	if s.resumable {
		s.lifecycleMu.Unlock()
		return nil, nil, ErrSessionResumable
	}
	s.cancelIdleLocked()
	initial := make([]Frame, 0, 3+len(owner.fifo))
	if s.readyPublished {
		initial = append(initial, Frame{Kind: FrameReady, SessionID: s.durableID, Resumed: s.resumed})
	}
	for _, name := range activitySnapshotOrder {
		if data := s.activitySnapshots[name]; len(data) > 0 {
			initial = append(initial, Frame{Kind: FrameExtensionEvent, SessionID: s.durableID, Data: extensionFrameData(name, data, s.activityOversized[name])})
		}
	}
	for _, requestID := range owner.fifo {
		if outcome := owner.operations[requestID].outcome; outcome.Kind != "" {
			initial = append(initial, outcome)
		}
	}
	queueSize := s.queueSize
	if queueSize < len(initial) {
		queueSize = len(initial)
	}
	id, target, rawDetach := s.broadcast.attach(sub, queueSize, initial)
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
	s.releaseSendOperations()
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
	if s.closed || s.closing || s.resumable || s.quarantineErr != nil || s.activeLocked() || s.broadcast.count() != 0 ||
		(s.sendOwner != nil && s.sendOwner.activeDetached.Load() != 0) {
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

// ExternalWriteError is the typed route state applied when an in-place file
// diverges from the provider route that opened it. While present, every
// provider mutation is rejected until recovery closes the stale route.
type ExternalWriteError struct {
	KnownLeaf    string
	ObservedLeaf string
	Reason       string
	cause        error
}

func (e *ExternalWriteError) Error() string {
	return fmt.Sprintf("external write detected: %s (daemon leaf %q, disk leaf %q)", e.Reason, e.KnownLeaf, e.ObservedLeaf)
}

func (e *ExternalWriteError) Unwrap() error { return e.cause }

func externalIdentityReadError(err error) *ExternalWriteError {
	reason := "session file identity unavailable"
	if errors.Is(err, os.ErrNotExist) {
		reason = "session file disappeared"
	}
	return &ExternalWriteError{Reason: reason, cause: err}
}

func (s *Session) verifySessionFileIdentity(sessionPath, observedLeaf string) error {
	if !s.inPlace || s.sessionFileIdentity == nil {
		return nil
	}
	current, err := os.Lstat(sessionPath)
	if err != nil {
		drift := externalIdentityReadError(err)
		drift.ObservedLeaf = observedLeaf
		return drift
	}
	if !os.SameFile(s.sessionFileIdentity, current) {
		return &ExternalWriteError{ObservedLeaf: observedLeaf, Reason: "session file identity changed"}
	}
	if current.Mode().Perm()&0o444 == 0 {
		return &ExternalWriteError{ObservedLeaf: observedLeaf, Reason: "session file is not readable", cause: os.ErrPermission}
	}
	return nil
}

// quarantineExternalWrite latches and publishes the route transition once.
// A replay target is excluded from the broadcast because hydrateEntries emits
// the same transition as its terminal frame after all preceding disk pages.
func (s *Session) quarantineExternalWrite(err *ExternalWriteError, replayTarget *subscription) bool {
	s.lifecycleMu.Lock()
	defer s.lifecycleMu.Unlock()
	if s.closed || s.quarantineErr != nil {
		return false
	}
	s.quarantineErr = err
	s.cancelIdleLocked()
	frame := Frame{Kind: FrameError, SessionID: s.durableID, Data: historyErrorInfo(err)}
	s.broadcast.publishExcept(frame, replayTarget)
	return true
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
		var drift *ExternalWriteError
		if errors.As(err, &drift) {
			if !s.quarantineExternalWrite(drift, target) {
				if target != nil {
					if barrierErr := target.enqueueReplayBarrier(ctx); barrierErr != nil {
						target.retire(barrierErr)
					}
				}
				return
			}
			if target == nil {
				return
			}
		}
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

	if err := s.verifySessionFileIdentity(sessionPath, ""); err != nil {
		publishErr(err)
		return
	}

	metadata, err := streamSessionHistory(ctx, sessionPath, coldhistory.Options{
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
	// Every stream outcome except an absent path proves the file existed on
	// disk; only a first-ever absent path stays eligible for root hydration.
	if err == nil || !errors.Is(err, os.ErrNotExist) {
		s.lifecycleMu.Lock()
		s.sessionFileObserved = true
		s.lifecycleMu.Unlock()
	}
	if err == nil {
		err = ctx.Err()
	}
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			publishErr(err)
			return
		}
		if s.inPlace || s.sessionFileIdentity != nil {
			publishErr(externalIdentityReadError(err))
			return
		}
		s.lifecycleMu.Lock()
		rootHydrationAllowed := !s.resumed && !s.sessionFileObserved
		s.lifecycleMu.Unlock()
		if !rootHydrationAllowed {
			publishErr(err)
			return
		}
		// A newly opened session may report a path that is absent on disk.
		// In that state, get_entries without since returns the entries visible
		// from the root, and an empty response yields one terminal page.
		wire, rootErr := s.fetchEntriesAfter(ctx, "")
		if rootErr != nil {
			publishErr(rootErr)
			return
		}
		s.emitTailEntries(wire, emit, target)
		return
	}
	if err := s.verifySessionFileIdentity(sessionPath, metadata.LeafID); err != nil {
		publishErr(err)
		return
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
	s.emitTailEntries(wire, emit, target)
}

// emitTailEntries emits bounded pages with exactly one final page, including
// an empty final page when no entries are returned.
func (s *Session) emitTailEntries(wire entriesTail, emit func(Frame, bool) error, target *subscription) {
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
				return entriesTail{}, &ExternalWriteError{KnownLeaf: wire.LeafID, ObservedLeaf: since, Reason: "disk leaf is not the daemon session leaf"}
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
		var drift *ExternalWriteError
		if errors.As(err, &drift) {
			s.quarantineExternalWrite(drift, nil)
			return
		}
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
	var drift *ExternalWriteError
	if errors.As(err, &drift) {
		return ErrorInfo{Code: "external-write-detected", Message: err.Error(), KnownLeaf: drift.KnownLeaf, ObservedLeaf: drift.ObservedLeaf}
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
