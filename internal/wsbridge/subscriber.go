package wsbridge

import (
	"context"
	"encoding/json"
	"sync"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/session"
	"github.com/DevNewbie1826/omo-webchat/internal/wscontract"
)

const preActivationBufferCapacity = session.DefaultQueueSize + 1 + session.SendOperationLedgerCapacity

// subscriber buffers the complete attach-time replay plus the normal live-frame
// headroom until the bridge publishes its binding. Durable history starts after
// activation and is written synchronously, with the connection deadline
// bounding each page.
type subscriber struct {
	conn           *connection
	mu             sync.Mutex
	active         bool
	detached       bool
	replaying      bool
	treatAsResumed bool
	claim          queryBinding
	pending        []session.Frame
	overflowed     bool
	ready          chan struct{}
	readyOnce      sync.Once
	detachSignal   chan struct{}
	detachOnce     sync.Once
}

func newSubscriber(c *connection) *subscriber {
	return &subscriber{conn: c, ready: make(chan struct{}), detachSignal: make(chan struct{})}
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
func (s *subscriber) ReplayBackpressure() (<-chan struct{}, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.detachSignal, s.replaying
}

func (s *subscriber) Deliver(f session.Frame) { _ = s.DeliverFrame(f) }
func (s *subscriber) DeliverFrame(f session.Frame) error {
	if f.Kind == session.FrameReady {
		s.readyOnce.Do(func() { close(s.ready) })
	}
	s.mu.Lock()
	if s.detached {
		s.mu.Unlock()
		return nil
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
func (s *subscriber) activate(ctx context.Context, reattach bool) bool {
	select {
	case <-s.ready:
	case <-s.detachSignal:
		return false
	case <-ctx.Done():
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.detached || ctx.Err() != nil {
		return false
	}
	if s.active {
		return true
	}
	claim, ok := s.conn.subscriberClaim(s)
	if !ok {
		return false
	}
	s.treatAsResumed = reattach
	s.claim = claim
	s.active = true
	if s.replaying {
		s.conn.beginReplay(s)
	}
	if s.overflowed {
		s.pending = nil
		go s.Cancel()
		return true
	}
	for _, f := range s.pending {
		if err := s.deliver(f); err != nil {
			s.pending = nil
			go s.Cancel()
			return true
		}
	}
	s.pending = nil
	return true
}
func (s *subscriber) signalDetach() {
	s.detachOnce.Do(func() {
		s.mu.Lock()
		s.detached = true
		if s.active && s.replaying {
			s.conn.endReplay(s)
		}
		s.replaying = false
		s.mu.Unlock()
		close(s.detachSignal)
		s.readyOnce.Do(func() { close(s.ready) })
	})
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
	if nc := s.conn.socket.NetConn(); nc != nil {
		return nc.Close()
	}
	return nil
}
func (s *subscriber) deliver(f session.Frame) error {
	wire, err := mapFrame(f, s.claim.chatID, s.treatAsResumed)
	if err != nil {
		return err
	}
	if wire == nil {
		return nil
	}
	return s.conn.writeIfCurrent(s.claim, wire)
}

func (c *connection) subscriberClaim(s *subscriber) (queryBinding, bool) {
	c.stateMu.Lock()
	defer c.stateMu.Unlock()
	claim := queryBinding{chatID: c.chatID, generation: c.bindingGeneration, session: c.sess}
	return claim, !c.closed.Load() && c.sub == s && claim.chatID != "" && claim.session != nil
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
		return wscontract.ReadyFrame{Type: typ, SessionID: chatID, PISessionID: &piSessionID, Resumed: f.Resumed || reattach}, nil
	case session.FrameEntries:
		x, ok := f.Data.(session.EntriesFrame)
		if !ok {
			return mergedFrame(typ, chatID, f.Data)
		}
		out := wscontract.EntriesFrame{Type: typ, SessionID: chatID, Entries: x.Entries, Final: x.Final}
		if x.LeafID != "" {
			out.LeafID = &x.LeafID
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
		// chat.send is acknowledged at admission by the bridge. The session's
		// retained completion is internal lifecycle state, not a second client ack.
		if f.Command == "chat.send" {
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
		if at == "" {
			at = time.Now().Format(time.RFC3339Nano)
		}
		payload, _ := json.Marshal(m)
		return wscontract.NoticeFrame{Type: typ, SessionID: chatID, Kind: kind, At: at, Payload: payload}, nil
	case session.FrameApproval:
		m := dataMap(f.Data)
		m["id"] = firstNonempty(f.ApprovalID, stringField(m, "id"))
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
func firstNonempty(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

func normalizedErrorCode(code string) string {
	switch code {
	case "pi_eof", "resume_failed", "session_unloaded", "session_mismatch", "prompt_in_flight", "compaction_in_flight", "send_backpressure", "provider_error", "persist_failed", "decode_failed", "incomplete_history", "external-write-detected", "adoption_required", "session-active", "bad_frame", "unknown_type", "bad_create", "bad_provider", "no_workspace", "no_chat", "start_failed", "initialize_failed", "provider_overflow", "provider_timeout", "bad_approval", "bad_resume", "bad_send", "bad_set", "no_session", "send_failed", "compact_failed":
		return code
	default:
		return "provider_error"
	}
}

var _ session.Subscriber = (*subscriber)(nil)
var _ session.SynchronousAttachHook = (*subscriber)(nil)
var _ interface{ DeliverFrame(session.Frame) error } = (*subscriber)(nil)
