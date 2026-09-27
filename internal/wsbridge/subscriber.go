package wsbridge

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"net"
	"sync"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/coldhistory"
	"github.com/DevNewbie1826/omo-webchat/internal/session"
	"github.com/DevNewbie1826/omo-webchat/internal/wscontract"
)

const preActivationBufferCapacity = session.DefaultQueueSize + 1 + session.SendOperationLedgerCapacity + session.NoticeJournalCapacity + session.SubscriberOverflowTransferCapacity

type subscriberAttempt struct {
	ready        chan struct{}
	readyOnce    sync.Once
	detachSignal chan struct{}
	detachOnce   sync.Once
	recovery     *subscriberRecovery
}

func newSubscriberAttempt() *subscriberAttempt {
	return &subscriberAttempt{ready: make(chan struct{}), detachSignal: make(chan struct{})}
}

// subscriber buffers the complete attach-time replay plus the normal live-frame
// headroom until the bridge publishes its binding. Durable history starts after
// activation and is written synchronously, with the connection deadline
// bounding each page.
type subscriber struct {
	resume          *coldhistory.ResumeCursor
	conn            *connection
	mu              sync.Mutex
	active          bool
	detached        bool
	detachReason    error
	replaying       bool
	treatAsResumed  bool
	claim           queryBinding
	bindingID       string
	transferID      string
	transfer        *session.SubscriberOverflowTransfer
	abandoned       bool
	automatic       bool
	deliveredCursor *coldhistory.ResumeCursor
	historyCursor   coldhistory.ResumeCursor
	historyWritten  bool
	historyFailed   bool
	lastWriteError  error
	lastWriteKind   session.FrameKind
	lastWriteSize   int
	pending         []session.Frame
	overflowed      bool
	attempt         *subscriberAttempt
}

func newSubscriber(c *connection) *subscriber {
	return &subscriber{conn: c, bindingID: rand.Text(), transferID: rand.Text(), attempt: newSubscriberAttempt()}
}

// SynchronousAttach asks session's broadcaster to finish queueing its initial
// replay before Acquire returns.
func (*subscriber) SynchronousAttach() {}

func (s *subscriber) BeginReplay() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.detached {
		return
	}
	s.replaying = true
	if s.active {
		s.conn.beginReplay(s)
	}
}
func (s *subscriber) EndReplay() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.replaying {
		return
	}
	s.replaying = false
	if s.active {
		s.conn.endReplay(s)
	}
}

// DiscardHydrationAttempt runs after the failed session subscription has been
// detached and drained. A retry must activate again with its new binding claim,
// even when the failed attempt had already published ready and partial pages.
func (s *subscriber) DiscardHydrationAttempt() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.active && s.replaying {
		s.conn.endReplay(s)
	}
	s.active = false
	s.pending = nil
	s.overflowed = false
	s.replaying = false
	s.claim = queryBinding{}
	s.bindingID = rand.Text()
	s.detached = false
	s.detachReason = nil
	s.deliveredCursor = nil
	s.historyCursor = coldhistory.ResumeCursor{}
	s.historyWritten = false
	s.historyFailed = false
	s.lastWriteError = nil
	s.attempt = newSubscriberAttempt()
}
func (s *subscriber) ReplayBackpressure() (<-chan struct{}, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.attempt.detachSignal, s.replaying
}

// ProgressiveHistory reports whether the socket's client hello negotiated a
// contract version that accepts segmented head pages after the terminal tail
// page.
func (s *subscriber) HistoryResume() *coldhistory.ResumeCursor { return s.resume }

func (s *subscriber) ProgressiveHistory() bool {
	return s.conn.clientHelloVersion() >= ContractVersion
}

func (s *subscriber) Deliver(f session.Frame) { _ = s.DeliverFrame(f) }
func (s *subscriber) DeliverFrame(f session.Frame) error {
	s.mu.Lock()
	attempt := s.attempt
	if f.Kind == session.FrameReady {
		attempt.readyOnce.Do(func() { close(attempt.ready) })
	}
	if s.detached {
		err := s.detachReason
		if err == nil {
			err = session.ErrSubscriberDetached
		}
		s.mu.Unlock()
		return err
	}
	if !s.active {
		if len(s.pending) >= preActivationBufferCapacity {
			s.pending = s.pending[1:]
			s.overflowed = true
		}
		s.pending = append(s.pending, f)
		s.mu.Unlock()
		return nil
	}
	err := s.deliver(f)
	s.mu.Unlock()
	if err != nil {
		s.signalDetach()
	}
	return err
}
func (s *subscriber) activate(ctx context.Context, reattach bool) error {
	s.mu.Lock()
	attempt := s.attempt
	s.mu.Unlock()
	select {
	case <-attempt.ready:
	case <-attempt.detachSignal:
		return s.detachmentError()
	case <-ctx.Done():
		return ctx.Err()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.attempt != attempt {
		return session.ErrSubscriberDetached
	}
	if s.detached {
		if s.detachReason != nil {
			return s.detachReason
		}
		return session.ErrSubscriberDetached
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if s.active {
		return nil
	}
	claim, ok := s.conn.subscriberClaim(s)
	if !ok {
		return session.ErrSubscriberDetached
	}
	s.treatAsResumed = reattach
	s.claim = claim
	s.active = true
	if s.replaying {
		s.conn.beginReplay(s)
	}
	if s.overflowed {
		if s.replaying {
			s.conn.endReplay(s)
		}
		s.active = false
		s.pending = nil
		s.overflowed = false
		s.replaying = false
		s.claim = queryBinding{}
		s.bindingID = rand.Text()
		s.conn.logger().Warn("subscriber activation overflow; retrying attach", "reason", "pre_activation_buffer_overflow")
		return session.ErrSubscriberOverflow
	}
	for _, f := range s.pending {
		if err := s.deliver(f); err != nil {
			s.pending = nil
			go s.Cancel()
			return nil
		}
		if f.Kind == session.FrameEntries {
			s.noteHistoryDelivered(f)
		}
	}
	s.pending = nil
	return nil
}
func (s *subscriber) signalDetach() {
	s.signalDetachWithReason(session.ErrSubscriberDetached)
}

func (s *subscriber) signalDetachWithReason(reason error) {
	s.mu.Lock()
	attempt := s.attempt
	s.mu.Unlock()
	s.signalDetachAttemptWithReason(attempt, reason)
}

func (s *subscriber) signalDetachAttemptWithReason(attempt *subscriberAttempt, reason error) {
	attempt.detachOnce.Do(func() {
		s.mu.Lock()
		if s.attempt == attempt {
			s.detached = true
			s.detachReason = reason
			if s.active && s.replaying {
				s.conn.endReplay(s)
			}
			s.replaying = false
		}
		s.mu.Unlock()
		close(attempt.detachSignal)
		attempt.readyOnce.Do(func() { close(attempt.ready) })
	})
}

func (s *subscriber) detachmentError() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.detachReason != nil {
		return s.detachReason
	}
	return session.ErrSubscriberDetached
}
func (s *subscriber) wrapDetach(detach func()) func() {
	var once sync.Once
	return func() {
		once.Do(func() {
			s.signalDetach()
			detach()
		})
	}
}
func (s *subscriber) Cancel() error {
	s.signalDetach()
	s.mu.Lock()
	err, kind, size := s.lastWriteError, s.lastWriteKind, s.lastWriteSize
	s.mu.Unlock()
	cause := "detached"
	var timeout net.Error
	if errors.As(err, &timeout) && timeout.Timeout() {
		cause = "write_timeout"
	} else if err != nil || s.conn.closed.Load() {
		cause = "closed"
	}
	s.conn.logger().Warn("subscriber canceled; closing websocket cleanly", "reason", "subscriber_cancel", "cause", cause, "kind", kind, "size", size, "error", err)
	s.conn.closeWebSocket(1011, "subscriber canceled")
	return nil
}

func (s *subscriber) CancelDelivery() error {
	s.mu.Lock()
	attempt := s.attempt
	if attempt.recovery == nil {
		s.conn.stateMu.Lock()
		generation := uint64(0)
		if s.conn.sub == s && s.conn.sess != nil {
			generation = s.conn.bindingGeneration
		}
		s.conn.stateMu.Unlock()
		attempt.recovery = &subscriberRecovery{sub: s, attempt: attempt, bindingID: s.bindingID, generation: generation, occurredAt: s.conn.now()}
	}
	s.mu.Unlock()
	s.signalDetachAttemptWithReason(attempt, session.ErrSubscriberOverflow)
	return nil
}

func (s *subscriber) RecoverSubscriberOverflow() {
	s.mu.Lock()
	if recovery := s.attempt.recovery; recovery != nil {
		recovery.ready = true
	}
	s.mu.Unlock()
	s.signalRecovery()
}

func (s *subscriber) signalRecovery() {
	s.mu.Lock()
	defer s.mu.Unlock()
	recovery := s.attempt.recovery
	if recovery == nil || !recovery.ready || recovery.taken {
		return
	}
	s.conn.stateMu.Lock()
	if s.conn.sub == s && s.conn.sess != nil && recovery.generation == 0 {
		recovery.generation = s.conn.bindingGeneration
	}
	s.conn.stateMu.Unlock()
	s.conn.enqueueSubscriberRecovery(*recovery)
}

// The handle identifies the broadcaster AND the exact retained transfer. A
// late callback after unbind must release its own instance, not a newer one.
func (s *subscriber) RetainSubscriberOverflowTransfer(transfer *session.SubscriberOverflowTransfer) {
	s.mu.Lock()
	if s.abandoned || s.conn.closed.Load() {
		s.mu.Unlock()
		transfer.Release()
		return
	}
	old := s.transfer
	s.transfer = transfer
	s.mu.Unlock()
	if old != nil {
		old.Release()
	}
}

func (s *subscriber) releaseTransfer() {
	if s == nil {
		return
	}
	s.mu.Lock()
	s.abandoned = true
	transfer := s.transfer
	s.transfer = nil
	s.mu.Unlock()
	if transfer != nil {
		transfer.Release()
	}
}

func (s *subscriber) SubscriberOverflowTransferKey() string { return s.transferID }

func (s *subscriber) SubscriberOverflowTransfer() *session.SubscriberOverflowTransfer {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.transfer
}

func (s *subscriber) deliver(f session.Frame) error {
	s.historyWritten = false
	wire, err := mapFrame(f, s.claim.chatID, s.treatAsResumed)
	if err != nil {
		return err
	}
	if wire == nil {
		return nil
	}
	written, err := s.conn.writeIfCurrentResult(s.claim, wire)
	if err != nil {
		s.lastWriteError, s.lastWriteKind = err, f.Kind
		if data, marshalErr := json.Marshal(wire); marshalErr == nil {
			s.lastWriteSize = len(data)
		}
		return err
	}
	s.historyWritten = written
	if f.Kind == session.FrameReady {
		s.conn.startTodoWatch(s.claim)
	} else if todoInvalidation(f) {
		s.conn.markTodoDirty(s.claim)
	}
	return nil
}

// HistoryFrameDelivered is called by the subscription pump only after a
// successful delivery, before the terminal replay barrier is acknowledged.
func (s *subscriber) HistoryFrameDelivered(f session.Frame) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.noteHistoryDelivered(f)
}

func (s *subscriber) noteHistoryDelivered(f session.Frame) {
	if f.Kind == session.FrameError && s.historyWritten {
		s.historyFailed = true
		s.historyWritten = false
		return
	}
	page, ok := f.Data.(session.EntriesFrame)
	if f.Kind != session.FrameEntries || !ok || !s.historyWritten {
		return
	}
	s.historyWritten = false
	if page.Resume != nil && s.historyCursor.SessionID == "" {
		s.historyCursor = *page.Resume
	}
	if page.HistorySessionID != "" {
		s.historyCursor.SessionID = page.HistorySessionID
	} else if s.historyCursor.SessionID == "" {
		s.historyCursor.SessionID = f.SessionID
	}
	var first, last string
	for _, raw := range page.Entries {
		var entry struct {
			ID string `json:"id"`
		}
		if json.Unmarshal(raw, &entry) == nil && entry.ID != "" {
			if first == "" {
				first = entry.ID
			}
			last = entry.ID
		}
	}
	if first != "" && (s.historyCursor.FirstEntryID == "" || page.Segment == "head") {
		s.historyCursor.FirstEntryID = first
	}
	if last != "" && page.Segment != "head" {
		s.historyCursor.LastEntryID = last
	}
	if page.HistoryComplete != nil {
		s.historyCursor.HistoryComplete = *page.HistoryComplete
	} else if page.Final {
		s.historyCursor.HistoryComplete = true
	}
	if (page.Final || s.deliveredCursor != nil) && s.historyCursor.SessionID != "" && s.historyCursor.FirstEntryID != "" && s.historyCursor.LastEntryID != "" {
		cursor := s.historyCursor
		s.deliveredCursor = &cursor
	}
}

func (c *connection) subscriberClaim(s *subscriber) (queryBinding, bool) {
	c.stateMu.Lock()
	defer c.stateMu.Unlock()
	claim := queryBinding{chatID: c.chatID, generation: c.bindingGeneration, session: c.sess, bindingID: s.bindingID}
	ok := !c.closed.Load() && c.sub == s && claim.chatID != "" && claim.session != nil
	if ok {
		c.invalidateTodoWatchLocked()
		c.todoBindingID = s.bindingID
	}
	return claim, ok
}

func mapFrame(f session.Frame, chatID string, reattach bool) (any, error) {
	typ, ok := wscontract.FrameKindToWireName[string(f.Kind)]
	if !ok {
		return nil, nil
	}
	if chatID == "" {
		chatID = f.SessionID
	}
	switch f.Kind {
	case session.FrameReady:
		piSessionID := f.SessionID
		out := wscontract.ReadyFrame{Type: typ, SessionID: chatID, PISessionID: &piSessionID, Resumed: f.Resumed || reattach}
		if f.BindingID != "" {
			out.BindingID = &f.BindingID
		}
		return out, nil
	case session.FrameExtensionEvent:
		out := mergeMap(typ, chatID, dataMap(f.Data))
		delete(out, "bindingId")
		delete(out, "revision")
		if f.BindingID != "" {
			out["bindingId"] = f.BindingID
		}
		if f.Revision != 0 {
			out["revision"] = f.Revision
		}
		return out, nil
	case session.FrameEntries:
		x, ok := f.Data.(session.EntriesFrame)
		if !ok {
			return mergedFrame(typ, chatID, f.Data)
		}
		out := wscontract.EntriesFrame{Type: typ, SessionID: chatID, Entries: x.Entries, Final: x.Final}
		if x.HistorySessionID != "" {
			out.HistorySessionID = &x.HistorySessionID
		}
		if x.Resume != nil {
			out.Resume = &wscontract.HistoryResumeCursor{SessionID: x.Resume.SessionID, FirstEntryID: x.Resume.FirstEntryID, LastEntryID: x.Resume.LastEntryID, HistoryComplete: x.Resume.HistoryComplete}
		}
		if x.LeafID != "" {
			out.LeafID = &x.LeafID
		}
		if x.Segment != "" {
			segment := x.Segment
			out.Segment = &segment
		}
		if x.HistoryComplete != nil {
			out.HistoryComplete = x.HistoryComplete
		}
		return out, nil
	case session.FrameRunDone:
		x, _ := f.Data.(session.RunInfo)
		return wscontract.RunDoneFrame{Type: typ, SessionID: chatID, Reason: x.Reason}, nil
	case session.FrameRunStarted:
		return wscontract.RunStartedFrame{Type: typ, SessionID: chatID}, nil
	case session.FrameCompactionStart:
		return wscontract.CompactionStartedFrame{Type: typ, SessionID: chatID}, nil
	case session.FrameCompactionDone:
		x, _ := f.Data.(session.CompactionInfo)
		out := wscontract.CompactionDoneFrame{Type: typ, SessionID: chatID}
		if x.Error != "" {
			out.Error = &x.Error
		}
		return out, nil
	case session.FrameAck:
		// The bridge owns admission. Forward only the request-identified
		// terminal success, including retained outcomes replayed on attach.
		if f.Command == "chat.send" && f.Phase != "completed" {
			return nil, nil
		}
		out := wscontract.AckFrame{Type: typ, Command: f.Command}
		if chatID != "" {
			out.SessionID = &chatID
		}
		if f.RequestID != "" {
			out.RequestID = &f.RequestID
		}
		if f.Phase != "" {
			out.Phase = &f.Phase
		}
		if f.ApprovalID != "" {
			out.ID = &f.ApprovalID
		}
		return out, nil
	case session.FrameControlResult:
		m := dataMap(f.Data)
		success, _ := m["success"].(bool)
		out := wscontract.ControlResultFrame{Type: typ, SessionID: chatID, Command: f.Command, Success: success}
		if f.RequestID != "" {
			out.RequestID = &f.RequestID
		}
		if x, _ := m["message"].(string); x != "" {
			out.Message = &x
		}
		return out, nil
	case session.FrameError:
		return mapError(typ, chatID, f)
	case session.FrameNotice:
		m := dataMap(f.Data)
		kind, _ := m["kind"].(string)
		delete(m, "kind")
		at, _ := m["at"].(string)
		delete(m, "at")
		nid, _ := m["nid"].(string)
		delete(m, "nid")
		if at == "" {
			at = time.Now().Format(time.RFC3339Nano)
		}
		payload, _ := json.Marshal(m)
		out := wscontract.NoticeFrame{Type: typ, SessionID: chatID, Kind: kind, At: at, Payload: payload}
		if nid != "" {
			out.Nid = &nid
		}
		return out, nil
	case session.FrameApproval:
		m := dataMap(f.Data)
		if f.ApprovalID != "" {
			m["id"] = f.ApprovalID
		} else {
			m["id"] = stringField(m, "id")
		}
		return mergeMap(typ, chatID, m), nil
	case session.FrameTool:
		m := dataMap(f.Data)
		switch m["phase"] {
		case "start", "update", "end":
		case "done":
			m["phase"] = "end"
		default:
			m["phase"] = "update"
		}
		return mergeMap(typ, chatID, m), nil
	case session.FrameMessageDelta:
		m := dataMap(f.Data)
		if x, ok := m["delta"].(string); ok {
			m["delta"] = map[string]any{"kind": "text_delta", "delta": x}
		}
		return mergeMap(typ, chatID, m), nil
	default:
		return mergedFrame(typ, chatID, f.Data)
	}
}

func mapError(typ, chatID string, f session.Frame) (any, error) {
	info, ok := f.Data.(session.ErrorInfo)
	if !ok {
		return mergedFrame(typ, chatID, f.Data)
	}
	code := normalizedErrorCode(info.Code)
	m := map[string]any{"type": typ, "sessionId": chatID, "code": code, "message": info.Message}
	if f.Command != "" {
		m["command"] = f.Command
	}
	if f.RequestID != "" {
		m["requestId"] = f.RequestID
	}
	if code == "external-write-detected" {
		m["knownLeaf"] = info.KnownLeaf
		m["observedLeaf"] = info.ObservedLeaf
	}
	if code == "resume_failed" {
		m["dangling"] = info.Dangling
		m["storedIdentity"] = info.StoredIdentity.SessionFile
		if len(info.BranchCandidates) > 0 {
			cs := make([]wscontract.ResumeCandidate, len(info.BranchCandidates))
			for i, x := range info.BranchCandidates {
				cs[i] = wscontract.ResumeCandidate{ID: x, Name: x, HostPath: &x}
			}
			m["candidates"] = cs
		}
	}
	return m, nil
}
func mergedFrame(typ, sid string, data any) (any, error) {
	return mergeMap(typ, sid, dataMap(data)), nil
}
func mergeMap(typ, sid string, m map[string]any) map[string]any {
	out := map[string]any{"type": typ, "sessionId": sid}
	for k, v := range m {
		if k != "type" && k != "sessionId" {
			out[k] = v
		}
	}
	return out
}
func dataMap(v any) map[string]any {
	if v == nil {
		return map[string]any{}
	}
	if x, ok := v.(map[string]any); ok {
		return cloneMap(x)
	}
	b, err := json.Marshal(v)
	if err != nil {
		return map[string]any{}
	}
	var out map[string]any
	if json.Unmarshal(b, &out) != nil {
		return map[string]any{}
	}
	return out
}
func cloneMap(x map[string]any) map[string]any {
	out := make(map[string]any, len(x))
	for k, v := range x {
		out[k] = v
	}
	return out
}
func stringField(m map[string]any, k string) string { x, _ := m[k].(string); return x }

func normalizedErrorCode(code string) string {
	switch code {
	case "pi_eof", "resume_failed", "session_unloaded", "session_mismatch", "prompt_in_flight", "compaction_in_flight", "send_backpressure", "provider_error", "provider_disconnected", "reconnect_exhausted", "persist_failed", "decode_failed", "incomplete_history", "external-write-detected", "adoption_required", "session-active", "bad_frame", "unknown_type", "bad_create", "bad_provider", "no_workspace", "no_chat", "start_failed", "initialize_failed", "provider_overflow", "provider_timeout", "bad_approval", "bad_resume", "bad_send", "bad_set", "no_session", "send_failed", "compact_failed":
		return code
	default:
		return "provider_error"
	}
}

var _ session.Subscriber = (*subscriber)(nil)
var _ session.SynchronousAttachHook = (*subscriber)(nil)
var _ session.ProgressiveHistorySubscriber = (*subscriber)(nil)
var _ interface{ DeliverFrame(session.Frame) error } = (*subscriber)(nil)
