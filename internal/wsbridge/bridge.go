// Package wsbridge exposes the v2 browser WebSocket transport over session.Manager.
package wsbridge

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/lxzan/gws"

	"github.com/DevNewbie1826/omo-webchat/internal/adoptcopy"
	"github.com/DevNewbie1826/omo-webchat/internal/cursorstore"
	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
	"github.com/DevNewbie1826/omo-webchat/internal/session"
	"github.com/DevNewbie1826/omo-webchat/internal/wscontract"
)

const (
	ContractVersion        = 2
	defaultWriteTimeout    = 10 * time.Second
	controlFrameTimeout    = 15 * time.Second
	takeoverActivityWindow = 250 * time.Millisecond
)

var (
	// ErrChatDeleted reports that deletion advanced after a create captured its
	// metadata generation but before the acquired provider route was published.
	ErrChatDeleted = errors.New("chat was deleted while opening")
	// ErrUnsupportedProvider reports metadata that this bridge cannot launch.
	ErrUnsupportedProvider = errors.New("chat provider is not supported")
	inPlaceAuthorizations  sync.Map
)

// SessionActivity describes source-file changes observed during the takeover
// freshness window.
type SessionActivity struct {
	SizeDelta      int64
	MtimeDeltaNano int64
	Changed        bool
}

// SessionActiveError rejects an in-place provider acquisition while another
// process appears to be writing the same session.
type SessionActiveError struct {
	SizeDelta      int64
	MtimeDeltaNano int64
}

func (e *SessionActiveError) Error() string { return "session-active" }

type SessionActivityCheck func(context.Context, string, time.Duration) (SessionActivity, error)

type inPlaceAuthorizationKey struct {
	store  *cursorstore.Store
	chatID string
}

type inPlaceAuthorization struct {
	force atomic.Bool
	check SessionActivityCheck
}

// AuthorizeInPlaceOpen carries a REST force choice to the next provider
// acquisition. The activity checker remains attached for later reopens, but
// force is consumed once at the CursorForOpen boundary.
func AuthorizeInPlaceOpen(store *cursorstore.Store, chatID string, force bool, check SessionActivityCheck) {
	authorization := &inPlaceAuthorization{check: check}
	authorization.force.Store(force)
	inPlaceAuthorizations.Store(inPlaceAuthorizationKey{store: store, chatID: chatID}, authorization)
}

// Config supplies the independently-owned v2 session stack.
type Config struct {
	Context       context.Context
	Manager       *session.Manager
	Store         *cursorstore.Store
	ServerVersion string
	Logger        *slog.Logger
	WriteTimeout  time.Duration
	// HistoryTimeout is independent of the 15-second interactive command budget.
	HistoryTimeout time.Duration
	// PrepareChat validates workspace/chat metadata immediately before attach.
	PrepareChat func(context.Context, string, string) error
	// PrepareChatVersion captures a deletion generation atomically with prepare;
	// ChatVersion must be a lock-free read because validation runs inside the
	// manager's per-chat flight.
	PrepareChatVersion func(context.Context, string, string) (uint64, error)
	ChatVersion        func(string) uint64
	// ActivitySource defaults to Manager when it implements ActivitySource.
	// The explicit field keeps the manager-cache seam independently testable.
	ActivitySource ActivitySource
}

// Handler is a gws event handler and an HTTP WebSocket endpoint.
type Handler struct {
	gws.BuiltinEventHandler
	cfg                Config
	upgrader           *gws.Upgrader
	conns              sync.Map // *gws.Conn -> *connection
	shutdownGeneration atomic.Uint64
	shuttingDown       atomic.Bool
}

// New builds a bridge endpoint. Authentication deliberately remains the API
// router's middleware responsibility.
func New(cfg Config) *Handler {
	if cfg.Context == nil {
		cfg.Context = context.Background()
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	if cfg.WriteTimeout <= 0 {
		cfg.WriteTimeout = defaultWriteTimeout
	}
	if cfg.HistoryTimeout <= 0 {
		cfg.HistoryTimeout = session.DefaultHistoryTimeout
	}
	h := &Handler{cfg: cfg}
	h.upgrader = gws.NewUpgrader(h, &gws.ServerOption{
		Recovery:          gws.Recovery,
		PermessageDeflate: gws.PermessageDeflate{Enabled: true},
		Authorize:         func(r *http.Request, _ gws.SessionStorage) bool { return originAllowed(r) },
	})
	if done := cfg.Context.Done(); done != nil {
		go func() {
			<-done
			h.CloseConnections()
		}()
	}
	return h
}

// CloseConnections closes every upgraded socket, including sockets that have
// not completed hello or bound a chat.
func (h *Handler) CloseConnections() {
	h.shuttingDown.Store(true)
	h.shutdownGeneration.Add(1)
	h.conns.Range(func(key, value any) bool {
		h.conns.Delete(key)
		value.(*connection).shutdown()
		return true
	})
}

// Unavailable returns a diagnostic endpoint for tests and explicit diagnostics.
func Unavailable(reason string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusServiceUnavailable)
		_ = json.NewEncoder(w).Encode(map[string]string{
			"error":  "v2 websocket bridge is not configured",
			"reason": reason,
		})
	})
}

func originAllowed(r *http.Request) bool {
	origins := r.Header.Values("Origin")
	if len(origins) == 0 {
		return true
	}
	if len(origins) != 1 || origins[0] == "" {
		return false
	}
	o, err := url.Parse(origins[0])
	if err != nil || o.Host == "" || o.User != nil || o.Path != "" || o.RawQuery != "" || o.ForceQuery || o.Fragment != "" {
		return false
	}
	if !strings.EqualFold(o.Scheme, "http") && !strings.EqualFold(o.Scheme, "https") {
		return false
	}
	return strings.EqualFold(o.Host, r.Host)
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if h.cfg.Manager == nil || h.cfg.Store == nil {
		http.Error(w, "v2 websocket bridge is not configured", http.StatusServiceUnavailable)
		return
	}
	if !originAllowed(r) {
		http.Error(w, "websocket origin not allowed", http.StatusForbidden)
		return
	}
	if h.shuttingDown.Load() || h.cfg.Context.Err() != nil {
		http.Error(w, "v2 websocket bridge is shutting down", http.StatusServiceUnavailable)
		return
	}
	generation := h.shutdownGeneration.Load()
	sock, err := h.upgrader.Upgrade(w, r)
	if err != nil {
		h.cfg.Logger.Warn("v2 websocket upgrade failed", "error", err)
		return
	}
	ctx, cancel := context.WithCancel(h.cfg.Context)
	c := &connection{bridge: h, socket: sock, ctx: ctx, cancel: cancel, work: make(chan []byte, 64)}
	c.sub = newSubscriber(c)
	h.conns.Store(sock, c)
	if h.shuttingDown.Load() || h.cfg.Context.Err() != nil || h.shutdownGeneration.Load() != generation {
		c.shutdown()
		return
	}
	go c.run()
	if err := c.write(wscontract.HelloFrame{Type: "hello", Version: ContractVersion, ServerVersion: h.cfg.ServerVersion}); err != nil {
		c.shutdown()
		return
	}
	go sock.ReadLoop()
}

func (h *Handler) OnMessage(sock *gws.Conn, msg *gws.Message) {
	defer msg.Close()
	if raw, ok := h.conns.Load(sock); ok {
		c := raw.(*connection)
		frame := append([]byte(nil), msg.Bytes()...)
		select {
		case c.work <- frame:
		case <-c.ctx.Done():
		default:
			c.sendError("bad_frame", "too many queued client frames", "", "")
			c.shutdown()
		}
	}
}
func (h *Handler) OnClose(sock *gws.Conn, err error) {
	if raw, ok := h.conns.LoadAndDelete(sock); ok {
		raw.(*connection).shutdown()
	}
	if err != nil {
		h.cfg.Logger.Debug("v2 websocket closed", "error", err)
	}
}

type chatSendOperation struct {
	bridge            *Handler
	conn              *connection // live delivery hint; never owns recovery
	workspaceID       string
	chatID            string
	bindingGeneration uint64
	kind              string
	message           string
	images            []map[string]string
	requestID         string
}

type connection struct {
	bridge            *Handler
	socket            *gws.Conn
	ctx               context.Context
	cancel            context.CancelFunc
	sub               *subscriber
	outboundMu        sync.Mutex
	replayActive      bool
	replayDone        chan struct{}
	replayOwner       *subscriber
	stateMu           sync.Mutex
	wsID, chatID      string
	bindingGeneration uint64
	sess              *session.Session
	detach            func()
	goalCancel        context.CancelFunc
	activityMu        sync.Mutex
	activity          *activitySubscription
	hello             bool
	work              chan []byte
	closed            atomic.Bool
}

func (c *connection) write(v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	c.outboundMu.Lock()
	defer c.outboundMu.Unlock()
	return c.writeLocked(b)
}

// writeActivity shares the socket arbiter but yields while attach history is
// replaying. Its caller retains bounded queueing and overflow accounting while
// waiting, so replay cannot be delayed by activity traffic.
func (c *connection) writeActivity(v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	for {
		c.outboundMu.Lock()
		if !c.replayActive {
			err := c.writeLocked(b)
			c.outboundMu.Unlock()
			return err
		}
		done := c.replayDone
		c.outboundMu.Unlock()
		select {
		case <-done:
		case <-c.ctx.Done():
			return netClosedError{}
		}
	}
}

func (c *connection) beginReplay(owner *subscriber) {
	c.outboundMu.Lock()
	if !c.replayActive {
		c.replayActive = true
		c.replayDone = make(chan struct{})
	}
	c.replayOwner = owner
	c.outboundMu.Unlock()
}

func (c *connection) endReplay(owner *subscriber) {
	c.outboundMu.Lock()
	if c.replayActive && c.replayOwner == owner {
		c.replayActive = false
		c.replayOwner = nil
		close(c.replayDone)
		c.replayDone = nil
	}
	c.outboundMu.Unlock()
}

func (c *connection) writeLocked(b []byte) error {
	if c.closed.Load() {
		return netClosedError{}
	}
	nc := c.socket.NetConn()
	if nc == nil {
		return netClosedError{}
	}
	if err := nc.SetWriteDeadline(time.Now().Add(c.bridge.cfg.WriteTimeout)); err != nil {
		return err
	}
	defer nc.SetWriteDeadline(time.Time{})
	return c.socket.WriteMessage(gws.OpcodeText, b)
}

type netClosedError struct{}

func (netClosedError) Error() string { return "websocket closed" }

func (c *connection) shutdown() {
	c.bridge.conns.Delete(c.socket)
	if !c.closed.CompareAndSwap(false, true) {
		return
	}
	c.cancel()
	c.activityMu.Lock()
	activity := c.activity
	c.activity = nil
	c.activityMu.Unlock()
	activity.stop()
	c.unbind()
	if nc := c.socket.NetConn(); nc != nil {
		_ = nc.Close()
	}
}
func (c *connection) unbind() (string, *session.Session) {
	c.stopGoalWatch()
	c.stateMu.Lock()
	id, s, detach := c.chatID, c.sess, c.detach
	c.wsID, c.chatID, c.sess, c.detach = "", "", nil, nil
	c.bindingGeneration++
	c.stateMu.Unlock()
	if detach != nil {
		detach()
	}
	return id, s
}
func (c *connection) binding() (string, *session.Session) {
	c.stateMu.Lock()
	defer c.stateMu.Unlock()
	return c.chatID, c.sess
}

func (c *connection) bindingSnapshot() (string, string, uint64, *session.Session) {
	c.stateMu.Lock()
	defer c.stateMu.Unlock()
	return c.wsID, c.chatID, c.bindingGeneration, c.sess
}

func (c *connection) run() {
	for {
		select {
		case <-c.ctx.Done():
			return
		case raw := <-c.work:
			c.route(raw)
		}
	}
}

func (c *connection) route(raw []byte) {
	var probe map[string]json.RawMessage
	if json.Unmarshal(raw, &probe) != nil || probe == nil {
		c.sendError("bad_frame", "invalid json frame", "", "")
		return
	}
	var typ string
	if json.Unmarshal(probe["type"], &typ) != nil || typ == "" {
		c.sendError("bad_frame", "frame type is required", "", "")
		return
	}
	// Accept the documented browser spelling while the generated enum retains
	// the provider command spelling.
	if typ == "chat.send" {
		var send struct {
			Run struct {
				Kind string `json:"kind"`
			} `json:"run"`
		}
		if json.Unmarshal(raw, &send) == nil && send.Run.Kind == "followUp" {
			var normalized map[string]any
			if json.Unmarshal(raw, &normalized) == nil {
				if run, ok := normalized["run"].(map[string]any); ok {
					run["kind"] = "follow_up"
					raw, _ = json.Marshal(normalized)
				}
			}
		}
	}
	frame, err := wscontract.ParseClientFrame(raw)
	if err != nil {
		c.sendError("bad_frame", "invalid json frame", "", "")
		return
	}
	if _, unknown := frame.(wscontract.UnknownFrame); unknown {
		c.sendError("unknown_type", "unknown frame type: "+typ, "", "")
		return
	}
	if _, unknown := frame.(*wscontract.UnknownFrame); unknown {
		c.sendError("unknown_type", "unknown frame type: "+typ, "", "")
		return
	}

	ctx, cancel := c.routeContext(frame)
	defer cancel()
	c.routeFrame(ctx, frame, typ)
}

func (c *connection) routeContext(frame wscontract.ClientFrame) (context.Context, context.CancelFunc) {
	// Prompt, in-run sends, and compaction have observably long response times.
	// Their lifetime is therefore the socket lifetime; cheap control work keeps
	// the bounded interactive budget.
	switch f := frame.(type) {
	case *wscontract.ChatSendFrame:
		switch string(f.Run.Kind) {
		case "prompt", "steer", "follow_up", "followUp":
			return c.ctx, func() {}
		}
	case *wscontract.ChatCompactFrame:
		return c.ctx, func() {}
	}
	return context.WithTimeout(c.ctx, controlFrameTimeout)
}

func (c *connection) routeFrame(ctx context.Context, frame wscontract.ClientFrame, typ string) {
	if f, ok := frame.(*wscontract.ClientHelloFrame); ok {
		if f.Version != ContractVersion {
			c.sendError("bad_frame", "wire contract version mismatch", "", "")
			return
		}
		c.stateMu.Lock()
		c.hello = true
		c.stateMu.Unlock()
		return
	}
	c.stateMu.Lock()
	greeted := c.hello
	c.stateMu.Unlock()
	if !greeted {
		c.sendError("bad_frame", "client hello required", "", "")
		return
	}
	if _, ok := frame.(*wscontract.PingFrame); ok {
		_ = c.write(wscontract.PongFrame{Type: "pong"})
		return
	}
	if f, ok := frame.(*wscontract.ChatCreateFrame); ok {
		c.create(ctx, f)
		return
	}
	if f, ok := frame.(*wscontract.SessionsSubscribeFrame); ok {
		c.subscribeActivity(f)
		return
	}

	bound, sess := c.binding()
	target := clientSessionID(frame)
	if target != bound && !(typ == "activity.refresh" && bound == "") {
		c.sendError("session_mismatch", "frame sessionId does not match this socket's chat", "", requestID(frame))
		return
	}
	if sess == nil && typ != "activity.refresh" {
		c.sendError("session_mismatch", "no chat is bound to this socket", "", requestID(frame))
		return
	}

	// Session operations from different sockets share the manager's per-chat
	// flight. Disconnect already enters that flight internally via StopContext.
	if typ != "chat.disconnect" && typ != "chat.send" && bound != "" {
		release, lockErr := c.bridge.cfg.Manager.EnterChat(ctx, bound)
		if lockErr != nil {
			c.sendSessionError(lockErr, typ, requestID(frame))
			return
		}
		defer release()
	}

	switch f := frame.(type) {
	case *wscontract.ChatSendFrame:
		c.handleChatSend(ctx, bound, sess, f)
	case *wscontract.ChatAbortFrame:
		if err := sess.Abort(ctx); err != nil {
			c.sendSessionError(err, "chat.abort", "")
		}
	case *wscontract.ChatSetFrame:
		rid := deref(f.RequestID)
		if f.Model != nil {
			c.sendAck("set_model", rid)
			if err := sess.SetModel(ctx, f.Model.Provider, f.Model.ModelID, rid); err != nil {
				c.sendSessionError(err, "set_model", rid)
			}
		}
		if f.ThinkingLevel != nil {
			c.sendAck("set_thinking", rid)
			if err := sess.SetThinking(ctx, *f.ThinkingLevel, rid); err != nil {
				c.sendSessionError(err, "set_thinking", rid)
			}
		}
	case *wscontract.ApprovalRespondFrame:
		value := ""
		if f.Value != nil {
			value = *f.Value
		}
		if err := sess.RespondApprovalRequest(ctx, f.ID, deref(f.RequestID), value, f.Confirmed, f.Cancelled != nil && *f.Cancelled); err != nil {
			c.sendSessionError(err, "approval.respond", deref(f.RequestID))
		}
	case *wscontract.ChatCommandsFrame:
		c.queryCommands(ctx, sess)
	case *wscontract.ChatCompactFrame:
		if err := sess.CompactDetached(ctx); err != nil {
			c.sendSessionError(err, "chat.compact", "")
		}
	case *wscontract.ChatModelsFrame:
		c.queryModels(ctx, sess)
	case *wscontract.ChatStatsFrame:
		c.queryStats(ctx, sess)
	case *wscontract.ActivityRefreshFrame:
		if sess != nil {
			for _, x := range sess.ActivitySnapshot() {
				_ = c.sub.DeliverFrame(x)
			}
		}
	case *wscontract.ChatResumeFrame:
		c.queryState(ctx, sess)
	case *wscontract.ChatCloseFrame:
		c.unbind()
	case *wscontract.ChatDisconnectFrame:
		id, _ := c.unbind()
		if id != "" {
			_ = c.bridge.cfg.Manager.StopContext(ctx, id)
		}
	default:
		c.sendError("unknown_type", "unknown frame type: "+typ, "", requestID(frame))
	}
}

func (c *connection) handleChatSend(ctx context.Context, bound string, sess *session.Session, f *wscontract.ChatSendFrame) {
	workspaceID, chatID, generation, current := c.bindingSnapshot()
	op := &chatSendOperation{bridge: c.bridge, conn: c, workspaceID: workspaceID, chatID: chatID,
		bindingGeneration: generation, kind: string(f.Run.Kind), message: f.Run.Message, requestID: deref(f.RequestID)}
	op.images = make([]map[string]string, len(f.Run.Images))
	for i, image := range f.Run.Images {
		op.images[i] = map[string]string{"data": image.Data, "mimeType": image.MimeType}
	}
	if current != sess || chatID != bound {
		c.sendError("session_mismatch", "session binding changed before send admission", "chat.send", op.requestID)
		return
	}
	if op.kind != "prompt" && op.kind != "steer" && op.kind != "follow_up" && op.kind != "followUp" {
		c.sendError("bad_frame", "unknown run kind", "chat.send", op.requestID)
		return
	}

	release, err := c.bridge.cfg.Manager.EnterChat(ctx, op.chatID)
	if err != nil {
		if op.bindingCurrent() {
			c.sendSessionError(err, "chat.send", op.requestID)
		}
		return
	}
	if !op.bindingCurrent() {
		release()
		return
	}
	// A recovery ahead of this send in the per-chat FIFO may have replaced the
	// provider route without changing the logical socket binding. Route the send
	// to that replacement rather than silently abandoning its correlation.
	if live, ok := c.bridge.cfg.Manager.Get(op.chatID); ok {
		sess = live
	}
	err = op.send(ctx, sess, func(completionErr error) {
		if isResumableSendError(completionErr) {
			op.enqueueRecovery(sess, true, completionErr)
			return
		}
		sess.CompleteDetachedSend(op.requestID, completionErr)
	})
	if isResumableSendError(err) {
		op.enqueueRecovery(sess, false, err)
		release()
		return
	}
	release()
	if err != nil {
		if op.bindingCurrent() {
			c.sendSessionError(err, "chat.send", op.requestID)
		}
	} else if op.requestID != "" && op.bindingCurrent() {
		c.sendAck("chat.send", op.requestID)
	}
}

func (op *chatSendOperation) send(ctx context.Context, sess *session.Session, complete func(error)) error {
	switch op.kind {
	case "prompt":
		return sess.SendPromptDetachedWithRequestIDAndCompletion(ctx, op.message, op.images, op.requestID, complete)
	case "steer":
		return sess.SendSteerDetachedWithRequestIDAndCompletion(ctx, op.message, op.requestID, complete)
	default:
		return sess.SendFollowUpDetachedWithRequestIDAndCompletion(ctx, op.message, op.images, op.requestID, complete)
	}
}

func isResumableSendError(err error) bool {
	return errors.Is(err, session.ErrSessionResumable) || errors.Is(err, session.ErrSessionClosed)
}

type operationSubscriber struct {
	*subscriber
	op           *chatSendOperation
	retryStarted atomic.Bool
}

func (s *operationSubscriber) Deliver(f session.Frame) { _ = s.DeliverFrame(f) }
func (s *operationSubscriber) DeliverFrame(f session.Frame) error {
	if !s.retryStarted.Load() && f.RequestID == s.op.requestID && f.Command == "chat.send" {
		return nil
	}
	return s.subscriber.DeliverFrame(f)
}

func (s *operationSubscriber) BeginReplay() {
	if s.op.bindingMatchesSession(nil) {
		s.subscriber.BeginReplay()
	}
}
func (s *operationSubscriber) EndReplay() {
	if s.subscriber.replaying.Load() {
		s.subscriber.EndReplay()
	}
}

func (op *chatSendOperation) bindingMatchesSession(want *session.Session) bool {
	op.conn.stateMu.Lock()
	defer op.conn.stateMu.Unlock()
	if op.conn.closed.Load() || op.conn.wsID != op.workspaceID || op.conn.chatID != op.chatID || op.conn.bindingGeneration != op.bindingGeneration {
		return false
	}
	return want == nil || op.conn.sess == want
}

func (op *chatSendOperation) bindingCurrent() bool { return op.bindingMatchesSession(nil) }

func (op *chatSendOperation) bindResumed(ctx context.Context, stale, acquired *session.Session, started bool, sub *subscriber, acquiredDetach func()) bool {
	wrappedDetach := sub.wrapDetach(acquiredDetach)
	op.conn.stateMu.Lock()
	if op.conn.closed.Load() || op.conn.wsID != op.workspaceID || op.conn.chatID != op.chatID ||
		op.conn.bindingGeneration != op.bindingGeneration || op.conn.sess != stale {
		op.conn.stateMu.Unlock()
		wrappedDetach()
		return false
	}
	oldDetach := op.conn.detach
	op.conn.sess, op.conn.detach, op.conn.sub = acquired, wrappedDetach, sub
	op.conn.stateMu.Unlock()
	if !sub.activate(ctx, !started) {
		op.conn.stateMu.Lock()
		if op.conn.bindingGeneration == op.bindingGeneration && op.conn.sess == acquired {
			op.conn.sess, op.conn.detach = stale, oldDetach
		}
		op.conn.stateMu.Unlock()
		wrappedDetach()
		return false
	}
	if oldDetach != nil {
		oldDetach()
	}
	if touchErr := op.bridge.cfg.Store.TouchLastUsed(op.chatID); touchErr != nil {
		op.bridge.cfg.Logger.Warn("touching v2 chat last-used time", "chat_id", op.chatID, "error", touchErr)
	}
	op.conn.queryState(ctx, acquired)
	op.conn.queryModels(ctx, acquired)
	op.conn.queryCommands(ctx, acquired)
	op.conn.queryStats(ctx, acquired)
	return true
}

func (op *chatSendOperation) enqueueRecovery(stale *session.Session, admitted bool, originalErr error) {
	op.bridge.cfg.Manager.EnqueueChat(op.chatID, func() {
		op.resumeAndRetry(stale, admitted, originalErr)
	})
}

func (op *chatSendOperation) resumeAndRetry(stale *session.Session, admitted bool, originalErr error) {
	ctx, cancel := context.WithTimeout(op.bridge.cfg.Context, op.bridge.cfg.HistoryTimeout)
	defer cancel()
	if !stale.PrepareDetachedSendRetry(op.requestID, op.kind != "prompt") {
		return
	}

	var preparedGeneration uint64
	guarded := op.bridge.cfg.PrepareChatVersion != nil && op.bridge.cfg.ChatVersion != nil
	if guarded {
		var err error
		preparedGeneration, err = op.bridge.cfg.PrepareChatVersion(ctx, op.workspaceID, op.chatID)
		if err != nil {
			stale.PublishSendOperationError(op.requestID, resumeFailureInfo(err))
			return
		}
	} else if op.bridge.cfg.PrepareChat != nil {
		if err := op.bridge.cfg.PrepareChat(ctx, op.workspaceID, op.chatID); err != nil {
			stale.PublishSendOperationError(op.requestID, resumeFailureInfo(err))
			return
		}
	}
	rec, err := op.bridge.cfg.Store.GetChat(op.chatID)
	if err != nil || rec.WorkspaceID != op.workspaceID || !cursorstore.IsLaunchableProvider(rec.Provider) {
		if err == nil {
			err = errors.New("chat metadata changed while resuming")
		}
		stale.PublishSendOperationError(op.requestID, resumeFailureInfo(err))
		return
	}

	var sub *operationSubscriber
	var attachSub session.Subscriber
	var stagedDetach func()
	var stagedSession *session.Session
	var stagedStarted bool
	if op.bindingMatchesSession(stale) {
		sub = &operationSubscriber{subscriber: newSubscriber(op.conn), op: op}
		attachSub = sub
	}
	initialize := func(acquired *session.Session, started bool, detach func()) {
		stagedSession, stagedStarted, stagedDetach = acquired, started, detach
	}
	validate := func() error { return nil }
	if guarded {
		validate = func() error {
			if op.bridge.cfg.ChatVersion(op.chatID) != preparedGeneration {
				return ErrChatDeleted
			}
			return nil
		}
	}
	callbackRan := false
	var outcomeOwner *session.Session
	resumed, _, detach, err := op.bridge.cfg.Manager.ResumeInitializedCheckedAndRunInFlight(ctx, chatRef{id: rec.ID, cwd: rec.CWD}, attachSub, initialize, validate, func(acquired *session.Session) error {
		callbackRan = true
		outcomeOwner = acquired
		if sub != nil {
			sub.retryStarted.Store(true)
			if stagedSession != acquired || stagedDetach == nil || !op.bindResumed(ctx, stale, acquired, stagedStarted, sub.subscriber, stagedDetach) {
				sub = nil
			}
		}
		return op.send(ctx, acquired, func(completionErr error) {
			acquired.CompleteDetachedSend(op.requestID, completionErr)
		})
	})
	_ = detach // the live binding or manager owns the acquired route
	if errors.Is(err, session.ErrNoDurableCursor) {
		stale.CompleteDetachedSend(op.requestID, originalErr)
		return
	}
	if err != nil {
		if callbackRan && outcomeOwner != nil {
			outcomeOwner.CompleteDetachedSend(op.requestID, err)
		} else {
			stale.PublishSendOperationError(op.requestID, resumeFailureInfo(err))
		}
		return
	}
	if resumed == nil {
		stale.PublishSendOperationError(op.requestID, session.ErrorInfo{Code: "resume_failed", Message: "resume returned no session"})
		return
	}
	if !admitted && op.requestID != "" && op.bindingCurrent() {
		op.conn.sendAck("chat.send", op.requestID)
	}
}

func resumeFailureInfo(err error) session.ErrorInfo {
	var resumeErr *session.ResumeError
	if errors.As(err, &resumeErr) {
		if isSessionActiveError(err) {
			return session.ErrorInfo{Code: "session-active", Message: "session is active in another process"}
		}
		return resumeErr.Info
	}
	if errors.Is(err, cursorstore.ErrAdoptionRequired) {
		return session.ErrorInfo{Code: "adoption_required", Message: "session must be adopted before opening"}
	}
	if isSessionActiveError(err) {
		return session.ErrorInfo{Code: "session-active", Message: "session is active in another process"}
	}
	var drift *session.ExternalWriteError
	if errors.As(err, &drift) {
		return session.ErrorInfo{Code: "external-write-detected", Message: drift.Error(), KnownLeaf: drift.KnownLeaf, ObservedLeaf: drift.ObservedLeaf}
	}
	return session.ErrorInfo{Code: "resume_failed", Message: err.Error()}
}

func (c *connection) create(_ context.Context, f *wscontract.ChatCreateFrame) {
	ctx, cancel := context.WithTimeout(c.ctx, c.bridge.cfg.HistoryTimeout)
	defer cancel()
	c.unbind()
	c.sub = newSubscriber(c)
	sub := c.sub
	var preparedGeneration uint64
	guarded := c.bridge.cfg.PrepareChatVersion != nil && c.bridge.cfg.ChatVersion != nil
	if guarded {
		var err error
		preparedGeneration, err = c.bridge.cfg.PrepareChatVersion(ctx, f.WsID, f.ChatID)
		if err != nil {
			code := "no_chat"
			message := err.Error()
			switch {
			case errors.Is(err, ErrChatDeleted):
				code = "no_chat"
			case errors.Is(err, ErrUnsupportedProvider):
				code = "unsupported_provider"
			case errors.Is(err, cursorstore.ErrAdoptionRequired):
				code = "adoption_required"
				message = "session must be adopted before opening"
			}
			c.sendError(code, message, "", "")
			return
		}
	} else if c.bridge.cfg.PrepareChat != nil {
		if err := c.bridge.cfg.PrepareChat(ctx, f.WsID, f.ChatID); err != nil {
			code := "no_chat"
			if errors.Is(err, ErrUnsupportedProvider) {
				code = "unsupported_provider"
			}
			c.sendError(code, err.Error(), "", "")
			return
		}
	}
	rec, err := c.bridge.cfg.Store.GetChat(f.ChatID)
	if err != nil {
		if errors.Is(err, cursorstore.ErrAdoptionRequired) {
			c.sendError("adoption_required", "session must be adopted before opening", "", "")
		} else {
			c.sendError("no_chat", "chat not found", "", "")
		}
		return
	}
	if rec.WorkspaceID != f.WsID {
		c.sendError("bad_create", "chat does not belong to workspace", "", "")
		return
	}
	if !cursorstore.IsLaunchableProvider(rec.Provider) {
		c.sendError("unsupported_provider", ErrUnsupportedProvider.Error(), "", "")
		return
	}
	ref := chatRef{id: rec.ID, cwd: rec.CWD}
	commitBinding := func(acquired *session.Session, started bool, acquiredDetach func()) error {
		wrappedDetach := sub.wrapDetach(acquiredDetach)
		c.stateMu.Lock()
		if c.closed.Load() {
			c.stateMu.Unlock()
			wrappedDetach()
			return nil
		}
		c.bindingGeneration++
		c.wsID, c.chatID, c.sess, c.detach = f.WsID, f.ChatID, acquired, wrappedDetach
		c.stateMu.Unlock()
		if !sub.activate(ctx, !started) {
			c.unbind()
			return nil
		}
		if touchErr := c.bridge.cfg.Store.TouchLastUsed(f.ChatID); touchErr != nil {
			c.bridge.cfg.Logger.Warn("touching v2 chat last-used time", "chat_id", f.ChatID, "error", touchErr)
		}
		c.queryState(ctx, acquired)
		c.queryModels(ctx, acquired)
		c.queryCommands(ctx, acquired)
		c.queryStats(ctx, acquired)
		return nil
	}
	initialize := func(acquired *session.Session, started bool, acquiredDetach func()) {
		_ = commitBinding(acquired, started, acquiredDetach)
	}
	var sess *session.Session
	var detach func()
	recovery := f.Recovery != nil && *f.Recovery
	if guarded {
		validate := func() error {
			if c.bridge.cfg.ChatVersion(f.ChatID) != preparedGeneration {
				return ErrChatDeleted
			}
			return nil
		}
		var stagedSession *session.Session
		var stagedStarted bool
		var stagedDetach func()
		stage := func(acquired *session.Session, started bool, acquiredDetach func()) {
			stagedSession, stagedStarted, stagedDetach = acquired, started, acquiredDetach
		}
		commit := func(acquired *session.Session) error {
			if stagedSession != acquired || stagedDetach == nil {
				return errors.New("session binding was not initialized")
			}
			return commitBinding(acquired, stagedStarted, stagedDetach)
		}
		if recovery {
			sess, _, detach, err = c.bridge.cfg.Manager.AcquireInitializedCheckedWithRecoveryAndRun(ctx, ref, sub, stage, validate, commit)
		} else {
			sess, _, detach, err = c.bridge.cfg.Manager.AcquireInitializedCheckedAndRun(ctx, ref, sub, stage, validate, commit)
		}
	} else if recovery {
		sess, _, detach, err = c.bridge.cfg.Manager.AcquireInitializedWithRecovery(ctx, ref, sub, initialize)
	} else {
		sess, _, detach, err = c.bridge.cfg.Manager.AcquireInitialized(ctx, ref, sub, initialize)
	}
	if err != nil {
		c.unbind()
		var drift *session.ExternalWriteError
		if errors.As(err, &drift) {
			c.sendExternalWriteError(drift, "", "")
			return
		}
		code := "start_failed"
		message := err.Error()
		switch {
		case errors.Is(err, ErrChatDeleted):
			code = "no_chat"
		case errors.Is(err, cursorstore.ErrAdoptionRequired):
			code = "adoption_required"
			message = "session must be adopted before opening"
		case isSessionActiveError(err):
			code = "session-active"
			message = "session is active in another process"
		}
		c.sendError(code, message, "", "")
		return
	}
	c.stateMu.Lock()
	stillBound := c.sess == sess
	c.stateMu.Unlock()
	if !stillBound && detach != nil {
		detach()
	}
	// The watcher needs the durable identity, which a fresh web chat only
	// carries after the provider route is published — re-read post-acquire.
	if stillBound {
		if fresh, err := c.bridge.cfg.Store.GetChat(rec.ID); err == nil {
			c.startGoalWatch(fresh)
		}
	}
}

func (c *connection) sendAck(command, requestID string) {
	sid, _ := c.binding()
	f := wscontract.AckFrame{Type: "ack", Command: command}
	if sid != "" {
		f.SessionID = &sid
	}
	if requestID != "" {
		f.RequestID = &requestID
	}
	_ = c.write(f)
}
func (c *connection) sendError(code, message, command, requestID string) {
	sid, _ := c.binding()
	m := map[string]any{"type": "error", "code": code, "message": message}
	if sid != "" {
		m["sessionId"] = sid
	}
	if command != "" {
		m["command"] = command
	}
	if requestID != "" {
		m["requestId"] = requestID
	}
	_ = c.write(m)
}
func (c *connection) sendExternalWriteError(drift *session.ExternalWriteError, command, requestID string) {
	sid, _ := c.binding()
	frame := map[string]any{
		"type":         "error",
		"code":         "external-write-detected",
		"message":      drift.Error(),
		"knownLeaf":    drift.KnownLeaf,
		"observedLeaf": drift.ObservedLeaf,
	}
	if sid != "" {
		frame["sessionId"] = sid
	}
	if command != "" {
		frame["command"] = command
	}
	if requestID != "" {
		frame["requestId"] = requestID
	}
	_ = c.write(frame)
}
func (c *connection) sendSessionError(err error, command, requestID string) {
	var drift *session.ExternalWriteError
	if errors.As(err, &drift) {
		c.sendExternalWriteError(drift, command, requestID)
		return
	}
	code := "provider_error"
	if errors.Is(err, session.ErrPromptInFlight) {
		code = "prompt_in_flight"
	}
	if errors.Is(err, session.ErrCompactionInFlight) {
		code = "compaction_in_flight"
	}
	if errors.Is(err, session.ErrSendBackpressure) {
		code = "send_backpressure"
	}
	c.sendError(code, err.Error(), command, requestID)
}

func isSessionActiveError(err error) bool {
	if errors.As(err, new(*SessionActiveError)) {
		return true
	}
	var stable *omorpc.StableError
	return errors.As(err, &stable) && stable.Code == omorpc.ErrCodeSessionPathInUse
}

type queryBinding struct {
	chatID     string
	generation uint64
	session    *session.Session
}

func (c *connection) beginQuery(s *session.Session) (queryBinding, bool) {
	_, chatID, generation, current := c.bindingSnapshot()
	return queryBinding{chatID: chatID, generation: generation, session: s}, current == s && chatID != ""
}

func (c *connection) queryCurrentLocked(q queryBinding) bool {
	return !c.closed.Load() && c.chatID == q.chatID && c.bindingGeneration == q.generation && c.sess == q.session
}

// writeIfCurrent keeps the binding claim through the socket write, so a rebind
// cannot split validation from delivery.
func (c *connection) writeIfCurrent(q queryBinding, v any) error {
	c.stateMu.Lock()
	defer c.stateMu.Unlock()
	if !c.queryCurrentLocked(q) {
		return nil
	}
	return c.write(v)
}

func sessionErrorFrame(err error, command, requestID, sessionID string) any {
	var drift *session.ExternalWriteError
	if errors.As(err, &drift) {
		frame := map[string]any{
			"type": "error", "code": "external-write-detected", "message": drift.Error(),
			"knownLeaf": drift.KnownLeaf, "observedLeaf": drift.ObservedLeaf,
		}
		if sessionID != "" {
			frame["sessionId"] = sessionID
		}
		if command != "" {
			frame["command"] = command
		}
		if requestID != "" {
			frame["requestId"] = requestID
		}
		return frame
	}
	code := "provider_error"
	switch {
	case errors.Is(err, session.ErrPromptInFlight):
		code = "prompt_in_flight"
	case errors.Is(err, session.ErrCompactionInFlight):
		code = "compaction_in_flight"
	case errors.Is(err, session.ErrSendBackpressure):
		code = "send_backpressure"
	}
	frame := map[string]any{"type": "error", "code": code, "message": err.Error()}
	if sessionID != "" {
		frame["sessionId"] = sessionID
	}
	if command != "" {
		frame["command"] = command
	}
	if requestID != "" {
		frame["requestId"] = requestID
	}
	return frame
}

func (c *connection) queryState(ctx context.Context, s *session.Session) {
	binding, ok := c.beginQuery(s)
	if !ok {
		return
	}
	x, err := s.QueryState(ctx)
	if err != nil {
		_ = c.writeIfCurrent(binding, sessionErrorFrame(err, "get_state", "", binding.chatID))
		return
	}
	var model map[string]any
	if len(x.Model) > 0 {
		_ = json.Unmarshal(x.Model, &model)
		if id, ok := model["id"].(string); ok {
			model["modelId"] = id
			delete(model, "id")
		}
	}
	run := s.RunSnapshot()
	_ = c.writeIfCurrent(binding, map[string]any{"type": "state", "sessionId": binding.chatID, "model": model, "thinkingLevel": x.ThinkingLevel, "isStreaming": run.Streaming, "isCompacting": run.Compacting})
}
func (c *connection) queryModels(ctx context.Context, s *session.Session) {
	binding, ok := c.beginQuery(s)
	if !ok {
		return
	}
	xs, err := s.Models(ctx)
	if err != nil {
		_ = c.writeIfCurrent(binding, sessionErrorFrame(err, "get_available_models", "", binding.chatID))
		return
	}
	sid := binding.chatID
	out := make([]wscontract.ModelInfo, len(xs))
	for i, x := range xs {
		out[i] = wscontract.ModelInfo{Provider: x.Provider, ModelID: x.ModelID}
		if x.Name != "" {
			out[i].Name = &x.Name
		}
	}
	_ = c.writeIfCurrent(binding, wscontract.ModelsFrame{Type: "models", SessionID: sid, Models: out})
}
func (c *connection) queryCommands(ctx context.Context, s *session.Session) {
	binding, ok := c.beginQuery(s)
	if !ok {
		return
	}
	xs, err := s.Commands(ctx)
	if err != nil {
		_ = c.writeIfCurrent(binding, sessionErrorFrame(err, "get_commands", "", binding.chatID))
		return
	}
	sid := binding.chatID
	out := make([]wscontract.CommandEntry, len(xs))
	for i, x := range xs {
		out[i] = commandEntry(x)
	}
	_ = c.writeIfCurrent(binding, wscontract.CommandsFrame{Type: "commands", SessionID: sid, Commands: out})
}
func (c *connection) queryStats(ctx context.Context, s *session.Session) {
	binding, ok := c.beginQuery(s)
	if !ok {
		return
	}
	x, err := s.Stats(ctx)
	if err != nil {
		_ = c.writeIfCurrent(binding, sessionErrorFrame(err, "get_session_stats", "", binding.chatID))
		return
	}
	sid := binding.chatID
	frame := map[string]any{"type": "stats", "sessionId": sid, "cost": x.Cost}
	if len(x.Tokens) != 0 {
		frame["tokens"] = x.Tokens
	}
	if len(x.ContextUsage) != 0 {
		frame["contextUsage"] = contextUsageWithPercent(x.ContextUsage)
	}
	_ = c.writeIfCurrent(binding, frame)
}

func contextUsageWithPercent(raw json.RawMessage) json.RawMessage {
	var usage map[string]any
	if json.Unmarshal(raw, &usage) != nil || usage["percent"] != nil {
		return raw
	}
	used, usedOK := usage["used"].(float64)
	total, totalOK := usage["total"].(float64)
	if !usedOK || !totalOK {
		used, usedOK = usage["tokens"].(float64)
		total, totalOK = usage["contextWindow"].(float64)
	}
	percent := 0.0
	if usedOK && totalOK && total > 0 {
		percent = used / total * 100
	}
	usage["percent"] = percent
	normalized, err := json.Marshal(usage)
	if err != nil {
		return raw
	}
	return normalized
}

func commandEntry(x session.CommandInfo) wscontract.CommandEntry {
	out := wscontract.CommandEntry{Name: x.Name}
	if x.Description != "" {
		out.Description = &x.Description
	}
	if x.Source != "" {
		out.Source = &x.Source
	}
	if x.Syntax != "" {
		out.Syntax = &x.Syntax
	}
	if x.SourceInfo != nil {
		si := x.SourceInfo
		out.SourceInfo = &wscontract.CommandSourceInfo{}
		if si.Path != "" {
			out.SourceInfo.Path = &si.Path
		}
		if si.BaseDir != "" {
			out.SourceInfo.BaseDir = &si.BaseDir
		}
		if si.Source != "" {
			out.SourceInfo.Source = &si.Source
		}
		if si.Scope != "" {
			out.SourceInfo.Scope = &si.Scope
		}
		if si.Origin != "" {
			out.SourceInfo.Origin = &si.Origin
		}
	}
	return out
}
func deref(x *string) string {
	if x == nil {
		return ""
	}
	return *x
}
func clientSessionID(f wscontract.ClientFrame) string {
	switch x := f.(type) {
	case *wscontract.ChatSendFrame:
		return x.SessionID
	case *wscontract.ChatAbortFrame:
		return x.SessionID
	case *wscontract.ChatSetFrame:
		return x.SessionID
	case *wscontract.ApprovalRespondFrame:
		return x.SessionID
	case *wscontract.ChatCommandsFrame:
		return x.SessionID
	case *wscontract.ChatCompactFrame:
		return x.SessionID
	case *wscontract.ChatModelsFrame:
		return x.SessionID
	case *wscontract.ChatStatsFrame:
		return x.SessionID
	case *wscontract.ActivityRefreshFrame:
		return x.SessionID
	case *wscontract.ChatResumeFrame:
		return x.SessionID
	case *wscontract.ChatCloseFrame:
		return x.SessionID
	case *wscontract.ChatDisconnectFrame:
		return x.SessionID
	}
	return ""
}
func requestID(f wscontract.ClientFrame) string {
	switch x := f.(type) {
	case *wscontract.ChatSendFrame:
		return deref(x.RequestID)
	case *wscontract.ChatSetFrame:
		return deref(x.RequestID)
	case *wscontract.ApprovalRespondFrame:
		return deref(x.RequestID)
	}
	return ""
}

type chatRef struct{ id, cwd string }

func (c chatRef) ChatID() string { return c.id }
func (c chatRef) CWD() string    { return c.cwd }

// CursorStore adapts cursorstore's atomic chat records to session persistence.
type CursorStore cursorstore.Store

func sessionCursor(c cursorstore.Chat) session.Cursor {
	return session.Cursor{SessionFile: c.SessionFile, DurableSessionID: c.DurableSessionID, Name: c.Name, NameSource: c.NameSource, TitleIsPlaceholder: c.TitleIsPlaceholder, InPlace: cursorstore.IsInPlaceSession(c)}
}

func (s *CursorStore) CursorForOpen(ctx context.Context, id string) (session.Cursor, error) {
	c, err := (*cursorstore.Store)(s).MigrateLegacySession(ctx, id)
	if err != nil {
		return session.Cursor{}, err
	}
	// Provider initialization can append extension startup records while opening
	// an existing session. Gate and preserve the source inside the per-chat
	// flight, immediately before open_session can mutate it.
	cur := sessionCursor(c)
	if cursorstore.IsInPlaceSession(c) {
		store := (*cursorstore.Store)(s)
		forced := false
		check := SessionActivityCheck(observeSessionActivity)
		if value, ok := inPlaceAuthorizations.Load(inPlaceAuthorizationKey{store: store, chatID: id}); ok {
			authorization := value.(*inPlaceAuthorization)
			forced = authorization.force.CompareAndSwap(true, false)
			if authorization.check != nil {
				check = authorization.check
			}
		}
		if !forced {
			activity, err := check(ctx, c.SessionFile, takeoverActivityWindow)
			if err != nil {
				return session.Cursor{}, inPlaceSourceError(err)
			}
			if activity.Changed || activity.SizeDelta != 0 || activity.MtimeDeltaNano != 0 {
				return session.Cursor{}, &SessionActiveError{SizeDelta: activity.SizeDelta, MtimeDeltaNano: activity.MtimeDeltaNano}
			}
		}
		if err := s.PrepareWrite(ctx, id); err != nil {
			return session.Cursor{}, inPlaceSourceError(err)
		}
		cur.WritePrepared = true
	}
	return cur, nil
}

func inPlaceSourceError(err error) error {
	if !errors.Is(err, os.ErrNotExist) && !errors.Is(err, os.ErrPermission) {
		return err
	}
	reason := "session file identity unavailable"
	if errors.Is(err, os.ErrNotExist) {
		reason = "session file disappeared"
	}
	return errors.Join(&session.ExternalWriteError{Reason: reason}, err)
}

func (s *CursorStore) CursorFor(_ context.Context, id string) (session.Cursor, error) {
	c, err := (*cursorstore.Store)(s).GetChat(id)
	if err != nil {
		return session.Cursor{}, err
	}
	return sessionCursor(c), nil
}
func (s *CursorStore) SaveCursor(_ context.Context, id string, cur session.Cursor) error {
	st := (*cursorstore.Store)(s)
	c, err := st.GetChat(id)
	if err != nil {
		return err
	}
	c.SessionFile, c.DurableSessionID = cur.SessionFile, cur.DurableSessionID
	c.Name, c.NameSource = cur.Name, cur.NameSource
	c.TitleIsPlaceholder = cur.TitleIsPlaceholder
	return st.SaveChat(c)
}
func (s *CursorStore) UpdateIdentity(_ context.Context, id, sessionFile, durableID string) error {
	return (*cursorstore.Store)(s).UpdateIdentity(id, sessionFile, durableID)
}
func (s *CursorStore) PrepareWrite(ctx context.Context, id string) error {
	store := (*cursorstore.Store)(s)
	chat, err := store.GetChat(id)
	if err != nil || !cursorstore.IsInPlaceSession(chat) {
		return err
	}
	_, err = adoptcopy.TakeoverSnapshot(ctx, chat.SessionFile, filepath.Join(store.StateDir(), "takeover-backups"), chat.DurableSessionID)
	return err
}

func observeSessionActivity(ctx context.Context, path string, window time.Duration) (SessionActivity, error) {
	before, err := os.Lstat(path)
	if err != nil {
		return SessionActivity{}, &adoptcopy.Error{Kind: adoptcopy.KindIO, Op: "stat activity source", Path: path, Err: errors.Join(adoptcopy.ErrIO, err)}
	}
	timer := time.NewTimer(window)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return SessionActivity{}, ctx.Err()
	case <-timer.C:
	}
	after, err := os.Lstat(path)
	if err != nil {
		return SessionActivity{}, &adoptcopy.Error{Kind: adoptcopy.KindIO, Op: "restat activity source", Path: path, Err: errors.Join(adoptcopy.ErrIO, err)}
	}
	return SessionActivity{SizeDelta: after.Size() - before.Size(), MtimeDeltaNano: after.ModTime().Sub(before.ModTime()).Nanoseconds(), Changed: !os.SameFile(before, after)}, nil
}

func (s *CursorStore) UpdateName(_ context.Context, id, name, source string) error {
	return (*cursorstore.Store)(s).UpdateName(id, name, source)
}

var _ session.CursorStore = (*CursorStore)(nil)
var _ http.Handler = (*Handler)(nil)
